import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  EmptyUploadError,
  InvalidFilenameError,
  TenantStorageQuotaError,
  UnsupportedFileTypeError,
} from "../src/files/errors";
import { EphemeralFileService } from "../src/files/service";
import type { SchemagrepProcessor } from "../src/schemagrep/runner";
import type { StructuredQueryRequest } from "../src/query/contract";

class FakeProcessor implements SchemagrepProcessor {
  encodeCalls = 0;
  schemaCalls = 0;
  lastQueryArgs: readonly string[] | undefined;
  schemaInput: string | undefined;
  async encode(sourcePath: string, outputPath: string): Promise<number> {
    this.encodeCalls += 1;
    const source = await readFile(sourcePath);
    const artifact = Buffer.concat([Buffer.from("encoded:"), source]);
    await writeFile(outputPath, artifact, { flag: "wx", mode: 0o600 });
    return artifact.byteLength;
  }

  async schema(artifactPath: string, outputPath: string): Promise<number> {
    this.schemaCalls += 1;
    this.schemaInput = await readFile(artifactPath, "utf8");
    const schema = "[schema]\n";
    await writeFile(outputPath, schema, { flag: "wx", mode: 0o600 });
    return Buffer.byteLength(schema);
  }

  async query(_artifactPath: string, args: readonly string[]): Promise<string> {
    this.lastQueryArgs = args;
    return "5\n";
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const OWNER_ID = "tenant-a";

describe("EphemeralFileService", () => {
  test("retains only encoded and schema artifacts, then expires both", async () => {
    const storageBaseDirectory = await mkdtemp(join(tmpdir(), "schemagrep-service-test-"));
    temporaryDirectories.push(storageBaseDirectory);
    const abandonedDirectory = join(storageBaseDirectory, "instance-abandoned");
    await mkdir(abandonedDirectory);
    await writeFile(join(abandonedDirectory, "raw-upload.jsonl"), "must be deleted");
    let now = Date.parse("2026-07-29T00:00:00.000Z");
    const runner = new FakeProcessor();
    const service = new EphemeralFileService({
      storageBaseDirectory,
      fileTtlMs: 1000,
      maxUploadBytes: 1024,
      maxTenantStorageBytes: 4096,
      runner,
      now: () => now,
    });

    const record = await service.ingest(
      {
        filename: "events.jsonl",
        stream: Readable.from(['{"id":1}\n']),
        wasTruncated: () => false,
      },
      OWNER_ID,
    );

    expect(record.originalName).toBe("events.jsonl");
    expect(record.sourceBytes).toBe(9);
    expect(record.schemaBytes).toBe(9);
    expect(await service.readSchema(record.id, OWNER_ID)).toBe("[schema]\n");
    expect(runner.schemaInput).toBe('encoded:{"id":1}\n');
    const query: StructuredQueryRequest = {
      mode: "count",
      target: { key: "id" },
      filters: [],
      value: "1",
    };
    expect(await service.query(record.id, OWNER_ID, query)).toEqual({
      query,
      answer: "5",
      outputBytes: 1,
    });
    expect(runner.lastQueryArgs).toEqual(["--count", "1", "--key", "id"]);
    expect(await service.query(record.id, "tenant-b", query)).toBeUndefined();
    expect(await service.get(record.id, "tenant-b")).toBeUndefined();
    expect(await service.readSchema(record.id, "tenant-b")).toBeUndefined();
    expect(await service.delete(record.id, "tenant-b")).toBe(false);
    expect(await service.get(record.id, OWNER_ID)).toEqual(record);

    const instanceNames = await readdir(storageBaseDirectory);
    expect(instanceNames).toHaveLength(1);
    const [instanceName] = instanceNames;
    if (instanceName === undefined) throw new Error("Expected an instance directory");
    const [fileName] = await readdir(join(storageBaseDirectory, instanceName));
    if (fileName === undefined) throw new Error("Expected an uploaded file directory");
    expect(fileName).toBe(record.id);
    const retainedArtifacts = (await readdir(join(storageBaseDirectory, instanceName, fileName))).sort();
    expect(retainedArtifacts).toEqual(["artifact.sg", "schema.txt"]);

    now += 1001;
    expect(await service.get(record.id, OWNER_ID)).toBeUndefined();
    expect(await readdir(join(storageBaseDirectory, instanceName))).toEqual([]);
    await service.close();
  });

  test("rejects path-like and control-character filenames", async () => {
    const storageBaseDirectory = await mkdtemp(join(tmpdir(), "schemagrep-service-test-"));
    temporaryDirectories.push(storageBaseDirectory);
    const service = new EphemeralFileService({
      storageBaseDirectory,
      fileTtlMs: 1000,
      maxUploadBytes: 1024,
      maxTenantStorageBytes: 4096,
      runner: new FakeProcessor(),
    });

    for (const filename of ["../../events.jsonl", "..\\..\\events.jsonl", "\0events.jsonl"]) {
      await expect(
        service.ingest(
          {
            filename,
            stream: Readable.from(['{"id":1}\n']),
            wasTruncated: () => false,
          },
          OWNER_ID,
        ),
      ).rejects.toBeInstanceOf(InvalidFilenameError);
    }

    expect(await readdir(storageBaseDirectory)).toEqual([]);
    await service.close();
  });

  test("rejects an empty file before invoking schemagrep", async () => {
    const storageBaseDirectory = await mkdtemp(join(tmpdir(), "schemagrep-service-test-"));
    temporaryDirectories.push(storageBaseDirectory);
    const runner = new FakeProcessor();
    const service = new EphemeralFileService({
      storageBaseDirectory,
      fileTtlMs: 1000,
      maxUploadBytes: 1024,
      maxTenantStorageBytes: 4096,
      runner,
    });

    await expect(
      service.ingest(
        {
          filename: "empty.jsonl",
          stream: Readable.from([]),
          wasTruncated: () => false,
        },
        OWNER_ID,
      ),
    ).rejects.toBeInstanceOf(EmptyUploadError);

    expect(runner.encodeCalls).toBe(0);
    expect(runner.schemaCalls).toBe(0);
    await service.close();
  });

  test("tracks retained-byte quotas independently per tenant and releases usage on delete", async () => {
    const storageBaseDirectory = await mkdtemp(join(tmpdir(), "schemagrep-service-test-"));
    temporaryDirectories.push(storageBaseDirectory);
    const service = new EphemeralFileService({
      storageBaseDirectory,
      fileTtlMs: 1000,
      maxUploadBytes: 1024,
      maxTenantStorageBytes: 30,
      runner: new FakeProcessor(),
    });
    const ingest = (ownerId: string) =>
      service.ingest(
        {
          filename: "events.jsonl",
          stream: Readable.from(['{"id":1}\n']),
          wasTruncated: () => false,
        },
        ownerId,
      );

    const firstAlpha = await ingest("alpha");
    await expect(ingest("alpha")).rejects.toBeInstanceOf(TenantStorageQuotaError);
    const firstBeta = await ingest("beta");
    expect(await service.delete(firstAlpha.id, "alpha")).toBe(true);
    const secondAlpha = await ingest("alpha");

    expect(await service.get(firstBeta.id, "beta")).toBeDefined();
    expect(await service.get(secondAlpha.id, "alpha")).toBeDefined();
    await service.close();
  });

  test("rejects unsupported extensions before creating storage", async () => {
    const storageBaseDirectory = await mkdtemp(join(tmpdir(), "schemagrep-service-test-"));
    temporaryDirectories.push(storageBaseDirectory);
    const service = new EphemeralFileService({
      storageBaseDirectory,
      fileTtlMs: 1000,
      maxUploadBytes: 1024,
      maxTenantStorageBytes: 4096,
      runner: new FakeProcessor(),
    });

    const ingest = service.ingest(
      {
        filename: "archive.zip",
        stream: Readable.from(["not a supported file"]),
        wasTruncated: () => false,
      },
      OWNER_ID,
    );

    await expect(ingest).rejects.toBeInstanceOf(UnsupportedFileTypeError);
    expect(await readdir(storageBaseDirectory)).toEqual([]);
    await service.close();
  });
});
