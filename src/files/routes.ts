import type { FastifyInstance, FastifyReply } from "fastify";
import {
  EmptyUploadError,
  InvalidFilenameError,
  SchemagrepProcessError,
  UnsupportedFileTypeError,
  UploadTooLargeError,
} from "./errors";
import type { FileService } from "./types";

interface FileRouteOptions {
  fileService: FileService;
}

interface FileParams {
  id: string;
}

const FILE_ID_PATTERN = /^file_[0-9a-f]{32}$/;

function sendFileNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({
    error: { code: "file_not_found", message: "File does not exist or has expired" },
  });
}

function sendKnownError(error: unknown, reply: FastifyReply): boolean {
  let fastifyCode: string | undefined;
  if (typeof error === "object" && error !== null && "code" in error) {
    fastifyCode = typeof error.code === "string" ? error.code : undefined;
  }

  if (error instanceof UploadTooLargeError || fastifyCode === "FST_REQ_FILE_TOO_LARGE") {
    void reply.code(413).send({
      error: { code: "upload_too_large", message: "Upload exceeds the configured size limit" },
    });
    return true;
  }
  if (error instanceof EmptyUploadError) {
    void reply.code(400).send({
      error: { code: "empty_file", message: "Uploaded file must not be empty" },
    });
    return true;
  }
  if (error instanceof InvalidFilenameError) {
    void reply.code(400).send({
      error: { code: "invalid_filename", message: "Uploaded filename is invalid" },
    });
    return true;
  }
  if (error instanceof UnsupportedFileTypeError) {
    void reply.code(415).send({
      error: {
        code: "unsupported_file_type",
        message: "Supported file types are .csv, .json, .jsonl, .ndjson, .log, and .txt",
      },
    });
    return true;
  }
  if (fastifyCode === "FST_INVALID_MULTIPART_CONTENT_TYPE") {
    void reply.code(415).send({
      error: { code: "multipart_required", message: "Content-Type must be multipart/form-data" },
    });
    return true;
  }
  if (error instanceof SchemagrepProcessError) {
    if (error.kind === "output_limit") {
      void reply.code(413).send({
        error: { code: "artifact_too_large", message: "Generated artifact exceeds the service limit" },
      });
      return true;
    }
    if (error.kind === "spawn") {
      void reply.code(503).send({
        error: { code: "processor_unavailable", message: "File processor is unavailable" },
      });
      return true;
    }

    void reply.code(422).send({
      error: { code: "unprocessable_file", message: "The uploaded file could not be processed" },
    });
    return true;
  }

  return false;
}

export async function registerFileRoutes(
  app: FastifyInstance,
  options: FileRouteOptions,
): Promise<void> {
  app.post("/v1/files", async (request, reply) => {
    try {
      const upload = await request.file();
      if (upload === undefined) {
        return reply.code(400).send({
          error: { code: "file_required", message: "A multipart file field named file is required" },
        });
      }
      if (upload.fieldname !== "file") {
        upload.file.resume();
        return reply.code(400).send({
          error: { code: "file_required", message: "A multipart file field named file is required" },
        });
      }

      const record = await options.fileService.ingest({
        filename: upload.filename,
        stream: upload.file,
        wasTruncated: () => upload.file.truncated,
      });
      return reply.code(201).send(record);
    } catch (error) {
      if (sendKnownError(error, reply)) return reply;
      throw error;
    }
  });

  app.get<{ Params: FileParams }>("/v1/files/:id", async (request, reply) => {
    if (!FILE_ID_PATTERN.test(request.params.id)) return sendFileNotFound(reply);
    const record = await options.fileService.get(request.params.id);
    if (record === undefined) return sendFileNotFound(reply);
    return record;
  });

  app.get<{ Params: FileParams }>("/v1/files/:id/schema", async (request, reply) => {
    if (!FILE_ID_PATTERN.test(request.params.id)) return sendFileNotFound(reply);
    const schema = await options.fileService.readSchema(request.params.id);
    if (schema === undefined) return sendFileNotFound(reply);
    return reply.type("text/plain; charset=utf-8").send(schema);
  });

  app.delete<{ Params: FileParams }>("/v1/files/:id", async (request, reply) => {
    if (!FILE_ID_PATTERN.test(request.params.id)) return sendFileNotFound(reply);
    const deleted = await options.fileService.delete(request.params.id);
    if (!deleted) return sendFileNotFound(reply);
    return reply.code(204).send();
  });
}
