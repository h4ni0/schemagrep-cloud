import { InvalidQueryError } from "../files/errors";

export const QUERY_MODES = [
  "rows",
  "count",
  "grep",
  "min",
  "max",
  "sum",
  "avg",
  "argmax",
  "argmin",
  "distinct",
  "const",
] as const;

export type QueryMode = (typeof QUERY_MODES)[number];
export type QueryField = { col: number } | { slot: number } | { key: string };
export type QueryFilter =
  | { field: QueryField; op: "eq" | "ne"; value: string }
  | { field: QueryField; op: "gt" | "ge" | "lt" | "le"; value: number }
  | { field: QueryField; op: "between"; value: [number, number] };

export interface StructuredQueryRequest {
  mode: QueryMode;
  target: QueryField | null;
  filters: QueryFilter[];
  value?: string;
  limit?: number;
  template?: number;
}

export type StructuredQueryResponse =
  | {
      query: StructuredQueryRequest;
      answer: string;
      outputBytes: number;
    }
  | {
      query: StructuredQueryRequest;
      records: string[];
      recordCount: number;
      truncated: boolean;
      outputBytes: number;
    };

const MODES = new Set<string>(QUERY_MODES);
const FILTERED_MODES = new Set<QueryMode>([
  "count",
  "grep",
  "min",
  "max",
  "sum",
  "avg",
  "argmax",
  "argmin",
]);
const TARGET_MODES = new Set<QueryMode>([
  "min",
  "max",
  "sum",
  "avg",
  "argmax",
  "argmin",
  "distinct",
  "const",
]);
const NUMERIC_OPERATORS = new Set(["gt", "ge", "lt", "le"]);
const MAX_FILTERS = 8;
const MAX_QUERY_STRING_BYTES = 4096;
const MAX_QUERY_COORDINATE = 1_000_000;
const MAX_GREP_LIMIT = 100;

function invalid(message: string): never {
  throw new InvalidQueryError(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    invalid(`${context} contains unsupported fields`);
  }
}

function parseCoordinate(value: unknown, context: string): QueryField {
  if (!isObject(value)) invalid(`${context} must identify one field`);
  rejectUnknownKeys(value, ["col", "slot", "key"], context);
  const entries = Object.entries(value);
  if (entries.length !== 1) invalid(`${context} must contain exactly one of col, slot, or key`);

  const [kind, coordinate] = entries[0]!;
  if (kind === "key") {
    if (
      typeof coordinate !== "string" ||
      Buffer.byteLength(coordinate, "utf8") === 0 ||
      Buffer.byteLength(coordinate, "utf8") > 256 ||
      /[\u0000-\u001f\u007f:]/u.test(coordinate) ||
      coordinate.startsWith("--")
    ) {
      invalid(`${context}.key is invalid`);
    }
    return { key: coordinate };
  }

  const minimum = kind === "slot" ? 1 : 0;
  if (
    !Number.isSafeInteger(coordinate) ||
    (coordinate as number) < minimum ||
    (coordinate as number) > MAX_QUERY_COORDINATE
  ) {
    invalid(`${context}.${kind} must be an integer from ${minimum} to ${MAX_QUERY_COORDINATE}`);
  }
  return kind === "col" ? { col: coordinate as number } : { slot: coordinate as number };
}

function parseString(value: unknown, context: string, rejectLeadingFlag: boolean): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_QUERY_STRING_BYTES ||
    value.includes("\u0000") ||
    (rejectLeadingFlag && value.startsWith("--"))
  ) {
    invalid(`${context} must be a valid string of at most ${MAX_QUERY_STRING_BYTES} bytes`);
  }
  return value;
}

function parseExactValue(value: unknown, context: string, rejectLeadingFlag: boolean): string {
  if (typeof value === "string") return parseString(value, context, rejectLeadingFlag);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value === null) return "null";
  invalid(`${context} must be a string, finite number, or null`);
}

function parseFilter(value: unknown, index: number): QueryFilter {
  const context = `filters[${index}]`;
  if (!isObject(value)) invalid(`${context} must be an object`);
  rejectUnknownKeys(value, ["field", "op", "value"], context);
  const field = parseCoordinate(value.field, `${context}.field`);

  if (value.op === "eq" || value.op === "ne") {
    return {
      field,
      op: value.op,
      value: parseExactValue(value.value, `${context}.value`, false),
    };
  }
  if (typeof value.op === "string" && NUMERIC_OPERATORS.has(value.op)) {
    if (typeof value.value !== "number" || !Number.isFinite(value.value)) {
      invalid(`${context}.value must be a finite number for ${value.op}`);
    }
    return { field, op: value.op as "gt" | "ge" | "lt" | "le", value: value.value };
  }
  if (value.op === "between") {
    if (
      !Array.isArray(value.value) ||
      value.value.length !== 2 ||
      value.value.some((bound) => typeof bound !== "number" || !Number.isFinite(bound))
    ) {
      invalid(`${context}.value must be a two-number array for between`);
    }
    const [lower, upper] = value.value as [number, number];
    if (lower > upper) invalid(`${context}.value lower bound must not exceed its upper bound`);
    return { field, op: "between", value: [lower, upper] };
  }
  invalid(`${context}.op must be eq, ne, gt, ge, lt, le, or between`);
}

export function parseStructuredQueryRequest(input: unknown): StructuredQueryRequest {
  if (!isObject(input)) invalid("Request body must be a JSON object");
  rejectUnknownKeys(input, ["mode", "target", "filters", "value", "limit", "template"], "Request");
  if (typeof input.mode !== "string" || !MODES.has(input.mode)) {
    invalid(`mode must be one of ${QUERY_MODES.join(", ")}`);
  }
  const mode = input.mode as QueryMode;
  const target = input.target === undefined || input.target === null
    ? null
    : parseCoordinate(input.target, "target");

  const rawFilters = input.filters ?? [];
  if (!Array.isArray(rawFilters) || rawFilters.length > MAX_FILTERS) {
    invalid(`filters must be an array containing at most ${MAX_FILTERS} predicates`);
  }
  const filters = rawFilters.map(parseFilter);
  if (filters.length > 0 && !FILTERED_MODES.has(mode)) {
    invalid(`${mode} does not support filters`);
  }

  let value: string | undefined;
  if (input.value !== undefined) {
    if (mode !== "count" && mode !== "grep") invalid("value only composes with count or grep");
    value = parseExactValue(input.value, "value", true);
  }

  if (TARGET_MODES.has(mode) && target === null) invalid(`${mode} requires a target`);
  if ((mode === "count" || mode === "grep") && value !== undefined && target === null) {
    invalid(`${mode} with a value requires a target`);
  }
  if ((mode === "count" || mode === "grep") && value === undefined) {
    if (filters.length === 0) invalid(`bare ${mode} requires at least one filter`);
    if (target !== null) invalid(`bare ${mode} does not accept an unused target`);
  }
  if (mode === "rows" && target !== null) invalid("rows does not accept a target");

  let template: number | undefined;
  if (input.template !== undefined) {
    if (
      !Number.isSafeInteger(input.template) ||
      (input.template as number) < 0 ||
      (input.template as number) > MAX_QUERY_COORDINATE ||
      mode === "rows"
    ) {
      invalid(`template must be an integer from 0 to ${MAX_QUERY_COORDINATE}`);
    }
    template = input.template as number;
  }

  let limit: number | undefined;
  if (mode === "grep") {
    const requestedLimit = input.limit ?? 20;
    if (
      typeof requestedLimit !== "number" ||
      !Number.isSafeInteger(requestedLimit) ||
      requestedLimit < 1 ||
      requestedLimit > MAX_GREP_LIMIT
    ) {
      invalid(`grep limit must be an integer from 1 to ${MAX_GREP_LIMIT}`);
    }
    limit = requestedLimit;
  } else if (input.limit !== undefined) {
    invalid("limit only composes with grep");
  }

  return {
    mode,
    target,
    filters,
    ...(value === undefined ? {} : { value }),
    ...(limit === undefined ? {} : { limit }),
    ...(template === undefined ? {} : { template }),
  };
}
