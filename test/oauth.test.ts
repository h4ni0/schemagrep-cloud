import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import type { ServiceConfig } from "../src/config";
import type { FileService, PublicFileRecord, UploadSource } from "../src/files/types";
import type { StructuredQueryRequest, StructuredQueryResponse } from "../src/query/contract";
import { EphemeralOAuthAdapter } from "../src/oauth/provider";

const INVITE_KEY = "oauth-invite-0123456789abcdef0123456789";
const FILE: PublicFileRecord = {
  id: "file_0123456789abcdef0123456789abcdef",
  status: "ready",
  codec: "jsonl",
  originalName: "events.jsonl",
  sourceBytes: 100,
  schemaBytes: 50,
  createdAt: "2026-07-30T00:00:00.000Z",
  expiresAt: "2026-07-30T01:00:00.000Z",
};

class OAuthFileService implements FileService {
  async ingest(_source: UploadSource, _ownerId: string): Promise<PublicFileRecord> { return FILE; }
  async list(ownerId: string): Promise<PublicFileRecord[]> { return ownerId === "oauth-tenant" ? [FILE] : []; }
  async usage(ownerId: string) {
    return {
      activeFiles: ownerId === "oauth-tenant" ? 1 : 0,
      sourceBytes: ownerId === "oauth-tenant" ? 100 : 0,
      retainedBytes: ownerId === "oauth-tenant" ? 150 : 0,
      maxRetainedBytes: 4096,
    };
  }
  async get(id: string, ownerId: string): Promise<PublicFileRecord | undefined> {
    return id === FILE.id && ownerId === "oauth-tenant" ? FILE : undefined;
  }
  async readSchema(id: string, ownerId: string): Promise<string | undefined> {
    return id === FILE.id && ownerId === "oauth-tenant" ? "[schema]\n" : undefined;
  }
  async query(
    id: string,
    ownerId: string,
    query: StructuredQueryRequest,
  ): Promise<StructuredQueryResponse | undefined> {
    return id === FILE.id && ownerId === "oauth-tenant"
      ? { query, answer: "8", outputBytes: 1 }
      : undefined;
  }
  async delete(_id: string, _ownerId: string): Promise<boolean> { return false; }
  async close(): Promise<void> {}
}

class CookieJar {
  private readonly cookies = new Map<string, string>();

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) {
      headers.set("cookie", [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    }
    const response = await fetch(url, { ...init, headers, redirect: "manual" });
    const cookieHeaders = response.headers as Headers & { getSetCookie?: () => string[] };
    const values = cookieHeaders.getSetCookie?.()
      ?? (response.headers.get("set-cookie") === null ? [] : [response.headers.get("set-cookie") as string]);
    for (const value of values) {
      const pair = value.split(";", 1)[0];
      if (pair === undefined) continue;
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    return response;
  }
}

let app: FastifyInstance | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
  await app?.close();
  app = undefined;
});

describe("ephemeral OAuth adapter", () => {
  test("evicts pending clients without displacing active clients", async () => {
    const namespace = `test-${randomBytes(8).toString("hex")}:`;
    const clients = new EphemeralOAuthAdapter(`${namespace}Client`);
    const codes = new EphemeralOAuthAdapter(`${namespace}AuthorizationCode`);
    await clients.upsert("active", { clientId: "active" }, undefined as unknown as number);
    await codes.upsert("code", { clientId: "active" }, 60);
    for (let index = 0; index <= 100; index += 1) {
      await clients.upsert(`pending-${index}`, { clientId: `pending-${index}` }, undefined as unknown as number);
    }
    expect(await clients.find("active")).toBeDefined();
    expect(await clients.find("pending-0")).toBeUndefined();
    expect(await clients.find("pending-100")).toBeDefined();
  });

  test("evicts active clients only within the same account", async () => {
    const namespace = `test-${randomBytes(8).toString("hex")}:`;
    const clients = new EphemeralOAuthAdapter(`${namespace}Client`);
    const codes = new EphemeralOAuthAdapter(`${namespace}AuthorizationCode`);
    await clients.upsert("other-account", { clientId: "other-account" }, undefined as unknown as number);
    await codes.upsert("other-code", { clientId: "other-account", accountId: "other" }, 60);
    for (let index = 0; index <= 20; index += 1) {
      const clientId = `noisy-${index}`;
      await clients.upsert(clientId, { clientId }, undefined as unknown as number);
      await codes.upsert(`code-${index}`, { clientId, accountId: "noisy" }, 60);
    }
    expect(await clients.find("other-account")).toBeDefined();
    expect(await clients.find("noisy-0")).toBeUndefined();
    expect(await clients.find("noisy-20")).toBeDefined();
  });

  test("bounds records per OAuth client", async () => {
    const adapter = new EphemeralOAuthAdapter(
      `test-${randomBytes(8).toString("hex")}:Interaction`,
    );
    for (let index = 0; index <= 500; index += 1) {
      await adapter.upsert(`interaction-${index}`, { clientId: "abandoned-client" }, 600);
    }
    expect(await adapter.find("interaction-0")).toBeUndefined();
    expect(await adapter.find("interaction-500")).toBeDefined();
  });

  test("isolates token record bounds by account before client", async () => {
    const adapter = new EphemeralOAuthAdapter(
      `test-${randomBytes(8).toString("hex")}:AccessToken`,
    );
    await adapter.upsert(
      "other-account-token",
      { clientId: "schemagrep-cli", accountId: "other" },
      3600,
    );
    for (let index = 0; index <= 500; index += 1) {
      await adapter.upsert(
        `noisy-token-${index}`,
        { clientId: "schemagrep-cli", accountId: "noisy" },
        3600,
      );
    }
    expect(await adapter.find("other-account-token")).toBeDefined();
    expect(await adapter.find("noisy-token-0")).toBeUndefined();
    expect(await adapter.find("noisy-token-500")).toBeDefined();
  });
});

describe("OAuth MCP authorization", () => {
  test("discovers OAuth, completes PKCE consent, refreshes, and isolates MCP by tenant", async () => {
    const config: ServiceConfig = {
      host: "127.0.0.1",
      port: 3000,
      schemagrepBinary: "schemagrep",
      storageBaseDirectory: "/tmp/schemagrep-cloud-oauth-tests",
      fileTtlMs: 3_600_000,
      processTimeoutMs: 30_000,
      maxUploadBytes: 1024,
      maxArtifactBytes: 4096,
      maxSchemaBytes: 4096,
      maxQueryOutputBytes: 4096,
      authDisabled: false,
      apiCredentials: [{ tenantId: "oauth-tenant", secret: INVITE_KEY }],
      rateLimitMax: 100,
      rateLimitWindowMs: 60_000,
      maxTenantStorageBytes: 4096,
      workerSandbox: "disabled",
      bubblewrapBinary: "/usr/bin/bwrap",
      mcpAllowedHostnames: ["127.0.0.1", "localhost"],
      publicBaseUrl: "http://127.0.0.1:3199",
      oauthCookieKey: "oauth-cookie-0123456789abcdef0123456789",
    };
    app = buildApp({ config, fileService: new OAuthFileService() });
    const address = await app.listen({ host: "127.0.0.1", port: 3199 });

    const discovery = await fetch(`${address}/.well-known/oauth-protected-resource/mcp`);
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toMatchObject({
      resource: `${address}/mcp`,
      authorization_servers: [`${address}/oauth`],
    });
    const authorizationMetadata = await fetch(
      `${address}/.well-known/oauth-authorization-server/oauth`,
    );
    expect(authorizationMetadata.status).toBe(200);
    expect(await authorizationMetadata.json()).toMatchObject({
      revocation_endpoint: `${address}/oauth/token/revocation`,
    });
    const challenge = await fetch(`${address}/mcp`, { method: "POST" });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toContain("resource_metadata=");

    const verifier = randomBytes(48).toString("base64url");
    const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(24).toString("base64url");
    const authorization = new URL(`${address}/oauth/auth`);
    authorization.search = new URLSearchParams({
      response_type: "code",
      client_id: "schemagrep-cli",
      redirect_uri: "http://127.0.0.1:47831/callback",
      scope: "files:read files:write files:delete",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      resource: `${address}/mcp`,
    }).toString();

    const jar = new CookieJar();
    const authorizeResponse = await jar.fetch(authorization.href);
    expect(authorizeResponse.status).toBe(303);
    const loginUrl = new URL(authorizeResponse.headers.get("location") as string, address);
    expect(loginUrl.pathname).toStartWith("/oauth-login/");

    const loginResponse = await jar.fetch(loginUrl.href, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ action: "login", betaKey: INVITE_KEY }),
    });
    expect(loginResponse.status).toBe(303);
    const loginResume = new URL(loginResponse.headers.get("location") as string, address);
    expect(loginResume.pathname).toStartWith("/oauth/auth/");

    const consentRedirect = await jar.fetch(loginResume.href);
    expect(consentRedirect.status).toBe(303);
    const consentUrl = new URL(consentRedirect.headers.get("location") as string, address);
    expect(consentUrl.pathname).toStartWith("/oauth-login/");

    const consentResponse = await jar.fetch(consentUrl.href, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ action: "consent" }),
    });
    expect(consentResponse.status).toBe(303);
    const consentResume = new URL(consentResponse.headers.get("location") as string, address);
    expect(consentResume.pathname).toStartWith("/oauth/auth/");

    const callbackRedirect = await jar.fetch(consentResume.href);
    expect(callbackRedirect.status).toBe(303);
    const callback = new URL(callbackRedirect.headers.get("location") as string);
    expect(callback.searchParams.get("state")).toBe(state);
    const code = callback.searchParams.get("code");
    expect(code).not.toBeNull();

    const tokenResponse = await fetch(`${address}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "schemagrep-cli",
        redirect_uri: "http://127.0.0.1:47831/callback",
        code: code as string,
        code_verifier: verifier,
        resource: `${address}/mcp`,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = await tokenResponse.json() as Record<string, unknown>;
    expect(tokens.access_token).toBeString();
    expect(tokens.refresh_token).toBeString();

    const filesResponse = await fetch(`${address}/v1/files`, {
      headers: { authorization: `Bearer ${String(tokens.access_token)}` },
    });
    expect(filesResponse.status).toBe(200);
    expect(await filesResponse.json()).toEqual({ files: [FILE] });

    client = new Client({ name: "oauth-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", address), {
      authProvider: { token: async () => String(tokens.access_token) },
    }));
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "schemagrep_list_files",
      "schemagrep_get_schema",
      "schemagrep_query",
    ]);

    const refreshResponse = await fetch(`${address}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "schemagrep-cli",
        refresh_token: String(tokens.refresh_token),
        resource: `${address}/mcp`,
      }),
    });
    expect(refreshResponse.status).toBe(200);
    const refreshed = await refreshResponse.json() as Record<string, unknown>;
    expect(refreshed.access_token).toBeString();
    expect(refreshed.refresh_token).toBeString();
    const revocationResponse = await fetch(`${address}/oauth/token/revocation`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: String(refreshed.refresh_token),
        token_type_hint: "refresh_token",
        client_id: "schemagrep-cli",
      }),
    });
    expect(revocationResponse.status).toBe(200);
  });
});
