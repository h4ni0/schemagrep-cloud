import { afterEach, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("GET /health", () => {
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
});
