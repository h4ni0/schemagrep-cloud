import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { extname, join } from "node:path";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ServiceConfig } from "../config";
import { SchemagrepRunner, type SchemagrepProcessor } from "../schemagrep/runner";
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

export interface EphemeralFileServiceOptions {
  storageBaseDirectory: string;
  fileTtlMs: number;
  maxUploadBytes: number;
  maxTenantStorageBytes: number;
  runner: SchemagrepProcessor;
  now?: () => number;
}

export class EphemeralFileService implements FileService {
  private readonly files = new Map<string, StoredFileRecord>();
  private readonly tenantStorageBytes = new Map<string, number>();
  private readonly instanceDirectory: string;
  private readonly now: () => number;
  private readonly sweepTimer: NodeJS.Timeout;
  private initialization: Promise<void> | undefined;

  constructor(private readonly options: EphemeralFileServiceOptions) {
    this.instanceDirectory = join(options.storageBaseDirectory, `instance-${randomUUID()}`);
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

    await this.ensureInitialized();
    const id = `file_${randomUUID().replaceAll("-", "")}`;
    const directory = join(this.instanceDirectory, id);
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
      const schemaBytes = await this.options.runner.schema(sourcePath, schemaPath);
      await rm(sourcePath, { force: true });
      const retainedBytes = artifactBytes + schemaBytes;
      const tenantUsage = this.tenantStorageBytes.get(ownerId) ?? 0;
      if (tenantUsage + retainedBytes > this.options.maxTenantStorageBytes) {
        throw new TenantStorageQuotaError();
      }

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
      this.tenantStorageBytes.set(ownerId, tenantUsage + retainedBytes);
      this.files.set(id, record);
      return this.toPublicRecord(record);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async get(id: string, ownerId: string): Promise<PublicFileRecord | undefined> {
    await this.expireIfNeeded(id);
    const record = this.files.get(id);
    return record === undefined || record.ownerId !== ownerId
      ? undefined
      : this.toPublicRecord(record);
  }

  async readSchema(id: string, ownerId: string): Promise<string | undefined> {
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
    const record = this.files.get(id);
    if (record === undefined || record.ownerId !== ownerId) return false;

    await this.remove(record);
    return true;
  }

  async close(): Promise<void> {
    this.tenantStorageBytes.clear();
    clearInterval(this.sweepTimer);
    this.files.clear();
    if (this.initialization !== undefined) {
      await this.initialization.catch(() => undefined);
      await rm(this.instanceDirectory, { recursive: true, force: true });
    }
  }

  private async ensureInitialized(): Promise<void> {
    this.initialization ??= this.initializeStorage();
    await this.initialization;
  }

  private async initializeStorage(): Promise<void> {
    await mkdir(this.options.storageBaseDirectory, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.options.storageBaseDirectory, { withFileTypes: true });
    const abandonedInstances = entries.filter(
      (entry) => entry.isDirectory() && entry.name.startsWith("instance-"),
    );
    await Promise.all(
      abandonedInstances.map((entry) =>
        rm(join(this.options.storageBaseDirectory, entry.name), { recursive: true, force: true }),
      ),
    );
    await mkdir(this.instanceDirectory, { mode: 0o700 });
  }

  private async expireIfNeeded(id: string): Promise<void> {
    const record = this.files.get(id);
    if (record !== undefined && Date.parse(record.expiresAt) <= this.now()) {
      await this.remove(record);
    }
  }

  private async deleteExpired(): Promise<void> {
    const now = this.now();
    const expired = [...this.files.values()].filter((record) => Date.parse(record.expiresAt) <= now);
    await Promise.all(expired.map((record) => this.remove(record)));
  }

  private async remove(record: StoredFileRecord): Promise<void> {
    this.files.delete(record.id);
    const tenantUsage = this.tenantStorageBytes.get(record.ownerId) ?? 0;
    const remainingUsage = tenantUsage - record.retainedBytes;
    if (remainingUsage > 0) this.tenantStorageBytes.set(record.ownerId, remainingUsage);
    else this.tenantStorageBytes.delete(record.ownerId);
    await rm(record.directory, { recursive: true, force: true });
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

export function createFileService(config: ServiceConfig): EphemeralFileService {
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

  return new EphemeralFileService({
    storageBaseDirectory: config.storageBaseDirectory,
    fileTtlMs: config.fileTtlMs,
    maxUploadBytes: config.maxUploadBytes,
    maxTenantStorageBytes: config.maxTenantStorageBytes,
    runner,
  });
}
