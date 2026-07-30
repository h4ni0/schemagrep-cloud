import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { InvalidQueryError, SchemagrepProcessError } from "../files/errors";
import { FILE_ID_PATTERN } from "../files/id";
import type { FileService } from "../files/types";
import { QUERY_MODES, parseStructuredQueryRequest } from "../query/contract";

const jsonLeafKeySchema = z.string()
  .min(1)
  .max(256)
  .regex(/^[^.]+$/, "Use a leaf key name, not a dotted path; use size for payload.size")
  .describe("JSON/JSONL leaf key name, not a dotted path or JSONPath; use size for payload.size.");

const queryFieldSchema = z.union([
  z.strictObject({ col: z.number().int().min(0).max(1_000_000) }),
  z.strictObject({ slot: z.number().int().min(1).max(1_000_000) }),
  z.strictObject({ key: jsonLeafKeySchema }),
]);

const exactValueSchema = z.union([
  z.string().max(4096),
  z.number().finite(),
  z.null(),
]);

const queryFilterSchema = z.discriminatedUnion("op", [
  z.strictObject({
    field: queryFieldSchema,
    op: z.enum(["eq", "ne"]),
    value: exactValueSchema,
  }),
  z.strictObject({
    field: queryFieldSchema,
    op: z.enum(["gt", "ge", "lt", "le"]),
    value: z.number().finite(),
  }),
  z.strictObject({
    field: queryFieldSchema,
    op: z.literal("between"),
    value: z.tuple([z.number().finite(), z.number().finite()]),
  }),
]);

const fileIdSchema = z.string().regex(FILE_ID_PATTERN);
const filtersSchema = z.array(queryFilterSchema).max(8);
const templateSchema = z.number().int().min(0).max(1_000_000).optional();
const grepLimitSchema = z.number().int().min(1).max(100).optional()
  .describe('Only for mode "grep".');

const queryToolInputSchema = z.union([
  z.strictObject({
    fileId: fileIdSchema,
    mode: z.literal("rows"),
    target: z.null(),
    filters: z.array(queryFilterSchema).max(0),
  }),
  z.strictObject({
    fileId: fileIdSchema,
    mode: z.enum(["min", "max", "distinct", "const"]),
    target: queryFieldSchema,
    filters: z.array(queryFilterSchema).max(0),
    template: templateSchema,
  }),
  z.strictObject({
    fileId: fileIdSchema,
    mode: z.enum(["sum", "avg", "argmax", "argmin"]),
    target: queryFieldSchema,
    filters: filtersSchema,
    template: templateSchema,
  }),
  z.strictObject({
    fileId: fileIdSchema,
    mode: z.literal("count"),
    target: queryFieldSchema,
    filters: filtersSchema,
    value: exactValueSchema,
    template: templateSchema,
  }),
  z.strictObject({
    fileId: fileIdSchema,
    mode: z.literal("count"),
    target: z.null(),
    filters: filtersSchema.min(1),
    template: templateSchema,
  }),
  z.strictObject({
    fileId: fileIdSchema,
    mode: z.literal("grep"),
    target: queryFieldSchema,
    filters: filtersSchema,
    value: exactValueSchema,
    limit: grepLimitSchema,
    template: templateSchema,
  }),
  z.strictObject({
    fileId: fileIdSchema,
    mode: z.literal("grep"),
    target: z.null(),
    filters: filtersSchema.min(1),
    limit: grepLimitSchema,
    template: templateSchema,
  }),
]);

const fileRecordSchema = z.strictObject({
  id: z.string(),
  status: z.literal("ready"),
  codec: z.enum(["csv", "json", "jsonl", "log"]),
  originalName: z.string(),
  sourceBytes: z.number(),
  schemaBytes: z.number(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
const listFilesOutputSchema = z.strictObject({
  files: z.array(fileRecordSchema),
});

const schemaToolOutputSchema = z.strictObject({
  fileId: z.string(),
  schema: z.string(),
});
const queryToolOutputSchema = z.strictObject({
  fileId: z.string(),
  result: z.record(z.string(), z.unknown()),
});

function errorResult(code: string, message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify({ error: { code, message } }) }],
  };
}

function successfulResult<T extends Record<string, unknown>>(value: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function queryFailure(error: unknown): { code: string; message: string } {
  if (error instanceof InvalidQueryError) {
    return { code: "invalid_query", message: error.message };
  }
  if (error instanceof SchemagrepProcessError) {
    if (error.kind === "output_limit") {
      return { code: "query_output_too_large", message: "Query output exceeds the service limit" };
    }
    if (error.kind === "timeout") {
      return { code: "query_timeout", message: "Query exceeded its execution timeout" };
    }
    if (error.kind === "spawn") {
      return { code: "processor_unavailable", message: "Query processor is unavailable" };
    }
    return { code: "query_failed", message: "The query could not be executed" };
  }
  return { code: "internal_error", message: "The query could not be completed" };
}

function createTenantServer(
  fileService: FileService,
  tenantId: string,
  reportError: (error: Error) => void,
): McpServer {
  const server = new McpServer(
    { name: "schemagrep-cloud", version: "0.0.0" },
    {
      instructions:
        "Use schemagrep_list_files when the user has not provided a file ID. Once a file is selected, call schemagrep_get_schema exactly once as the first data action; after it succeeds, do not call it again. JSON/JSONL key coordinates are leaf key names, not dotted paths or JSONPath: address payload.size as { key: \"size\" }. Use schema facts directly when conclusive; otherwise use schemagrep_query. For filter-only count or grep, target must be null. grep returns complete matching records, not a projected target field. Use argmax or argmin directly when both the extremum and its count are requested. Set limit only for grep. Never infer a total count from limited grep evidence.",
    },
  );

  server.registerTool(
    "schemagrep_list_files",
    {
      title: "List uploaded files",
      description:
        "List the authenticated tenant's active uploaded files with IDs, names, codecs, sizes, and expiration times. Use this when the user refers to a file by name or has not supplied a file ID.",
      inputSchema: z.strictObject({}),
      outputSchema: listFilesOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        return successfulResult({ files: await fileService.list(tenantId) });
      } catch (error) {
        reportError(error instanceof Error ? error : new Error(String(error)));
        return errorResult("internal_error", "Files could not be listed");
      }
    },
  );

  server.registerTool(
    "schemagrep_get_schema",
    {
      title: "Read schemagrep schema",
      description:
        "Read the schema and query primer for a tenant-owned uploaded file. Call exactly once as the first action. After this succeeds, do not call it again in the same question.",
      inputSchema: z.strictObject({ fileId: z.string().regex(FILE_ID_PATTERN) }),
      outputSchema: schemaToolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ fileId }) => {
      try {
        const schema = await fileService.readSchema(fileId, tenantId);
        if (schema === undefined) {
          return errorResult("file_not_found", "File does not exist or has expired");
        }
        return successfulResult({ fileId, schema });
      } catch (error) {
        reportError(error instanceof Error ? error : new Error(String(error)));
        return errorResult("internal_error", "The schema could not be read");
      }
    },
  );

  server.registerTool(
    "schemagrep_query",
    {
      title: "Query an uploaded file",
      description:
        "Run one deterministic query. Modes: rows returns the total; count/grep accept either target+value, or target=null with one or more filters. For filter-only count/grep, target MUST be null; grep returns complete matching records and does not use target for projection. min/max/distinct/const use a target and no filters. sum/avg/argmax/argmin use a target and may use ANDed filters; argmax/argmin return the extremum and its count in one call. CSV fields use col, logs use slot, and JSON/JSONL use a leaf key name or slot. Dotted paths and JSONPath are unsupported: use key size, not payload.size. limit is legal only for grep.",
      inputSchema: queryToolInputSchema,
      outputSchema: queryToolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const { fileId, ...request } = input;
      try {
        const query = parseStructuredQueryRequest(request);
        const result = await fileService.query(fileId, tenantId, query);
        if (result === undefined) {
          return errorResult("file_not_found", "File does not exist or has expired");
        }
        return successfulResult({ fileId, result });
      } catch (error) {
        if (!(error instanceof InvalidQueryError)) {
          reportError(error instanceof Error ? error : new Error(String(error)));
        }
        const failure = queryFailure(error);
        return errorResult(failure.code, failure.message);
      }
    },
  );

  return server;
}

export function createSchemagrepMcpHandler(
  fileService: FileService,
  reportError: (error: Error) => void,
) {
  return createMcpHandler(
    ({ authInfo }) => {
      if (authInfo === undefined) throw new Error("MCP authentication context is missing");
      return createTenantServer(fileService, authInfo.clientId, reportError);
    },
    {
      legacy: "stateless",
      onerror: reportError,
    },
  );
}
