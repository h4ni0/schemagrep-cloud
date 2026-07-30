# schemagrep-cloud

Ephemeral HTTP API around [schemagrep](https://github.com/hshei/schemagrep). It accepts CSV, JSON, JSONL, and log files, retains the encoded artifact and schema for a short TTL, executes bounded structured queries, and deletes the raw upload immediately after processing.

Hosted model calls are not implemented. Customer-owned models connect through the authenticated MCP endpoint and pay their own model provider; schemagrep-cloud never receives a model-provider credential.

## Prerequisites

- Node.js 22 LTS or newer
- Bun 1.3 or newer (package installation and test runner)
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
SCHEMAGREP_API_KEYS="{\"local\":\"$API_KEY\"}" bun run start
```

For an existing clone:

```bash
git pull
git submodule update --init --recursive
bun install
bun run setup-engine
export API_KEY="$(openssl rand -hex 32)"
echo "Local API key: $API_KEY"
SCHEMAGREP_API_KEYS="{\"local\":\"$API_KEY\"}" bun run start
```

The service uses the bundled `vendor/schemagrep/schemagrep` binary by default. To use another build, provide its explicit path:

```bash
SCHEMAGREP_BIN=/absolute/path/to/hshei/schemagrep bun run start
```

Startup rejects missing, non-executable, or unrelated binaries before the API begins listening.

## Private beta dashboard

Open `http://127.0.0.1:3000/` in a browser. The dashboard is public static
HTML/CSS/JavaScript; it stores the invite key only in the current tab's memory.
After unlocking, a user can upload a file, inspect active datasets and retained
storage, see upload/query/MCP usage, copy a `file_...` ID and hosted MCP
configuration, copy a starter question, inspect expiry, or delete an artifact.
Uploads, schemas, queries, deletion, and MCP remain bearer-authenticated.

The dashboard is an upload, lifecycle, and usage surface—not a chat product.
Customer-owned model clients perform inference and send only structured
schema/query tool calls to this service.

## Terminal cloud workflow

When OAuth is enabled, authenticate once with the invite key in a browser. Access
and refresh tokens are stored in the OS credential store (`secret-tool` on
Linux, Keychain on macOS); the invite key is never copied into client settings.

```bash
bun run cloud -- login --server https://beta.example.com
bun run cloud -- upload ./events.jsonl
bun run cloud -- files
bun run cloud -- schema file_...
bun run cloud -- query file_... --mode count --key type --value push
bun run cloud -- query file_... --mode rows
bun run cloud -- delete file_...
```

Advanced queries may use `--request '{"mode":...}'`; repeat `--where` with one
JSON filter object per predicate. The CLI refreshes expired access tokens
automatically. The website is not involved after authorization.

The direct bearer-key REST examples below remain available for operators and
local debugging.

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
exact string, finite-number, or null values; `gt`, `ge`, `lt`, and `le` take
numbers; `between` takes a two-number array.

`grep` always has a bounded `limit` from 1 to 100 (default 20). Its response
contains `records`, `recordCount`, and an exact `truncated` flag. Other modes
return their schemagrep result in `answer`.

## Connect a customer-owned model through MCP

With OAuth enabled, configure only the remote Streamable HTTP endpoint:

```json
{
  "mcpServers": {
    "schemagrep": {
      "type": "http",
      "url": "https://beta.example.com/mcp"
    }
  }
}
```

The MCP client discovers OAuth from the initial `401`, opens browser
authorization with PKCE, and refreshes its access token. It must support Remote
Streamable HTTP MCP and OAuth custom authorization; clients that accept only a
URL and do not implement MCP OAuth cannot connect. Static bearer headers remain
supported for local/operator use.

The endpoint supports the current 2026 Streamable HTTP protocol and the
stateless 2025 fallback. It exposes three read-only tools:

| Tool | Purpose |
|---|---|
| `schemagrep_list_files` | List the tenant's active uploads so the model can resolve a filename to a file ID |
| `schemagrep_get_schema` | Read a tenant-owned file's schema and query primer |
| `schemagrep_query` | Execute the same validated, bounded contract as the REST query endpoint |

Upload from the dashboard or terminal CLI, then ask about the file by name or
ID. Tool instructions make the model list files when needed, read the selected
schema once, and never infer a total from limited grep evidence. The customer's
model account pays for inference; schemagrep-cloud pays no model-provider cost.

Delete the retained artifact:

```bash
curl -i -X DELETE -H "Authorization: Bearer $API_KEY" "http://127.0.0.1:3000/v1/files/$FILE_ID"
```

## Routes

```text
GET    /
GET    /assets/dashboard.css
GET    /assets/dashboard.js
GET    /health
GET    /v1/session
GET    /v1/usage
GET    /v1/files
POST   /v1/files
GET    /v1/files/{id}
GET    /v1/files/{id}/schema
POST   /v1/files/{id}/query
DELETE /v1/files/{id}
POST   /v1/feedback
GET/POST/DELETE /mcp
GET    /.well-known/oauth-protected-resource/mcp
GET    /.well-known/oauth-authorization-server/oauth
GET/POST /oauth/*
```

The upload field must be named `file`. Supported filename extensions are `.csv`, `.json`, `.jsonl`, `.ndjson`, `.log`, and `.txt`.

The dashboard and OAuth discovery/interaction routes and `GET /health` are public. Data, session, usage, feedback, and MCP routes require a valid static API key or OAuth access token.

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
| `PUBLIC_BASE_URL` | disabled; public HTTPS origin that enables OAuth, e.g. `https://beta.example.com` |
| `OAUTH_COOKIE_KEY` | required with `PUBLIC_BASE_URL`; random 32–512 byte cookie-signing secret |
| `RATE_LIMIT_MAX` | `60` requests per tenant or unauthenticated IP |
| `RATE_LIMIT_WINDOW_MS` | `60000` |
| `TRUSTED_PROXY_CLIENT_IP_HEADER` | disabled; dedicated client-IP header overwritten by the loopback reverse proxy |
| `MAX_TENANT_STORAGE_BYTES` | `536870912` retained artifact + schema bytes |
| `WORKER_SANDBOX` | `bwrap`; set `disabled` only for isolated local development |
| `BWRAP_BIN` | `/usr/bin/bwrap` |
| `MCP_ALLOWED_HOSTS` | `HOST`, `localhost`, `127.0.0.1`, and `[::1]`; comma-separated hostnames |
| `PRODUCT_TELEMETRY_PATH` | disabled; local JSONL event path when configured |
| `PRODUCT_TELEMETRY_HASH_KEY` | required with telemetry path; 32–512 byte secret |
| `FEEDBACK_PATH` | disabled; local JSONL path for explicitly consented feedback |
| `FEEDBACK_RETENTION_DAYS` | `30` when feedback is enabled; range 1–365 |

## Invite-only deployment operations

Use a single private instance behind a TLS reverse proxy. Keep the Node service
bound to `127.0.0.1`; only the proxy should be internet-facing. Configure the
proxy to overwrite one dedicated client-IP header, then name that header in
`TRUSTED_PROXY_CLIENT_IP_HEADER`; never forward a client-supplied value. Set the
public hostname in `MCP_ALLOWED_HOSTS`, configure `PUBLIC_BASE_URL`, retain the
default Bubblewrap sandbox, and place `STORAGE_DIR`,
`PRODUCT_TELEMETRY_PATH`, and `FEEDBACK_PATH` on private server storage.

Example environment:

```bash
export BETA_KEY="$(openssl rand -hex 32)"
export TELEMETRY_HASH_KEY="$(openssl rand -hex 32)"
export OAUTH_COOKIE_KEY="$(openssl rand -hex 32)"
export SCHEMAGREP_API_KEYS="$(jq -nc --arg key "$BETA_KEY" '{"invite-001":$key}')"
export HOST=127.0.0.1
export PORT=3000
export PUBLIC_BASE_URL=https://beta.example.com
export MCP_ALLOWED_HOSTS=beta.example.com
export TRUSTED_PROXY_CLIENT_IP_HEADER=cf-connecting-ip # Cloudflare overwrites this header
export STORAGE_DIR=/var/lib/schemagrep-beta/files
export PRODUCT_TELEMETRY_PATH=/var/lib/schemagrep-beta/product-events.jsonl
export PRODUCT_TELEMETRY_HASH_KEY="$TELEMETRY_HASH_KEY"
export FEEDBACK_PATH=/var/lib/schemagrep-beta/feedback.jsonl
export FEEDBACK_RETENTION_DAYS=30
bun run start
```

Create one unique 32-byte-or-longer secret per invitee. Deliver it privately.
To revoke or rotate access, remove or replace that tenant's entry in
`SCHEMAGREP_API_KEYS` and restart the service. Do not share one key between
users: tenant isolation, quotas, and activation measurement depend on unique
tenant IDs.

Before issuing invites:

1. Terminate TLS at the reverse proxy and reject plaintext public traffic.
2. Confirm `GET /health` through the public hostname.
3. Upload, schema-read, query, and delete one fixture through the dashboard and
   the public `/mcp` endpoint.
4. Confirm an invalid key and cross-tenant file ID both receive the same
   non-enumerating failure.
5. Confirm the raw upload disappears after encoding and the retained artifact
   disappears after explicit deletion and after `FILE_TTL_SECONDS`.
6. Keep host/container CPU, memory, and disk limits around the Bun process in
   addition to Bubblewrap.

Product telemetry is opt-in and local to the service. It records only day,
HMAC-pseudonymous tenant, action, outcome, HTTP status class, latency bucket,
and query mode. It never records filenames, paths, schemas, records, query
values, file IDs, IP addresses, or model prompts. Inspect aggregate demand with:

```bash
bun run telemetry:report /var/lib/schemagrep-beta/product-events.jsonl
```

The dashboard's feedback form is separate and explicitly opt-in. It requires a
checked consent control before accepting the AI client, natural-language
question, outcome, and optional expected answer or notes. It never attaches a
tenant, file ID, filename, schema, source record, or structured query. Active
entries expire after `FEEDBACK_RETENTION_DAYS`; the next submission removes
expired entries from the local file. Inspect the active consented entries with:

```bash
bun run feedback:report /var/lib/schemagrep-beta/feedback.jsonl
```

For this beta, the meaningful activation signals are successful uploads,
schema/MCP/query use, and `repeatUploadTenants`. A second real dataset from the
same invitee is stronger evidence than account creation or a page view.

The byte fields returned in metadata are diagnostic measurements, not compression guarantees.

## Security boundary

The current API:

- supports MCP OAuth discovery, authorization-code PKCE, dynamic client registration, scoped opaque access tokens, rotating refresh tokens, and browser consent;
- keeps OAuth grants and tokens process-local, so a restart revokes active OAuth sessions by design for this ephemeral beta;
- retains hashed static bearer-key comparison for dashboard access, operators, and local clients;
- never gives the MCP client the invite key; the terminal CLI stores OAuth tokens in the OS credential store;
- scopes file reads, queries, and deletion to the tenant that uploaded the file and enforces `files:read`, `files:write`, and `files:delete`;
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
- accepts natural-language feedback only after explicit consent, stores no dataset or tenant identifier with it, and removes expired entries;
- deletes the raw upload after processing and deletes retained artifacts on request or TTL expiry.

Rate limits and storage quotas are per service process; a multi-replica deployment will need shared accounting. Bubblewrap isolates network and filesystem access, but production deployment should still add container/cgroup CPU and memory ceilings around the service.

## Checks

```bash
bun run typecheck
bun test
```
