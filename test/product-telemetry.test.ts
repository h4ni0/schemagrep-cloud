import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config";
import {
  ProductTelemetry,
  summarizeProductTelemetry,
} from "../src/telemetry/product";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

describe("aggregate product telemetry", () => {
  test("is disabled by default and requires a separate hashing secret", () => {
    expect(loadConfig({ AUTH_DISABLED: "true" }).productTelemetryPath).toBeUndefined();
    expect(() => loadConfig({
      AUTH_DISABLED: "true",
      PRODUCT_TELEMETRY_PATH: "/tmp/product.jsonl",
    })).toThrow("PRODUCT_TELEMETRY_HASH_KEY");
    expect(() => loadConfig({
      AUTH_DISABLED: "true",
      PRODUCT_TELEMETRY_HASH_KEY: "telemetry-only-key-0123456789abcdef",
    })).toThrow("PRODUCT_TELEMETRY_PATH");
  });

  test("stores only coarse events and reports repeat upload adoption", async () => {
    const directory = await mkdtemp(join(tmpdir(), "schemagrep-product-telemetry-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "private", "events.jsonl");
    const telemetry = new ProductTelemetry(path, "product-test-hash-key-0123456789abcdef");

    telemetry.record({ tenantId: "customer-alpha", action: "session", outcome: "ok", status: "2xx", durationMs: 2 });
    telemetry.record({ tenantId: "customer-alpha", action: "upload", outcome: "ok", status: "2xx", durationMs: 125 });
    telemetry.record({ tenantId: "customer-alpha", action: "upload", outcome: "ok", status: "2xx", durationMs: 1_200 });
    telemetry.record({ tenantId: "customer-beta", action: "query", outcome: "error", status: "4xx", durationMs: 23, mode: "count" });
    await telemetry.flush();
    await appendFile(path, "not-json\n", "utf8");

    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("customer-alpha");
    expect(raw).not.toContain("customer-beta");
    expect(raw).not.toContain("file_");
    expect(raw).not.toContain("filename");
    expect(raw).not.toContain("schema");
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    expect(await summarizeProductTelemetry(path)).toMatchObject({
      formatVersion: 1,
      events: 4,
      invalidLines: 1,
      activeTenants: 2,
      repeatUploadTenants: 1,
      byAction: { session: 1, upload: 2, query: 1 },
      byOutcome: { ok: 3, error: 1 },
      byStatus: { "2xx": 3, "4xx": 1 },
      byLatency: { lt10ms: 1, "10to49ms": 1, "50to199ms": 1, "1splus": 1 },
      queryModes: { count: 1 },
    });
  });
});
