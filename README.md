# schemagrep-cloud

Ephemeral HTTP API around [schemagrep](https://github.com/hshei/schemagrep). It accepts CSV, JSON, JSONL, and log files, retains the encoded artifact and schema for a short TTL, and deletes the raw upload immediately after processing.

Natural-language model calls and structured query routes are not implemented yet. No model key is needed for the current upload/schema API.

## Prerequisites

- Bun 1.3 or newer
- C compiler and `make`
- `pkg-config`
- PCRE2 development headers (`pcre2` on Arch, `libpcre2-dev` on Debian/Ubuntu)

## Clone and run

```bash
git clone --recurse-submodules https://github.com/h4ni0/schemagrep-cloud.git
cd schemagrep-cloud
bun install
bun run setup-engine
bun src/server.ts
```

For an existing clone:

```bash
git pull
git submodule update --init --recursive
bun install
bun run setup-engine
bun src/server.ts
```

The service uses the bundled `vendor/schemagrep/schemagrep` binary by default. To use another build, provide its explicit path:

```bash
SCHEMAGREP_BIN=/absolute/path/to/hshei/schemagrep bun src/server.ts
```

Startup rejects missing, non-executable, or unrelated binaries before the API begins listening.

## Upload a JSONL file

```bash
UPLOAD=$(
  curl -sS \
    -F "file=@vendor/schemagrep/samples/jsonl/qtest.jsonl" \
    http://127.0.0.1:3000/v1/files
)

echo "$UPLOAD" | jq
FILE_ID=$(jq -r '.id' <<< "$UPLOAD")
```

Read metadata and schema:

```bash
curl -sS "http://127.0.0.1:3000/v1/files/$FILE_ID" | jq
curl -sS "http://127.0.0.1:3000/v1/files/$FILE_ID/schema"
```

Delete the retained artifact:

```bash
curl -i -X DELETE "http://127.0.0.1:3000/v1/files/$FILE_ID"
```

## Routes

```text
GET    /health
POST   /v1/files
GET    /v1/files/{id}
GET    /v1/files/{id}/schema
DELETE /v1/files/{id}
```

The upload field must be named `file`. Supported filename extensions are `.csv`, `.json`, `.jsonl`, `.ndjson`, `.log`, and `.txt`.

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
| `STORAGE_DIR` | system temporary directory |
| `SCHEMAGREP_BIN` | bundled engine binary |

The byte fields returned in metadata are diagnostic measurements, not compression guarantees.

## Checks

```bash
bun run typecheck
bun test
```
