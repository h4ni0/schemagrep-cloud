import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const MEBIBYTE = 1024 * 1024;

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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const maxUploadBytes = parseInteger(
    "MAX_UPLOAD_BYTES",
    env.MAX_UPLOAD_BYTES,
    25 * MEBIBYTE,
    1,
    1024 * MEBIBYTE,
  );

  return {
    host: env.HOST ?? "127.0.0.1",
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
  };
}
