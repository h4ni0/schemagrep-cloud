import { describe, expect, test } from "bun:test";
import { InvalidQueryError } from "../src/files/errors";
import {
  parseStructuredQueryRequest,
  type StructuredQueryRequest,
} from "../src/query/contract";
import {
  buildSchemagrepQueryArgs,
  formatStructuredQueryResponse,
} from "../src/query/execution";

describe("structured query contract", () => {
  test("normalizes a bounded grep request and emits fixed schemagrep arguments", () => {
    const query = parseStructuredQueryRequest({
      mode: "grep",
      target: null,
      filters: [
        { field: { key: "country_code" }, op: "eq", value: "EU" },
        { field: { key: "status" }, op: "between", value: [200, 399] },
      ],
    });

    expect(query).toEqual({
      mode: "grep",
      target: null,
      filters: [
        { field: { key: "country_code" }, op: "eq", value: "EU" },
        { field: { key: "status" }, op: "between", value: [200, 399] },
      ],
      limit: 20,
    });
    expect(buildSchemagrepQueryArgs(query, 21)).toEqual([
      "--grep",
      "--where",
      "key=country_code:eq:EU",
      "--where",
      "key=status:between:200..399",
      "--limit",
      "21",
    ]);
  });

  test("routes numeric exact values through numeric predicate semantics", () => {
    const numeric = parseStructuredQueryRequest({
      mode: "count",
      target: { key: "status" },
      filters: [],
      value: 404,
    });
    const nullFilter = parseStructuredQueryRequest({
      mode: "count",
      target: null,
      filters: [{ field: { key: "latency" }, op: "eq", value: null }],
    });

    expect(numeric.value).toBe(404);
    expect(buildSchemagrepQueryArgs(numeric)).toEqual([
      "--count", "--where", "key=status:eq:404",
    ]);
    expect(nullFilter.filters[0]?.value).toBe("null");
    expect(buildSchemagrepQueryArgs(nullFilter)).toEqual([
      "--count", "--where", "key=latency:eq:null",
    ]);
  });

  test("detects one additional grep record without returning it", () => {
    const query = {
      mode: "grep",
      target: null,
      filters: [{ field: { key: "type" }, op: "eq", value: "push" }],
      limit: 2,
    } satisfies StructuredQueryRequest;

    expect(formatStructuredQueryResponse(query, "first\nsecond\nthird\n")).toEqual({
      query,
      records: ["first", "second"],
      recordCount: 2,
      truncated: true,
      outputBytes: 13,
    });
  });

  test("rejects ambiguous, unbounded, and option-injection-shaped requests", () => {
    const invalidRequests: unknown[] = [
      { mode: "rows", target: null, filters: [], command: "cat" },
      { mode: "count", target: { key: "type" }, filters: [], value: "--rows" },
      { mode: "count", target: { key: "--rows" }, filters: [], value: "push" },
      { mode: "count", target: { key: "payload.size" }, filters: [], value: 10 },
      { mode: "count", target: null, filters: [] },
      { mode: "grep", target: null, filters: [{ field: { key: "id" }, op: "eq", value: "1" }], limit: 101 },
      { mode: "rows", target: null, filters: [{ field: { key: "id" }, op: "eq", value: "1" }] },
      { mode: "count", target: null, filters: [{ field: { key: "id" }, op: "between", value: [10, 1] }] },
      {
        mode: "count",
        target: null,
        filters: Array.from({ length: 9 }, () => ({
          field: { key: "id" },
          op: "eq",
          value: "1",
        })),
      },
    ];

    for (const request of invalidRequests) {
      expect(() => parseStructuredQueryRequest(request)).toThrow(InvalidQueryError);
    }
  });

  test("explains that JSON coordinates use leaf keys instead of dotted paths", () => {
    expect(() => parseStructuredQueryRequest({
      mode: "count",
      target: null,
      filters: [{ field: { key: "payload.size" }, op: "ge", value: 10 }],
    })).toThrow("filters[0].field.key must be a leaf key name, not a dotted path; use size for payload.size");
  });
});
