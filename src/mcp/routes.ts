import type { FastifyInstance } from "fastify";
import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  hostHeaderValidation,
  originValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import type { NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import type { FileService } from "../files/types";
import { createSchemagrepMcpHandler } from "./server";
import type { ProductTelemetry } from "../telemetry/product";

interface McpRouteOptions {
  fileService: FileService;
  allowedHostnames: readonly string[];
  productTelemetry?: ProductTelemetry;
}

export async function registerMcpRoutes(
  app: FastifyInstance,
  options: McpRouteOptions,
): Promise<void> {
  const reportError = (error: Error) => app.log.error({ err: error }, "MCP request failed");
  const handler = createSchemagrepMcpHandler(options.fileService, reportError);
  const nodeHandler = toNodeHandler(handler, { onerror: reportError });
  const validateHost = hostHeaderValidation([...options.allowedHostnames]);
  const validateOrigin = originValidation([...options.allowedHostnames]);

  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    handler: async (request, reply) => {
      reply.hijack();
      if (!validateHost(request.raw, reply.raw) || !validateOrigin(request.raw, reply.raw)) return;

      const auth: AuthInfo = {
        token: "[validated-and-redacted]",
        clientId: request.tenantId,
        scopes: ["schemagrep:read"],
      };
      const nodeRequest: NodeIncomingMessageLike = {
        method: request.method,
        url: request.raw.url ?? request.url,
        headers: request.raw.headers,
        auth,
        [Symbol.asyncIterator]: () => request.raw[Symbol.asyncIterator](),
      };
      const started = performance.now();
      try {
        await nodeHandler(nodeRequest, reply.raw, request.body);
      } finally {
        const statusCode = reply.raw.statusCode;
        options.productTelemetry?.record({
          tenantId: request.tenantId,
          action: "mcp",
          outcome: statusCode < 400 ? "ok" : "error",
          status: statusCode < 300 ? "2xx" : statusCode < 400 ? "3xx" : statusCode < 500 ? "4xx" : "5xx",
          durationMs: performance.now() - started,
        });
      }
    },
  });

  app.addHook("onClose", async () => handler.close());
}
