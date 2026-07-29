import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const MEBIBYTE = 1024 * 1024;

const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface ApiCredentialConfig {
  tenantId: string;
  secret: string;
}

export type WorkerSandboxMode = "bwrap" | "disabled";

export interface ServiceConfig {
  host: string;
  port: number;
  schemagrepBinary: string;
  storageBaseDirectory: string;
  fileTtlMs: number;
  processTimeoutMs: number;
  maxUploadBytes: number;
  maxArtifactBytes: number;
  maxSchemaBytes: number;
  maxQueryOutputBytes: number;
  authDisabled: boolean;
  apiCredentials: readonly ApiCredentialConfig[];
  rateLimitMax: number;
  rateLimitWindowMs: number;
  maxTenantStorageBytes: number;
  workerSandbox: WorkerSandboxMode;
  bubblewrapBinary: string;
  mcpAllowedHostnames: readonly string[];
  productTelemetryPath?: string;
  productTelemetryHashKey?: string;
}

function parseInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}; received ${value}`);
  }

  return parsed;
}

function parseBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false; received ${value}`);
}

function parseSandboxMode(value: string | undefined): WorkerSandboxMode {
  if (value === undefined || value === "bwrap") return "bwrap";
  if (value === "disabled") return "disabled";
  throw new Error(`WORKER_SANDBOX must be bwrap or disabled; received ${value}`);
}

function parseMcpAllowedHostnames(value: string | undefined, serviceHost: string): string[] {
  const candidates =
    value === undefined
      ? [serviceHost, "localhost", "127.0.0.1", "[::1]"]
      : value.split(",").map((hostname) => hostname.trim());
  const hostnames = [...new Set(candidates.map((hostname) => hostname.toLowerCase()))];
  const validHostname = /^(?:\[[0-9a-f:]+\]|[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)$/u;
  if (
    hostnames.length === 0 ||
    hostnames.length > 20 ||
    hostnames.some(
      (hostname) =>
        hostname.length === 0 ||
        hostname.length > 253 ||
        !validHostname.test(hostname) ||
        hostname.includes(".."),
    )
  ) {
    throw new Error("MCP_ALLOWED_HOSTS must contain 1 to 20 comma-separated hostnames");
  }
  return hostnames;
}

function parseProductTelemetry(env: NodeJS.ProcessEnv): {
  productTelemetryPath?: string;
  productTelemetryHashKey?: string;
} {
  const path = env.PRODUCT_TELEMETRY_PATH;
  const hashKey = env.PRODUCT_TELEMETRY_HASH_KEY;
  if (path === undefined && hashKey === undefined) return {};
  if (path === undefined || path.length === 0 || path.length > 4096) {
    throw new Error("PRODUCT_TELEMETRY_PATH is required and must contain 1 to 4096 characters");
  }
  if (
    hashKey === undefined ||
    Buffer.byteLength(hashKey, "utf8") < 32 ||
    Buffer.byteLength(hashKey, "utf8") > 512
  ) {
    throw new Error("PRODUCT_TELEMETRY_HASH_KEY is required and must contain 32 to 512 UTF-8 bytes");
  }
  return { productTelemetryPath: path, productTelemetryHashKey: hashKey };
}

function parseApiCredentials(value: string | undefined, authDisabled: boolean): ApiCredentialConfig[] {
  if (authDisabled && value === undefined) return [];
  if (value === undefined) {
    throw new Error(
      "SCHEMAGREP_API_KEYS is required unless AUTH_DISABLED=true. " +
        'Use a JSON object such as {\"local\":\"a-secret-with-at-least-32-bytes\"}.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("SCHEMAGREP_API_KEYS must be a valid JSON object");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("SCHEMAGREP_API_KEYS must be a JSON object mapping tenant IDs to secrets");
  }

  const credentials: ApiCredentialConfig[] = [];
  const seenSecrets = new Set<string>();
  for (const [tenantId, secret] of Object.entries(parsed)) {
    if (!TENANT_ID_PATTERN.test(tenantId)) {
      throw new Error(`Invalid tenant ID in SCHEMAGREP_API_KEYS: ${tenantId}`);
    }
    if (
      typeof secret !== "string" ||
      Buffer.byteLength(secret, "utf8") < 32 ||
      Buffer.byteLength(secret, "utf8") > 512
    ) {
      throw new Error(`API key for tenant ${tenantId} must contain 32 to 512 UTF-8 bytes`);
    }
    if (seenSecrets.has(secret)) {
      throw new Error("Each tenant in SCHEMAGREP_API_KEYS must use a unique API key");
    }
    seenSecrets.add(secret);
    credentials.push({ tenantId, secret });
  }

  if (!authDisabled && credentials.length === 0) {
    throw new Error("SCHEMAGREP_API_KEYS must configure at least one tenant");
  }
  if (credentials.length > 100) {
    throw new Error("SCHEMAGREP_API_KEYS supports at most 100 tenants");
  }
  return credentials;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const authDisabled = parseBoolean("AUTH_DISABLED", env.AUTH_DISABLED, false);
  const apiCredentials = parseApiCredentials(env.SCHEMAGREP_API_KEYS, authDisabled);
  const host = env.HOST ?? "127.0.0.1";
  const productTelemetry = parseProductTelemetry(env);
  const maxUploadBytes = parseInteger(
    "MAX_UPLOAD_BYTES",
    env.MAX_UPLOAD_BYTES,
    25 * MEBIBYTE,
    1,
    1024 * MEBIBYTE,
  );

  return {
    host,
    port: parseInteger("PORT", env.PORT, 3000, 1, 65_535),
    schemagrepBinary:
      env.SCHEMAGREP_BIN ??
      fileURLToPath(new URL("../vendor/schemagrep/schemagrep", import.meta.url)),
    storageBaseDirectory: env.STORAGE_DIR ?? join(tmpdir(), "schemagrep-cloud"),
    fileTtlMs: parseInteger("FILE_TTL_SECONDS", env.FILE_TTL_SECONDS, 3600, 1, 86_400) * 1000,
    processTimeoutMs: parseInteger(
      "PROCESS_TIMEOUT_MS",
      env.PROCESS_TIMEOUT_MS,
      30_000,
      100,
      300_000,
    ),
    maxUploadBytes,
    maxArtifactBytes: parseInteger(
      "MAX_ARTIFACT_BYTES",
      env.MAX_ARTIFACT_BYTES,
      Math.min(maxUploadBytes * 4, 2 * 1024 * MEBIBYTE),
      1,
      2 * 1024 * MEBIBYTE,
    ),
    maxSchemaBytes: parseInteger(
      "MAX_SCHEMA_BYTES",
      env.MAX_SCHEMA_BYTES,
      4 * MEBIBYTE,
      1,
      64 * MEBIBYTE,
    ),
    maxQueryOutputBytes: parseInteger(
      "MAX_QUERY_OUTPUT_BYTES",
      env.MAX_QUERY_OUTPUT_BYTES,
      1 * MEBIBYTE,
      1024,
      64 * MEBIBYTE,
    ),
    authDisabled,
    apiCredentials,
    rateLimitMax: parseInteger("RATE_LIMIT_MAX", env.RATE_LIMIT_MAX, 60, 1, 10_000),
    rateLimitWindowMs: parseInteger(
      "RATE_LIMIT_WINDOW_MS",
      env.RATE_LIMIT_WINDOW_MS,
      60_000,
      1000,
      3_600_000,
    ),
    maxTenantStorageBytes: parseInteger(
      "MAX_TENANT_STORAGE_BYTES",
      env.MAX_TENANT_STORAGE_BYTES,
      512 * MEBIBYTE,
      1,
      100 * 1024 * MEBIBYTE,
    ),
    workerSandbox: parseSandboxMode(env.WORKER_SANDBOX),
    bubblewrapBinary: env.BWRAP_BIN ?? "/usr/bin/bwrap",
    mcpAllowedHostnames: parseMcpAllowedHostnames(env.MCP_ALLOWED_HOSTS, host),
    ...productTelemetry,
  };
}
