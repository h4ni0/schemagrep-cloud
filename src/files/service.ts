import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { extname, join } from "node:path";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ServiceConfig } from "../config";
import { SchemagrepRunner, type SchemagrepProcessor } from "../schemagrep/runner";
import { FILE_ID_PATTERN } from "./id";
import type { QueryField, StructuredQueryRequest, StructuredQueryResponse } from "../query/contract";
import {
  buildSchemagrepQueryArgs,
  formatStructuredQueryResponse,
} from "../query/execution";
import {
  EmptyUploadError,
  InvalidFilenameError,
  InvalidQueryError,
  TenantStorageQuotaError,
  UnsupportedFileTypeError,
  UploadTooLargeError,
} from "./errors";
import type {
  FileService,
  PublicFileRecord,
  StoredFileRecord,
  TenantFileUsage,
  SupportedCodec,
  UploadSource,
} from "./types";

const CODECS_BY_EXTENSION: Readonly<Record<string, SupportedCodec>> = {
  ".csv": "csv",
  ".json": "json",
  ".jsonl": "jsonl",
  ".log": "log",
  ".ndjson": "jsonl",
  ".txt": "log",
};

function validateQueryCoordinate(field: QueryField, codec: SupportedCodec): void {
  const supported =
    (codec === "csv" && "col" in field) ||
    (codec === "log" && "slot" in field) ||
    ((codec === "json" || codec === "jsonl") && !("col" in field));
  if (!supported) {
    throw new InvalidQueryError(`Field coordinate is not supported for ${codec} files`);
  }
}

function validateQueryForCodec(
  request: StructuredQueryRequest,
  codec: SupportedCodec,
): void {
  if (codec === "csv" && request.template !== undefined) {
    throw new InvalidQueryError("template is not supported for csv files");
  }
  if (request.target !== null) validateQueryCoordinate(request.target, codec);
  for (const filter of request.filters) validateQueryCoordinate(filter.field, codec);
}

function validateUploadFilename(filename: string): string {
  const containsUnsafeCharacter = /[\u0000-\u001f\u007f/\\]/u.test(filename);
  if (
    filename.length === 0 ||
    Buffer.byteLength(filename, "utf8") > 255 ||
    filename === "." ||
    filename === ".." ||
    containsUnsafeCharacter
  ) {
    throw new InvalidFilenameError();
  }
  return filename;
}

class UploadLimitTransform extends Transform {
  bytesWritten = 0;

  constructor(private readonly limit: number) {
    super();
  }

  override _transform(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.bytesWritten += buffer.byteLength;

    if (this.bytesWritten > this.limit) {
      callback(new UploadTooLargeError());
      return;
    }

    callback(null, buffer);
  }
}

export interface PersistentFileServiceOptions {
  storageBaseDirectory: string;
  fileTtlMs: number;
  maxUploadBytes: number;
  maxTenantStorageBytes: number;
  runner: SchemagrepProcessor;
  now?: () => number;
}

interface FileManifest {
  version: 1;
  ownerId: string;
  retainedBytes: number;
  id: string;
  status: "ready";
  codec: SupportedCodec;
  originalName: string;
  sourceBytes: number;
  schemaBytes: number;
  createdAt: string;
  expiresAt: string;
}

const MANIFEST_NAME = "metadata.json";
const MANIFEST_MAX_BYTES = 64 * 1024;
const OWNER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const SUPPORTED_CODECS = new Set<SupportedCodec>(["csv", "json", "jsonl", "log"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true });
  }
}

function toManifest(record: StoredFileRecord): FileManifest {
  return {
    version: 1,
    ownerId: record.ownerId,
    retainedBytes: record.retainedBytes,
    id: record.id,
    status: record.status,
    codec: record.codec,
    originalName: record.originalName,
    sourceBytes: record.sourceBytes,
    schemaBytes: record.schemaBytes,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

export class PersistentFileService implements FileService {
  private readonly files = new Map<string, StoredFileRecord>();
  private readonly tenantStorageBytes = new Map<string, number>();
  private readonly filesDirectory: string;
  private readonly now: () => number;
  private readonly sweepTimer: NodeJS.Timeout;
  private initialization: Promise<void> | undefined;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: PersistentFileServiceOptions) {
    this.filesDirectory = join(options.storageBaseDirectory, "files");
    this.now = options.now ?? Date.now;
    this.sweepTimer = setInterval(
      () => void this.deleteExpired(),
      Math.min(options.fileTtlMs, 60_000),
    );
    this.sweepTimer.unref();
  }

  async ingest(source: UploadSource, ownerId: string): Promise<PublicFileRecord> {
    const safeName = validateUploadFilename(source.filename);
    const extension = extname(safeName).toLowerCase();
    const codec = CODECS_BY_EXTENSION[extension];
    if (codec === undefined) throw new UnsupportedFileTypeError(safeName);
    if (!OWNER_ID_PATTERN.test(ownerId)) throw new InvalidFilenameError();

    await this.ensureInitialized();
    const id = `file_${randomUUID().replaceAll("-", "")}`;
    const directory = join(this.filesDirectory, id);
    const sourcePath = join(directory, `source${extension}`);
    const artifactPath = join(directory, "artifact.sg");
    const schemaPath = join(directory, "schema.txt");
    await mkdir(directory, { mode: 0o700 });

    try {
      const limiter = new UploadLimitTransform(this.options.maxUploadBytes);
      await pipeline(
        source.stream,
        limiter,
        createWriteStream(sourcePath, { flags: "wx", mode: 0o600 }),
      );
      if (source.wasTruncated()) throw new UploadTooLargeError();
      if (limiter.bytesWritten === 0) throw new EmptyUploadError();

      const artifactBytes = await this.options.runner.encode(sourcePath, artifactPath);
      await rm(sourcePath, { force: true });
      const schemaBytes = await this.options.runner.schema(artifactPath, schemaPath);
      const retainedBytes = artifactBytes + schemaBytes;
      const createdAtMs = this.now();
      const record: StoredFileRecord = {
        ownerId,
        retainedBytes,
        id,
        status: "ready",
        codec,
        originalName: safeName,
        sourceBytes: limiter.bytesWritten,
        schemaBytes,
        createdAt: new Date(createdAtMs).toISOString(),
        expiresAt: new Date(createdAtMs + this.options.fileTtlMs).toISOString(),
        directory,
        artifactPath,
        schemaPath,
      };

      await this.mutate(async () => {
        const tenantUsage = this.tenantStorageBytes.get(ownerId) ?? 0;
        if (tenantUsage + retainedBytes > this.options.maxTenantStorageBytes) {
          throw new TenantStorageQuotaError();
        }
        await writeAtomic(join(directory, MANIFEST_NAME), `${JSON.stringify(toManifest(record))}\n`);
        this.tenantStorageBytes.set(ownerId, tenantUsage + retainedBytes);
        this.files.set(id, record);
      });
      return this.toPublicRecord(record);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async list(ownerId: string): Promise<PublicFileRecord[]> {
    await this.ensureInitialized();
    await this.deleteExpired();
    return [...this.files.values()]
      .filter((record) => record.ownerId === ownerId)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .map((record) => this.toPublicRecord(record));
  }

  async usage(ownerId: string): Promise<TenantFileUsage> {
    await this.ensureInitialized();
    await this.deleteExpired();
    let activeFiles = 0;
    let sourceBytes = 0;
    for (const record of this.files.values()) {
      if (record.ownerId !== ownerId) continue;
      activeFiles += 1;
      sourceBytes += record.sourceBytes;
    }
    return {
      activeFiles,
      sourceBytes,
      retainedBytes: this.tenantStorageBytes.get(ownerId) ?? 0,
      maxRetainedBytes: this.options.maxTenantStorageBytes,
    };
  }

  async get(id: string, ownerId: string): Promise<PublicFileRecord | undefined> {
    await this.ensureInitialized();
    await this.expireIfNeeded(id);
    const record = this.files.get(id);
    return record === undefined || record.ownerId !== ownerId
      ? undefined
      : this.toPublicRecord(record);
  }

  async readSchema(id: string, ownerId: string): Promise<string | undefined> {
    await this.ensureInitialized();
    await this.expireIfNeeded(id);
    const record = this.files.get(id);
    if (record === undefined || record.ownerId !== ownerId) return undefined;
    return readFile(record.schemaPath, "utf8");
  }

  async query(
    id: string,
    ownerId: string,
    request: StructuredQueryRequest,
  ): Promise<StructuredQueryResponse | undefined> {
    await this.ensureInitialized();
    await this.expireIfNeeded(id);
    const record = this.files.get(id);
    if (record === undefined || record.ownerId !== ownerId) return undefined;
    validateQueryForCodec(request, record.codec);

    const grepLimit = request.mode === "grep" ? (request.limit ?? 20) + 1 : undefined;
    const output = await this.options.runner.query(
      record.artifactPath,
      buildSchemagrepQueryArgs(request, grepLimit),
    );
    return formatStructuredQueryResponse(request, output);
  }

  async delete(id: string, ownerId: string): Promise<boolean> {
    await this.ensureInitialized();
    const record = this.files.get(id);
    if (record === undefined || record.ownerId !== ownerId) return false;
    await this.remove(record);
    return true;
  }

  async close(): Promise<void> {
    clearInterval(this.sweepTimer);
    if (this.initialization !== undefined) await this.initialization.catch(() => undefined);
    await this.mutationQueue;
    this.tenantStorageBytes.clear();
    this.files.clear();
  }

  private async ensureInitialized(): Promise<void> {
    this.initialization ??= this.initializeStorage();
    await this.initialization;
  }

  private async initializeStorage(): Promise<void> {
    await mkdir(this.options.storageBaseDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.filesDirectory, { recursive: true, mode: 0o700 });
    await this.migrateLegacyInstances();
    const entries = await readdir(this.filesDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const directory = join(this.filesDirectory, entry.name);
      if (!entry.isDirectory() || !FILE_ID_PATTERN.test(entry.name)) {
        await rm(directory, { recursive: true, force: true });
        continue;
      }
      const record = await this.loadRecord(entry.name, directory);
      if (record === undefined || Date.parse(record.expiresAt) <= this.now()) {
        await rm(directory, { recursive: true, force: true });
        continue;
      }
      this.files.set(record.id, record);
      this.tenantStorageBytes.set(
        record.ownerId,
        (this.tenantStorageBytes.get(record.ownerId) ?? 0) + record.retainedBytes,
      );
    }
  }

  private async migrateLegacyInstances(): Promise<void> {
    const entries = await readdir(this.options.storageBaseDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("instance-")) continue;
      const instanceDirectory = join(this.options.storageBaseDirectory, entry.name);
      const children = await readdir(instanceDirectory, { withFileTypes: true });
      for (const child of children) {
        if (!child.isDirectory() || !FILE_ID_PATTERN.test(child.name)) continue;
        const source = join(instanceDirectory, child.name);
        const destination = join(this.filesDirectory, child.name);
        try {
          await rename(source, destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          await rm(source, { recursive: true, force: true });
        }
      }
      await rm(instanceDirectory, { recursive: true, force: true });
    }
  }

  private async loadRecord(id: string, directory: string): Promise<StoredFileRecord | undefined> {
    try {
      const manifestPath = join(directory, MANIFEST_NAME);
      const manifestStat = await lstat(manifestPath);
      if (!manifestStat.isFile() || manifestStat.size > MANIFEST_MAX_BYTES) return undefined;
      const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
      if (!isObject(parsed)) return undefined;
      const artifactPath = join(directory, "artifact.sg");
      const schemaPath = join(directory, "schema.txt");
      const [artifactStat, schemaStat] = await Promise.all([lstat(artifactPath), lstat(schemaPath)]);
      const createdAtMs = typeof parsed.createdAt === "string" ? Date.parse(parsed.createdAt) : NaN;
      const expiresAtMs = typeof parsed.expiresAt === "string" ? Date.parse(parsed.expiresAt) : NaN;
      if (
        parsed.version !== 1 ||
        parsed.id !== id ||
        parsed.status !== "ready" ||
        typeof parsed.ownerId !== "string" ||
        !OWNER_ID_PATTERN.test(parsed.ownerId) ||
        typeof parsed.codec !== "string" ||
        !SUPPORTED_CODECS.has(parsed.codec as SupportedCodec) ||
        typeof parsed.originalName !== "string" ||
        validateUploadFilename(parsed.originalName) !== parsed.originalName ||
        !Number.isSafeInteger(parsed.sourceBytes) ||
        (parsed.sourceBytes as number) <= 0 ||
        !Number.isSafeInteger(parsed.schemaBytes) ||
        parsed.schemaBytes !== schemaStat.size ||
        !Number.isSafeInteger(parsed.retainedBytes) ||
        parsed.retainedBytes !== artifactStat.size + schemaStat.size ||
        !artifactStat.isFile() ||
        !schemaStat.isFile() ||
        !Number.isFinite(createdAtMs) ||
        !Number.isFinite(expiresAtMs) ||
        expiresAtMs <= createdAtMs
      ) {
        return undefined;
      }
      return {
        ownerId: parsed.ownerId,
        retainedBytes: parsed.retainedBytes as number,
        id,
        status: "ready",
        codec: parsed.codec as SupportedCodec,
        originalName: parsed.originalName,
        sourceBytes: parsed.sourceBytes as number,
        schemaBytes: parsed.schemaBytes as number,
        createdAt: new Date(createdAtMs).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        directory,
        artifactPath,
        schemaPath,
      };
    } catch {
      return undefined;
    }
  }

  private async expireIfNeeded(id: string): Promise<void> {
    const record = this.files.get(id);
    if (record !== undefined && Date.parse(record.expiresAt) <= this.now()) {
      await this.remove(record);
    }
  }

  private async deleteExpired(): Promise<void> {
    await this.ensureInitialized();
    const now = this.now();
    const expired = [...this.files.values()].filter((record) => Date.parse(record.expiresAt) <= now);
    await Promise.all(expired.map((record) => this.remove(record)));
  }

  private async remove(record: StoredFileRecord): Promise<void> {
    await this.mutate(async () => {
      if (this.files.get(record.id) !== record) return;
      this.files.delete(record.id);
      const tenantUsage = this.tenantStorageBytes.get(record.ownerId) ?? 0;
      const remainingUsage = tenantUsage - record.retainedBytes;
      if (remainingUsage > 0) this.tenantStorageBytes.set(record.ownerId, remainingUsage);
      else this.tenantStorageBytes.delete(record.ownerId);
      await rm(record.directory, { recursive: true, force: true });
    });
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private toPublicRecord(record: StoredFileRecord): PublicFileRecord {
    return {
      id: record.id,
      status: record.status,
      codec: record.codec,
      originalName: record.originalName,
      sourceBytes: record.sourceBytes,
      schemaBytes: record.schemaBytes,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    };
  }
}

export function createFileService(config: ServiceConfig): PersistentFileService {
  const runner = new SchemagrepRunner({
    binaryPath: config.schemagrepBinary,
    timeoutMs: config.processTimeoutMs,
    maxArtifactBytes: config.maxArtifactBytes,
    maxSchemaBytes: config.maxSchemaBytes,
    maxQueryOutputBytes: config.maxQueryOutputBytes,
    sandbox:
      config.workerSandbox === "bwrap"
        ? { mode: "bwrap", bubblewrapBinary: config.bubblewrapBinary }
        : { mode: "disabled" },
  });

  return new PersistentFileService({
    storageBaseDirectory: config.storageBaseDirectory,
    fileTtlMs: config.fileTtlMs,
    maxUploadBytes: config.maxUploadBytes,
    maxTenantStorageBytes: config.maxTenantStorageBytes,
    runner,
  });
}
