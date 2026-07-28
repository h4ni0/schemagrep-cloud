import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { UnsupportedFileTypeError } from "../src/files/errors";
import { EphemeralFileService } from "../src/files/service";
import type { SchemagrepProcessor } from "../src/schemagrep/runner";

class FakeProcessor implements SchemagrepProcessor {
  async encode(sourcePath: string, outputPath: string): Promise<number> {
    const source = await readFile(sourcePath);
    const artifact = Buffer.concat([Buffer.from("encoded:"), source]);
    await writeFile(outputPath, artifact, { flag: "wx", mode: 0o600 });
    return artifact.byteLength;
  }

  async schema(_sourcePath: string, outputPath: string): Promise<number> {
    const schema = "[schema]\n";
    await writeFile(outputPath, schema, { flag: "wx", mode: 0o600 });
    return Buffer.byteLength(schema);
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("EphemeralFileService", () => {
  test("retains only encoded and schema artifacts, then expires both", async () => {
    const storageBaseDirectory = await mkdtemp(join(tmpdir(), "schemagrep-service-test-"));
    temporaryDirectories.push(storageBaseDirectory);
    const abandonedDirectory = join(storageBaseDirectory, "instance-abandoned");
    await mkdir(abandonedDirectory);
    await writeFile(join(abandonedDirectory, "raw-upload.jsonl"), "must be deleted");
    let now = Date.parse("2026-07-29T00:00:00.000Z");
    const service = new EphemeralFileService({
      storageBaseDirectory,
      fileTtlMs: 1000,
      maxUploadBytes: 1024,
      runner: new FakeProcessor(),
      now: () => now,
    });

    const record = await service.ingest({
      filename: "../../events.jsonl",
      stream: Readable.from(['{"id":1}\n']),
      wasTruncated: () => false,
    });

    expect(record.originalName).toBe("events.jsonl");
    expect(record.sourceBytes).toBe(9);
    expect(record.schemaBytes).toBe(9);
    expect(await service.readSchema(record.id)).toBe("[schema]\n");

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
    expect(await service.get(record.id)).toBeUndefined();
    expect(await readdir(join(storageBaseDirectory, instanceName))).toEqual([]);
    await service.close();
  });

  test("rejects unsupported extensions before creating storage", async () => {
    const storageBaseDirectory = await mkdtemp(join(tmpdir(), "schemagrep-service-test-"));
    temporaryDirectories.push(storageBaseDirectory);
    const service = new EphemeralFileService({
      storageBaseDirectory,
      fileTtlMs: 1000,
      maxUploadBytes: 1024,
      runner: new FakeProcessor(),
    });

    const ingest = service.ingest({
      filename: "archive.zip",
      stream: Readable.from(["not a supported file"]),
      wasTruncated: () => false,
    });

    await expect(ingest).rejects.toBeInstanceOf(UnsupportedFileTypeError);
    expect(await readdir(storageBaseDirectory)).toEqual([]);
    await service.close();
  });
});
