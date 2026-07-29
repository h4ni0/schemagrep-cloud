import { afterEach, describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import type { ServiceConfig } from "../src/config";
import type { FileService, PublicFileRecord, UploadSource } from "../src/files/types";
import type { StructuredQueryRequest, StructuredQueryResponse } from "../src/query/contract";

const FILE_ID = "file_0123456789abcdef0123456789abcdef";
const ALPHA_KEY = "alpha-secret-0123456789abcdef0123456789";
const BETA_KEY = "beta-secret-0123456789abcdef01234567890";
const RECORD: PublicFileRecord = {
  id: FILE_ID,
  status: "ready",
  codec: "jsonl",
  originalName: "events.jsonl",
  sourceBytes: 9,
  schemaBytes: 9,
  createdAt: "2026-07-29T00:00:00.000Z",
  expiresAt: "2026-07-29T01:00:00.000Z",
};
const CONFIG: ServiceConfig = {
  host: "127.0.0.1",
  port: 3000,
  schemagrepBinary: "schemagrep",
  storageBaseDirectory: "/tmp/schemagrep-cloud-mcp-tests",
  fileTtlMs: 3_600_000,
  processTimeoutMs: 30_000,
  maxUploadBytes: 1024,
  maxArtifactBytes: 4096,
  maxSchemaBytes: 4096,
  maxQueryOutputBytes: 4096,
  authDisabled: false,
  apiCredentials: [
    { tenantId: "alpha", secret: ALPHA_KEY },
    { tenantId: "beta", secret: BETA_KEY },
  ],
  rateLimitMax: 100,
  rateLimitWindowMs: 60_000,
  maxTenantStorageBytes: 4096,
  workerSandbox: "disabled",
  bubblewrapBinary: "/usr/bin/bwrap",
  mcpAllowedHostnames: ["localhost", "127.0.0.1"],
};

class McpFileService implements FileService {
  async ingest(_source: UploadSource, _ownerId: string): Promise<PublicFileRecord> {
    return RECORD;
  }

  async get(id: string, ownerId: string): Promise<PublicFileRecord | undefined> {
    return id === FILE_ID && ownerId === "alpha" ? RECORD : undefined;
  }

  async readSchema(id: string, ownerId: string): Promise<string | undefined> {
    return id === FILE_ID && ownerId === "alpha" ? "[schema]\n" : undefined;
  }

  async query(
    id: string,
    ownerId: string,
    query: StructuredQueryRequest,
  ): Promise<StructuredQueryResponse | undefined> {
    return id === FILE_ID && ownerId === "alpha"
      ? { query, answer: "5", outputBytes: 1 }
      : undefined;
  }

  async delete(_id: string, _ownerId: string): Promise<boolean> {
    return false;
  }

  async close(): Promise<void> {}
}

let app: FastifyInstance | undefined;
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await app?.close();
  app = undefined;
});

async function connectClient(endpoint: URL, token: string, name: string): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    authProvider: { token: async () => token },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

describe("schemagrep MCP endpoint", () => {
  test("authenticates a real Streamable HTTP client and isolates every tool by tenant", async () => {
    app = buildApp({ config: CONFIG, fileService: new McpFileService() });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const endpoint = new URL("/mcp", address);

    const unauthenticated = new Client({ name: "unauthenticated", version: "1.0.0" });
    await expect(
      unauthenticated.connect(new StreamableHTTPClientTransport(endpoint)),
    ).rejects.toThrow();

    const alpha = await connectClient(endpoint, ALPHA_KEY, "alpha-client");
    const tools = await alpha.listTools();
    const schema = await alpha.callTool({
      name: "schemagrep_get_schema",
      arguments: { fileId: FILE_ID },
    });
    const count = await alpha.callTool({
      name: "schemagrep_query",
      arguments: {
        fileId: FILE_ID,
        mode: "count",
        target: { key: "type" },
        filters: [],
        value: "push",
      },
    });

    const beta = await connectClient(endpoint, BETA_KEY, "beta-client");
    const hidden = await beta.callTool({
      name: "schemagrep_get_schema",
      arguments: { fileId: FILE_ID },
    });

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "schemagrep_get_schema",
      "schemagrep_query",
    ]);
    expect(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(schema.structuredContent).toEqual({ fileId: FILE_ID, schema: "[schema]\n" });
    expect(count.structuredContent).toEqual({
      fileId: FILE_ID,
      result: {
        query: {
          mode: "count",
          target: { key: "type" },
          filters: [],
          value: "push",
        },
        answer: "5",
        outputBytes: 1,
      },
    });
    expect(hidden.isError).toBe(true);
  });

  test("rejects unapproved Host headers before MCP dispatch", async () => {
    app = buildApp({ config: CONFIG, fileService: new McpFileService() });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    const response = await fetch(new URL("/mcp", address), {
      headers: {
        authorization: `Bearer ${ALPHA_KEY}`,
        host: "evil.example",
      },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { message: "Invalid Host: evil.example" },
    });
  });
});
