import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import type { AuthInfo } from "@modelcontextprotocol/server";
import multipart from "@fastify/multipart";
import middie from "@fastify/middie";
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
import { OAuthService } from "./oauth/provider";
import { OAUTH_SCOPES } from "./oauth/constants";
import { registerOAuthRoutes } from "./oauth/routes";

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

function bearerToken(authorization: string | undefined): string | undefined {
  const match = /^Bearer[ \t]+([^ \t]+)[ \t]*$/iu.exec(authorization ?? "");
  return match?.[1];
}

function requiredScope(method: string, route: string): string {
  if (method === "POST" && route === "/v1/files") return "files:write";
  if (method === "DELETE" && route === "/v1/files/:id") return "files:delete";
  return "files:read";
}
function clientAddress(
  request: IncomingMessage,
  trustedProxyClientIpHeader: string | undefined,
): string {
  const remoteAddress = request.socket.remoteAddress ?? "unknown";
  const trustedLoopback = remoteAddress === "127.0.0.1" ||
    remoteAddress === "::1" ||
    remoteAddress === "::ffff:127.0.0.1";
  if (!trustedLoopback || trustedProxyClientIpHeader === undefined) return remoteAddress;
  const forwarded = request.headers[trustedProxyClientIpHeader];
  if (Array.isArray(forwarded)) return remoteAddress;
  const candidate = forwarded?.trim();
  return candidate !== undefined && isIP(candidate) !== 0 ? candidate : remoteAddress;
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
  const authenticator = config.authDisabled ? undefined : new ApiKeyAuthenticator(config.apiCredentials);
  const oauth = !config.authDisabled &&
    config.publicBaseUrl !== undefined &&
    config.oauthCookieKey !== undefined
    ? new OAuthService({ publicBaseUrl: config.publicBaseUrl, cookieKey: config.oauthCookieKey })
    : undefined;
  const rateLimiter = new FixedWindowRateLimiter(config.rateLimitMax, config.rateLimitWindowMs);
  const oauthRateLimiter = new FixedWindowRateLimiter(config.rateLimitMax, config.rateLimitWindowMs);
  const publicRoutes = new Set([
    "/",
    "/health",
    "/assets/dashboard.css",
    "/assets/dashboard.js",
    "/assets/manrope-latin-wght-normal.woff2",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server/oauth",
  ]);
  app.decorateRequest("tenantId", "");
  app.decorateRequest("authInfo", null);

  app.register(registerDashboardRoutes);
  if (oauth !== undefined && authenticator !== undefined) {
    app.register(middie);
    app.after(() => {
      const providerHandler = oauth.provider.callback();
      app.use("/oauth", (request: IncomingMessage, response: ServerResponse) => {
        const requestAddress = clientAddress(request, config.trustedProxyClientIpHeader);
        const decision = oauthRateLimiter.consume(`oauth:${requestAddress}`);
        const resetSeconds = Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000));
        response.setHeader("ratelimit-limit", decision.limit);
        response.setHeader("ratelimit-remaining", decision.remaining);
        response.setHeader("ratelimit-reset", resetSeconds);
        if (!decision.allowed) {
          response.statusCode = 429;
          response.setHeader("content-type", "application/json; charset=utf-8");
          response.setHeader("retry-after", resetSeconds);
          response.end(JSON.stringify({
            error: { code: "rate_limit_exceeded", message: "OAuth request limit exceeded" },
          }));
          return;
        }
        providerHandler(request, response);
      });
    });
    app.register(registerOAuthRoutes, { oauth, inviteAuthenticator: authenticator });
  }
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
  app.addHook("onRequest", async (request, reply) => {
    const route = request.routeOptions.url ?? "";
    const requestPath = request.url.split("?", 1)[0] ?? "";
    const publicRequest =
      publicRoutes.has(route) ||
      requestPath.startsWith("/oauth/") ||
      requestPath.startsWith("/oauth-login/");
    if (publicRequest) {
      if (requestPath.startsWith("/oauth-login/")) {
        const decision = oauthRateLimiter.consume(
          `interaction:${clientAddress(request.raw, config.trustedProxyClientIpHeader)}`,
        );
        const resetSeconds = Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000));
        reply.headers({
          "ratelimit-limit": decision.limit,
          "ratelimit-remaining": decision.remaining,
          "ratelimit-reset": resetSeconds,
        });
        if (!decision.allowed) {
          await reply
            .header("retry-after", resetSeconds)
            .code(429)
            .send({ error: { code: "rate_limit_exceeded", message: "OAuth interaction limit exceeded" } });
          return reply;
        }
      }
      return;
    }

    let tenantId: string | undefined;
    let authInfo: AuthInfo | undefined;
    if (config.authDisabled) {
      tenantId = "local-development";
      authInfo = {
        token: "[authentication-disabled]",
        clientId: tenantId,
        scopes: [...OAUTH_SCOPES],
      };
    } else {
      tenantId = authenticator?.authenticate(request.headers.authorization);
      if (tenantId !== undefined) {
        authInfo = {
          token: "[validated-and-redacted]",
          clientId: tenantId,
          scopes: [...OAUTH_SCOPES],
        };
      } else {
        const token = bearerToken(request.headers.authorization);
        if (token !== undefined) authInfo = await oauth?.verifyAccessToken(token);
        tenantId = authInfo?.clientId;
      }
    }

    const decision = rateLimiter.consume(
      tenantId ??
        `unauthenticated:${clientAddress(request.raw, config.trustedProxyClientIpHeader)}`,
    );
    const resetSeconds = Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000));
    reply.headers({
      "ratelimit-limit": decision.limit,
      "ratelimit-remaining": decision.remaining,
      "ratelimit-reset": resetSeconds,
    });

    if (!decision.allowed) {
      await reply
        .header("retry-after", resetSeconds)
        .code(429)
        .send({ error: { code: "rate_limit_exceeded", message: "Request limit exceeded" } });
      return reply;
    }
    if (tenantId === undefined || authInfo === undefined) {
      const challenge = oauth === undefined
        ? "Bearer"
        : `Bearer resource_metadata="${oauth.resourceMetadataUrl}", scope="${requiredScope(request.method, route)}"`;
      await reply
        .header("www-authenticate", challenge)
        .code(401)
        .send({ error: { code: "unauthorized", message: "A valid bearer credential is required" } });
      return reply;
    }

    const scope = requiredScope(request.method, route);
    if (!authInfo.scopes.includes(scope)) {
      await reply
        .header("www-authenticate", `Bearer error="insufficient_scope", scope="${scope}"`)
        .code(403)
        .send({ error: { code: "insufficient_scope", message: `The ${scope} scope is required` } });
      return reply;
    }
    request.tenantId = tenantId;
    request.authInfo = authInfo;
    return;
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
    .send({ authenticated: true, oauth: oauth !== undefined }));
  app.get("/v1/usage", async (request, reply) => {
    const [storage, activity] = await Promise.all([
      fileService.usage(request.tenantId),
      productTelemetry?.summarizeTenant(request.tenantId) ?? Promise.resolve({
        events: 0,
        successfulUploads: 0,
        queries: 0,
        schemaReads: 0,
        mcpRequests: 0,
        errors: 0,
      }),
    ]);
    return reply.header("cache-control", "no-store").send({ storage, activity });
  });
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
