import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import { summarizeProductTelemetry } from "../src/telemetry/product";

const BETA_KEY = "beta-dashboard-test-0123456789abcdef";
const temporaryDirectories: string[] = [];
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

describe("hosted beta application", () => {
  test("reports service readiness", async () => {
    app = buildApp({ config: loadConfig({ AUTH_DISABLED: "true" }) });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    const body: unknown = JSON.parse(response.body);
    expect(body).toEqual({
      service: "schemagrep-cloud",
      status: "ok",
    });
  });

  test("serves a public dashboard with isolated browser assets", async () => {
    app = buildApp({ config: loadConfig({ AUTH_DISABLED: "true" }) });

    const page = await app.inject({ method: "GET", url: "/" });
    const stylesheet = await app.inject({ method: "GET", url: "/assets/dashboard.css" });
    const script = await app.inject({ method: "GET", url: "/assets/dashboard.js" });

    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.body).toContain("Unlock your workspace");
    expect(page.body).toContain("Raw upload");
    expect(stylesheet.statusCode).toBe(200);
    expect(stylesheet.headers["content-type"]).toContain("text/css");
    expect(script.statusCode).toBe(200);
    expect(script.headers["content-type"]).toContain("text/javascript");
  });

  test("validates an invite without exposing the tenant and records aggregate use", async () => {
    const directory = await mkdtemp(join(tmpdir(), "schemagrep-cloud-app-test-"));
    temporaryDirectories.push(directory);
    const telemetryPath = join(directory, "metrics", "product.jsonl");
    app = buildApp({
      config: loadConfig({
        SCHEMAGREP_API_KEYS: JSON.stringify({ beta: BETA_KEY }),
        PRODUCT_TELEMETRY_PATH: telemetryPath,
        PRODUCT_TELEMETRY_HASH_KEY: "dashboard-telemetry-test-0123456789abcdef",
      }),
    });

    const unauthorized = await app.inject({ method: "GET", url: "/v1/session" });
    const authorized = await app.inject({
      method: "GET",
      url: "/v1/session",
      headers: { authorization: `Bearer ${BETA_KEY}` },
    });
    await app.close();
    app = undefined;

    expect(unauthorized.statusCode).toBe(401);
    expect(authorized.statusCode).toBe(200);
    expect(JSON.parse(authorized.body)).toEqual({ authenticated: true });
    expect(authorized.body).not.toContain("beta");
    expect(await summarizeProductTelemetry(telemetryPath)).toMatchObject({
      events: 1,
      activeTenants: 1,
      byAction: { session: 1 },
      byOutcome: { ok: 1 },
    });
  });
});
