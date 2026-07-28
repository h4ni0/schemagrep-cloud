import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { loadConfig, type ServiceConfig } from "./config";
import { registerFileRoutes } from "./files/routes";
import { createFileService } from "./files/service";
import type { FileService } from "./files/types";

export interface BuildAppOptions {
  logger?: boolean;
  config?: ServiceConfig;
  fileService?: FileService;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = options.config ?? loadConfig();
  const fileService = options.fileService ?? createFileService(config);
  const app = Fastify({ logger: options.logger ?? false });

  app.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1,
      fields: 0,
      parts: 1,
    },
    throwFileSizeLimit: true,
  });
  app.register(registerFileRoutes, { fileService });
  app.addHook("onClose", async () => fileService.close());

  app.get("/health", async () => ({
    service: "schemagrep-cloud",
    status: "ok",
  }));

  return app;
}
