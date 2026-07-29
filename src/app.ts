import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { loadConfig, type ServiceConfig } from "./config";
import { registerFileRoutes } from "./files/routes";
import { createFileService } from "./files/service";
import type { FileService } from "./files/types";
import { ApiKeyAuthenticator } from "./security/auth";
import { FixedWindowRateLimiter } from "./security/rate-limit";
import { registerMcpRoutes } from "./mcp/routes";
import { registerDashboardRoutes } from "./web/routes";
import {
  ProductTelemetry,
  type ProductTelemetryInput,
} from "./telemetry/product";
import { registerFeedbackRoutes } from "./feedback/routes";
import { FeedbackStore } from "./feedback/store";

export interface BuildAppOptions {
  logger?: boolean;
  config?: ServiceConfig;
  fileService?: FileService;
  productTelemetry?: ProductTelemetry;
  feedbackStore?: FeedbackStore;
}

function productAction(method: string, route: string): ProductTelemetryInput["action"] | undefined {
  if (method === "GET" && route === "/v1/session") return "session";
  if (method === "POST" && route === "/v1/files") return "upload";
  if (method === "GET" && route === "/v1/files/:id") return "metadata";
  if (method === "GET" && route === "/v1/files/:id/schema") return "schema";
  if (method === "POST" && route === "/v1/files/:id/query") return "query";
  if (method === "DELETE" && route === "/v1/files/:id") return "delete";
  if (method === "POST" && route === "/v1/feedback") return "feedback";
  return undefined;
}

function statusClass(statusCode: number): ProductTelemetryInput["status"] {
  if (statusCode < 300) return "2xx";
  if (statusCode < 400) return "3xx";
  if (statusCode < 500) return "4xx";
  return "5xx";
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = options.config ?? loadConfig();
  const fileService = options.fileService ?? createFileService(config);
  const app = Fastify({ logger: options.logger ?? false });

  const productTelemetry = options.productTelemetry
    ?? (config.productTelemetryPath !== undefined && config.productTelemetryHashKey !== undefined
      ? new ProductTelemetry(
        config.productTelemetryPath,
        config.productTelemetryHashKey,
        (error) => app.log.error({ err: error }, "Product telemetry write failed"),
      )
      : undefined);
  const feedbackStore = options.feedbackStore
    ?? (config.feedbackPath !== undefined && config.feedbackRetentionMs !== undefined
      ? new FeedbackStore(config.feedbackPath, config.feedbackRetentionMs)
      : undefined);
  const authenticator = config.authDisabled
    ? undefined
    : new ApiKeyAuthenticator(config.apiCredentials);
  const rateLimiter = new FixedWindowRateLimiter(config.rateLimitMax, config.rateLimitWindowMs);
  const publicRoutes = new Set([
    "/",
    "/health",
    "/assets/dashboard.css",
    "/assets/dashboard.js",
    "/assets/manrope-latin-wght-normal.woff2",
  ]);
  app.decorateRequest("tenantId", "");

  app.register(registerDashboardRoutes);
  app.get("/health", async () => ({
    service: "schemagrep-cloud",
    status: "ok",
  }));

  app.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1,
      fields: 0,
      parts: 1,
    },
    throwFileSizeLimit: true,
  });
  app.addHook("onRequest", (request, reply, done) => {
    if (publicRoutes.has(request.routeOptions.url ?? "")) {
      done();
      return;
    }

    const tenantId = config.authDisabled
      ? "local-development"
      : authenticator?.authenticate(request.headers.authorization);
    const decision = rateLimiter.consume(tenantId ?? `unauthenticated:${request.ip}`);
    const resetSeconds = Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000));
    reply.headers({
      "ratelimit-limit": decision.limit,
      "ratelimit-remaining": decision.remaining,
      "ratelimit-reset": resetSeconds,
    });

    if (!decision.allowed) {
      reply
        .header("retry-after", resetSeconds)
        .code(429)
        .send({ error: { code: "rate_limit_exceeded", message: "Request limit exceeded" } });
      return;
    }
    if (tenantId === undefined) {
      reply
        .header("www-authenticate", "Bearer")
        .code(401)
        .send({ error: { code: "unauthorized", message: "A valid bearer API key is required" } });
      return;
    }

    request.tenantId = tenantId;
    done();
  });
  app.addHook("onResponse", (request, reply, done) => {
    const action = productAction(request.method, request.routeOptions.url ?? "");
    if (action !== undefined && request.tenantId.length > 0) {
      productTelemetry?.record({
        tenantId: request.tenantId,
        action,
        outcome: reply.statusCode < 400 ? "ok" : "error",
        status: statusClass(reply.statusCode),
        durationMs: reply.elapsedTime,
      });
    }
    done();
  });
  app.get("/v1/session", async (_request, reply) => reply
    .header("cache-control", "no-store")
    .send({ authenticated: true }));
  app.register(registerFeedbackRoutes, {
    ...(feedbackStore === undefined ? {} : { feedbackStore }),
  });

  app.register(registerFileRoutes, { fileService });
  app.register(registerMcpRoutes, {
    fileService,
    allowedHostnames: config.mcpAllowedHostnames,
    ...(productTelemetry === undefined ? {} : { productTelemetry }),
  });
  app.addHook("onClose", async () => {
    await productTelemetry?.flush();
    await feedbackStore?.flush();
    await fileService.close();
  });

  return app;
}
