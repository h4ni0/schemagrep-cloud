import type {
  QueryField,
  QueryFilter,
  StructuredQueryRequest,
  StructuredQueryResponse,
} from "./contract";

function coordinateArgument(field: QueryField): [string, string] {
  if ("col" in field) return ["--col", String(field.col)];
  if ("slot" in field) return ["--slot", String(field.slot)];
  return ["--key", field.key];
}

function filterCoordinate(field: QueryField): string {
  if ("col" in field) return `col=${field.col}`;
  if ("slot" in field) return `slot=${field.slot}`;
  return `key=${field.key}`;
}

function filterValue(filter: QueryFilter): string {
  if (filter.op === "between") return `${filter.value[0]}..${filter.value[1]}`;
  return String(filter.value);
}

export function buildSchemagrepQueryArgs(
  request: StructuredQueryRequest,
  grepLimit: number | undefined = request.limit,
): string[] {
  const args = [`--${request.mode}`];
  if (request.value !== undefined) args.push(request.value);
  if (request.target !== null) args.push(...coordinateArgument(request.target));
  if (request.template !== undefined) args.push("--template", String(request.template));
  for (const filter of request.filters) {
    args.push(
      "--where",
      `${filterCoordinate(filter.field)}:${filter.op}:${filterValue(filter)}`,
    );
  }
  if (request.mode === "grep" && grepLimit !== undefined) {
    args.push("--limit", String(grepLimit));
  }
  return args;
}

function withoutTerminalNewline(output: string): string {
  return output.endsWith("\n") ? output.slice(0, -1) : output;
}

export function formatStructuredQueryResponse(
  request: StructuredQueryRequest,
  output: string,
): StructuredQueryResponse {
  if (request.mode !== "grep") {
    const answer = withoutTerminalNewline(output);
    return {
      query: request,
      answer,
      outputBytes: Buffer.byteLength(answer, "utf8"),
    };
  }

  const completeOutput = withoutTerminalNewline(output);
  const allRecords = completeOutput.length === 0 ? [] : completeOutput.split("\n");
  const limit = request.limit ?? 20;
  const truncated = allRecords.length > limit;
  const records = truncated ? allRecords.slice(0, limit) : allRecords;
  return {
    query: request,
    records,
    recordCount: records.length,
    truncated,
    outputBytes: records.reduce(
      (bytes, record) => bytes + Buffer.byteLength(record, "utf8") + 1,
      0,
    ),
  };
}
