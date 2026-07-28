import { afterEach, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { loadConfig, type ServiceConfig } from "../src/config";
import type { FileService, PublicFileRecord, UploadSource } from "../src/files/types";

const ALPHA_KEY = "alpha-secret-0123456789abcdef0123456789";
const BETA_KEY = "beta-secret-0123456789abcdef01234567890";
const FILE_ID = "file_abcdef0123456789abcdef0123456789";

const CONFIG: ServiceConfig = {
  host: "127.0.0.1",
  port: 3000,
  schemagrepBinary: "schemagrep",
  storageBaseDirectory: "/tmp/schemagrep-cloud-access-tests",
  fileTtlMs: 3_600_000,
  processTimeoutMs: 30_000,
  maxUploadBytes: 1024,
  maxArtifactBytes: 4096,
  maxSchemaBytes: 4096,
  authDisabled: false,
  apiCredentials: [
    { tenantId: "alpha", secret: ALPHA_KEY },
    { tenantId: "beta", secret: BETA_KEY },
  ],
  rateLimitMax: 100,
  rateLimitWindowMs: 60_000,
};

interface OwnedRecord {
  ownerId: string;
  record: PublicFileRecord;
}

class TenantFileService implements FileService {
  private readonly files = new Map<string, OwnedRecord>();

  async ingest(source: UploadSource, ownerId: string): Promise<PublicFileRecord> {
    for await (const _chunk of source.stream) {
      // Consume the multipart stream before responding.
    }
    const record: PublicFileRecord = {
      id: FILE_ID,
      status: "ready",
      codec: "jsonl",
      originalName: source.filename,
      sourceBytes: 9,
      schemaBytes: 9,
      createdAt: "2026-07-29T00:00:00.000Z",
      expiresAt: "2026-07-29T01:00:00.000Z",
    };
    this.files.set(record.id, { ownerId, record });
    return record;
  }

  async get(id: string, ownerId: string): Promise<PublicFileRecord | undefined> {
    const owned = this.files.get(id);
    return owned?.ownerId === ownerId ? owned.record : undefined;
  }

  async readSchema(id: string, ownerId: string): Promise<string | undefined> {
    const owned = this.files.get(id);
    return owned?.ownerId === ownerId ? "[schema]\n" : undefined;
  }

  async delete(id: string, ownerId: string): Promise<boolean> {
    const owned = this.files.get(id);
    if (owned?.ownerId !== ownerId) return false;
    this.files.delete(id);
    return true;
  }

  async close(): Promise<void> {
    this.files.clear();
  }
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("API access control", () => {
  test("leaves health public but requires a bearer key for file routes", async () => {
    app = buildApp({ config: CONFIG, fileService: new TenantFileService() });

    const health = await app.inject({ method: "GET", url: "/health" });
    const missing = await app.inject({ method: "GET", url: `/v1/files/${FILE_ID}` });
    const invalid = await app.inject({
      method: "GET",
      url: `/v1/files/${FILE_ID}`,
      headers: { authorization: "Bearer incorrect-key" },
    });
    const lowercaseScheme = await app.inject({
      method: "GET",
      url: `/v1/files/${FILE_ID}`,
      headers: { authorization: `bearer ${ALPHA_KEY}` },
    });

    expect(health.statusCode).toBe(200);
    expect(missing.statusCode).toBe(401);
    expect(missing.headers["www-authenticate"]).toBe("Bearer");
    expect(invalid.statusCode).toBe(401);
    expect(lowercaseScheme.statusCode).toBe(404);
  });

  test("isolates uploaded files by authenticated tenant", async () => {
    app = buildApp({ config: CONFIG, fileService: new TenantFileService() });
    const boundary = "tenant-upload-boundary";
    const payload = Buffer.from(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="file"; filename="events.jsonl"\r\n' +
        "Content-Type: application/octet-stream\r\n\r\n" +
        '{"id":1}\n' +
        `\r\n--${boundary}--\r\n`,
    );

    const uploaded = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: {
        authorization: `Bearer ${ALPHA_KEY}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    const alphaRead = await app.inject({
      method: "GET",
      url: `/v1/files/${FILE_ID}`,
      headers: { authorization: `Bearer ${ALPHA_KEY}` },
    });
    const betaRead = await app.inject({
      method: "GET",
      url: `/v1/files/${FILE_ID}`,
      headers: { authorization: `Bearer ${BETA_KEY}` },
    });
    const betaDelete = await app.inject({
      method: "DELETE",
      url: `/v1/files/${FILE_ID}`,
      headers: { authorization: `Bearer ${BETA_KEY}` },
    });
    const alphaDelete = await app.inject({
      method: "DELETE",
      url: `/v1/files/${FILE_ID}`,
      headers: { authorization: `Bearer ${ALPHA_KEY}` },
    });

    expect(uploaded.statusCode).toBe(201);
    expect(alphaRead.statusCode).toBe(200);
    expect(betaRead.statusCode).toBe(404);
    expect(betaDelete.statusCode).toBe(404);
    expect(alphaDelete.statusCode).toBe(204);
  });

  test("limits each authenticated tenant independently", async () => {
    app = buildApp({
      config: { ...CONFIG, rateLimitMax: 2 },
      fileService: new TenantFileService(),
    });

    const alphaStatuses: number[] = [];
    for (let requestNumber = 0; requestNumber < 3; requestNumber += 1) {
      const response = await app.inject({
        method: "GET",
        url: `/v1/files/${FILE_ID}`,
        headers: { authorization: `Bearer ${ALPHA_KEY}` },
      });
      alphaStatuses.push(response.statusCode);
    }
    const beta = await app.inject({
      method: "GET",
      url: `/v1/files/${FILE_ID}`,
      headers: { authorization: `Bearer ${BETA_KEY}` },
    });

    expect(alphaStatuses).toEqual([404, 404, 429]);
    expect(beta.statusCode).toBe(404);
    expect(beta.headers["ratelimit-remaining"]).toBe("1");
  });
});

describe("API key configuration", () => {
  test("requires credentials unless authentication is explicitly disabled", () => {
    expect(() => loadConfig({})).toThrow("SCHEMAGREP_API_KEYS is required");
    expect(loadConfig({ AUTH_DISABLED: "true" }).authDisabled).toBe(true);
  });

  test("rejects short and duplicated secrets", () => {
    expect(() => loadConfig({ SCHEMAGREP_API_KEYS: '{"alpha":"short"}' })).toThrow(
      "32 to 512 UTF-8 bytes",
    );
    expect(() =>
      loadConfig({
        SCHEMAGREP_API_KEYS:
          '{"alpha":"same-secret-0123456789abcdef012345","beta":"same-secret-0123456789abcdef012345"}',
      }),
    ).toThrow("must use a unique API key");
  });
});
