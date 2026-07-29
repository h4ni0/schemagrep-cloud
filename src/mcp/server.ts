import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { InvalidQueryError, SchemagrepProcessError } from "../files/errors";
import { FILE_ID_PATTERN } from "../files/id";
import type { FileService } from "../files/types";
import { QUERY_MODES, parseStructuredQueryRequest } from "../query/contract";

const queryFieldSchema = z.union([
  z.strictObject({ col: z.number().int().min(0).max(1_000_000) }),
  z.strictObject({ slot: z.number().int().min(1).max(1_000_000) }),
  z.strictObject({ key: z.string().min(1).max(256) }),
]);

const queryFilterSchema = z.discriminatedUnion("op", [
  z.strictObject({
    field: queryFieldSchema,
    op: z.enum(["eq", "ne"]),
    value: z.string().max(4096),
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

const queryToolInputSchema = z.strictObject({
  fileId: z.string().regex(FILE_ID_PATTERN),
  mode: z.enum(QUERY_MODES),
  target: queryFieldSchema.nullable(),
  filters: z.array(queryFilterSchema).max(8),
  value: z.string().max(4096).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  template: z.number().int().min(0).max(1_000_000).optional(),
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
        "Read a file's schemagrep schema before querying it. Use schemagrep_query for exact counts, filters, aggregates, and bounded record evidence. Never infer a total count from a limited grep result.",
    },
  );

  server.registerTool(
    "schemagrep_get_schema",
    {
      title: "Read schemagrep schema",
      description:
        "Read the schema and query primer for a tenant-owned uploaded file. Call this before schemagrep_query so field coordinates and schema facts are known.",
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
        "Run a deterministic query against a tenant-owned uploaded file. CSV fields use col, logs use slot, and JSON/JSONL use key or slot. Filters are ANDed. grep evidence is limited to 1-100 records and reports whether more matches exist.",
      inputSchema: queryToolInputSchema,
      outputSchema: queryToolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ fileId, mode, target, filters, value, limit, template }) => {
      try {
        const query = parseStructuredQueryRequest({
          mode,
          target,
          filters,
          value,
          limit,
          template,
        });
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
