# schemagrep-cloud

Ephemeral HTTP API around [schemagrep](https://github.com/hshei/schemagrep). It accepts CSV, JSON, JSONL, and log files, retains the encoded artifact and schema for a short TTL, executes bounded structured queries, and deletes the raw upload immediately after processing.

Hosted model calls are not implemented. Customer-owned models connect through the authenticated MCP endpoint and pay their own model provider; schemagrep-cloud never receives a model-provider credential.

## Prerequisites

- Bun 1.3 or newer
- C compiler and `make`
- `pkg-config`
- PCRE2 development headers (`pcre2` on Arch, `libpcre2-dev` on Debian/Ubuntu)
- Bubblewrap (`bubblewrap` package) for the default network/filesystem worker sandbox

## Clone and run

```bash
git clone --recurse-submodules https://github.com/h4ni0/schemagrep-cloud.git
cd schemagrep-cloud
bun install
bun run setup-engine
export API_KEY="$(openssl rand -hex 32)"
echo "Local API key: $API_KEY"
SCHEMAGREP_API_KEYS="{\"local\":\"$API_KEY\"}" bun src/server.ts
```

For an existing clone:

```bash
git pull
git submodule update --init --recursive
bun install
bun run setup-engine
export API_KEY="$(openssl rand -hex 32)"
echo "Local API key: $API_KEY"
SCHEMAGREP_API_KEYS="{\"local\":\"$API_KEY\"}" bun src/server.ts
```

The service uses the bundled `vendor/schemagrep/schemagrep` binary by default. To use another build, provide its explicit path:

```bash
SCHEMAGREP_BIN=/absolute/path/to/hshei/schemagrep bun src/server.ts
```

Startup rejects missing, non-executable, or unrelated binaries before the API begins listening.

## Upload a JSONL file

In the terminal making requests, export the key printed when the service started:

```bash
export API_KEY="paste-the-printed-key-here"
UPLOAD=$(curl -sS -H "Authorization: Bearer $API_KEY" -F "file=@vendor/schemagrep/samples/jsonl/qtest.jsonl" "http://127.0.0.1:3000/v1/files")
print -r -- "$UPLOAD" | jq
FILE_ID=$(print -r -- "$UPLOAD" | jq -r '.id')
```

Read metadata and schema:

```bash
curl -sS -H "Authorization: Bearer $API_KEY" "http://127.0.0.1:3000/v1/files/$FILE_ID" | jq
curl -sS -H "Authorization: Bearer $API_KEY" "http://127.0.0.1:3000/v1/files/$FILE_ID/schema"
```

Run a validated query against the retained encoded artifact:

```bash
curl -sS \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"mode":"count","target":{"key":"type"},"value":"push","filters":[]}' \
  "http://127.0.0.1:3000/v1/files/$FILE_ID/query" | jq
```

The query contract accepts `rows`, `count`, `grep`, `min`, `max`, `sum`, `avg`,
`argmax`, `argmin`, `distinct`, and `const`. A target or filter field is
`{"col":N}` for CSV, `{"slot":N}` for logs, and `{"slot":N}` or `{"key":"name"}`
for JSON/JSONL. Up to eight filters are combined with AND. `eq` and `ne` take
string values; `gt`, `ge`, `lt`, and `le` take numbers; `between` takes a
two-number array.

`grep` always has a bounded `limit` from 1 to 100 (default 20). Its response
contains `records`, `recordCount`, and an exact `truncated` flag. Other modes
return their schemagrep result in `answer`.

## Connect a customer-owned model through MCP

Configure a remote Streamable HTTP MCP server in the model client:

```json
{
  "mcpServers": {
    "schemagrep": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "Bearer <service-api-key>"
      }
    }
  }
}
```

Client configuration field names vary, but the transport URL and bearer header
are the same. The endpoint supports the current 2026 Streamable HTTP protocol
and the stateless 2025 fallback.

The server exposes two read-only tools:

| Tool | Purpose |
|---|---|
| `schemagrep_get_schema` | Read a tenant-owned file's schema and query primer |
| `schemagrep_query` | Execute the same validated, bounded contract as the REST query endpoint |

Upload remains a REST operation: upload the file, give its `file_...` ID to the
model, and ask the question. The tool instructions tell the model to read the
schema first and never infer a total from limited grep evidence. The customer's
model account pays for inference; schemagrep-cloud pays no model-provider cost.

Delete the retained artifact:

```bash
curl -i -X DELETE -H "Authorization: Bearer $API_KEY" "http://127.0.0.1:3000/v1/files/$FILE_ID"
```

## Routes

```text
GET    /health
POST   /v1/files
GET    /v1/files/{id}
GET    /v1/files/{id}/schema
POST   /v1/files/{id}/query
DELETE /v1/files/{id}
GET/POST/DELETE /mcp
```

The upload field must be named `file`. Supported filename extensions are `.csv`, `.json`, `.jsonl`, `.ndjson`, `.log`, and `.txt`.

`GET /health` is public. Every other route requires `Authorization: Bearer <service-api-key>`.

## Configuration

| Variable | Default |
|---|---:|
| `HOST` | `127.0.0.1` |
| `PORT` | `3000` |
| `FILE_TTL_SECONDS` | `3600` |
| `MAX_UPLOAD_BYTES` | `26214400` |
| `PROCESS_TIMEOUT_MS` | `30000` |
| `MAX_SCHEMA_BYTES` | `4194304` |
| `MAX_ARTIFACT_BYTES` | four times the upload limit, capped at 2 GiB |
| `MAX_QUERY_OUTPUT_BYTES` | `1048576` |
| `STORAGE_DIR` | system temporary directory |
| `SCHEMAGREP_BIN` | bundled engine binary |
| `SCHEMAGREP_API_KEYS` | required JSON object mapping tenant IDs to 32–512 byte secrets |
| `AUTH_DISABLED` | `false`; set `true` only for isolated local development |
| `RATE_LIMIT_MAX` | `60` requests per tenant or unauthenticated IP |
| `RATE_LIMIT_WINDOW_MS` | `60000` |
| `MAX_TENANT_STORAGE_BYTES` | `536870912` retained artifact + schema bytes |
| `WORKER_SANDBOX` | `bwrap`; set `disabled` only for isolated local development |
| `BWRAP_BIN` | `/usr/bin/bwrap` |
| `MCP_ALLOWED_HOSTS` | `HOST`, `localhost`, `127.0.0.1`, and `[::1]`; comma-separated hostnames |

The byte fields returned in metadata are diagnostic measurements, not compression guarantees.

## Security boundary

The current API:

- authenticates every REST and MCP request with a hashed bearer-key comparison;
- scopes file reads, queries, and deletion to the tenant that uploaded the file;
- applies bounded in-memory rate limits per tenant and per unauthenticated IP;
- caps each tenant's retained artifact and schema bytes, releasing quota on deletion or expiry;
- streams uploads through a fixed byte limit;
- rejects empty files, unsupported extensions, unsafe filenames, and malformed public IDs;
- strips multipart path components before filenames reach storage validation;
- generates storage paths from random server-side IDs, never client filenames or URL parameters;
- invokes schemagrep with fixed arguments and `shell: false`;
- accepts only a closed structured-query grammar, translates it to fixed argument arrays, and bounds grep evidence to 100 records;
- isolates MCP tools by the authenticated tenant and validates MCP Host and Origin headers against `MCP_ALLOWED_HOSTS`;
- runs schemagrep under Bubblewrap with a private network namespace, cleared environment, read-only engine/input/system mounts, no capabilities, and a temporary writable `/tmp`;
- bounds process time, generated artifact size, schema size, query output, and captured stderr;
- deletes the raw upload after processing and deletes retained artifacts on request or TTL expiry.

Rate limits and storage quotas are per service process; a multi-replica deployment will need shared accounting. Bubblewrap isolates network and filesystem access, but production deployment should still add container/cgroup CPU and memory ceilings around the service.

## Checks

```bash
bun run typecheck
bun test
```
