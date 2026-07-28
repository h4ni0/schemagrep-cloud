import { afterEach, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import type { ServiceConfig } from "../src/config";
import { UploadTooLargeError } from "../src/files/errors";
import type { FileService, PublicFileRecord, UploadSource } from "../src/files/types";

const RECORD: PublicFileRecord = {
  id: "file_test",
  status: "ready",
  codec: "jsonl",
  originalName: "events.jsonl",
  sourceBytes: 8,
  schemaBytes: 9,
  createdAt: "2026-07-29T00:00:00.000Z",
  expiresAt: "2026-07-29T01:00:00.000Z",
};

const CONFIG: ServiceConfig = {
  host: "127.0.0.1",
  port: 3000,
  schemagrepBinary: "schemagrep",
  storageBaseDirectory: "/tmp/schemagrep-cloud-tests",
  fileTtlMs: 3_600_000,
  processTimeoutMs: 30_000,
  maxUploadBytes: 1024,
  maxArtifactBytes: 4096,
  maxSchemaBytes: 4096,
};

class FakeFileService implements FileService {
  uploaded: Buffer | undefined;
  deleted = false;
  closed = false;

  async ingest(source: UploadSource): Promise<PublicFileRecord> {
    const chunks: Buffer[] = [];
    for await (const chunk of source.stream) chunks.push(Buffer.from(chunk));
    if (source.wasTruncated()) throw new UploadTooLargeError();
    this.uploaded = Buffer.concat(chunks);
    return { ...RECORD, originalName: source.filename, sourceBytes: this.uploaded.byteLength };
  }

  async get(id: string): Promise<PublicFileRecord | undefined> {
    return id === RECORD.id && !this.deleted ? RECORD : undefined;
  }

  async readSchema(id: string): Promise<string | undefined> {
    return id === RECORD.id && !this.deleted ? "[schema]\n" : undefined;
  }

  async delete(id: string): Promise<boolean> {
    if (id !== RECORD.id || this.deleted) return false;
    this.deleted = true;
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function multipartPayload(filename: string, content: string): { boundary: string; payload: Buffer } {
  const boundary = "schemagrep-test-boundary";
  const payload = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n" +
      content +
      `\r\n--${boundary}--\r\n`,
  );
  return { boundary, payload };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("ephemeral file routes", () => {
  test("uploads a multipart file without retaining it in the route", async () => {
    const fileService = new FakeFileService();
    app = buildApp({ config: CONFIG, fileService });
    const upload = multipartPayload("events.jsonl", '{"id":1}\n');

    const response = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { "content-type": `multipart/form-data; boundary=${upload.boundary}` },
      payload: upload.payload,
    });

    expect(response.statusCode).toBe(201);
    expect(fileService.uploaded?.toString("utf8")).toBe('{"id":1}\n');
    expect(JSON.parse(response.body)).toMatchObject({
      id: "file_test",
      status: "ready",
      originalName: "events.jsonl",
      sourceBytes: 9,
    });
  });

  test("rejects an upload beyond the configured byte limit", async () => {
    const fileService = new FakeFileService();
    app = buildApp({ config: { ...CONFIG, maxUploadBytes: 3 }, fileService });
    const upload = multipartPayload("events.jsonl", "1234");

    const response = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { "content-type": `multipart/form-data; boundary=${upload.boundary}` },
      payload: upload.payload,
    });

    expect(response.statusCode).toBe(413);
    expect(JSON.parse(response.body)).toEqual({
      error: { code: "upload_too_large", message: "Upload exceeds the configured size limit" },
    });
  });

  test("serves metadata and schema, then deletes the file", async () => {
    const fileService = new FakeFileService();
    app = buildApp({ config: CONFIG, fileService });

    const metadata = await app.inject({ method: "GET", url: "/v1/files/file_test" });
    const schema = await app.inject({ method: "GET", url: "/v1/files/file_test/schema" });
    const deleted = await app.inject({ method: "DELETE", url: "/v1/files/file_test" });
    const missing = await app.inject({ method: "GET", url: "/v1/files/file_test" });

    expect(metadata.statusCode).toBe(200);
    expect(schema.statusCode).toBe(200);
    expect(schema.headers["content-type"]).toStartWith("text/plain");
    expect(schema.body).toBe("[schema]\n");
    expect(deleted.statusCode).toBe(204);
    expect(missing.statusCode).toBe(404);
  });
});
