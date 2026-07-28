import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { loadConfig, type ServiceConfig } from "./config";
import { registerFileRoutes } from "./files/routes";
import { createFileService } from "./files/service";
import type { FileService } from "./files/types";
import { ApiKeyAuthenticator } from "./security/auth";
import { FixedWindowRateLimiter } from "./security/rate-limit";

export interface BuildAppOptions {
  logger?: boolean;
  config?: ServiceConfig;
  fileService?: FileService;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = options.config ?? loadConfig();
  const fileService = options.fileService ?? createFileService(config);
  const app = Fastify({ logger: options.logger ?? false });

  const authenticator = config.authDisabled
    ? undefined
    : new ApiKeyAuthenticator(config.apiCredentials);
  const rateLimiter = new FixedWindowRateLimiter(config.rateLimitMax, config.rateLimitWindowMs);
  app.decorateRequest("tenantId", "");

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
    if (request.routeOptions.url === "/health") {
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
  app.register(registerFileRoutes, { fileService });
  app.addHook("onClose", async () => fileService.close());

  return app;
}
