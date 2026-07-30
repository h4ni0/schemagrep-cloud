#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { openAsBlob } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir, platform } from "node:os";
import { promisify } from "node:util";
import { lock } from "proper-lockfile";
import { CLI_CLIENT_ID, CLI_REDIRECT_URI, OAUTH_SCOPES } from "./oauth/constants";

const execFileAsync = promisify(execFile);
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

interface CredentialProfile {
  version: 1;
  server: string;
  issuer: string;
  clientId: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
  resource: string;
}

interface TokenSecret {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

interface Credentials extends CredentialProfile, TokenSecret {}

interface AuthorizationMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
}

function profilePath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "schemagrep", "cloud.json");
}

async function withCredentialLock<T>(operation: () => Promise<T>): Promise<T> {
  const path = profilePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const release = await lock(path, {
    realpath: false,
    lockfilePath: `${path}.lock`,
    stale: 120_000,
    update: 10_000,
    retries: {
      retries: 300,
      factor: 1,
      minTimeout: 100,
      maxTimeout: 100,
      randomize: false,
    },
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}

function normalizeServer(value: string): string {
  const url = new URL(value);
  if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) {
    throw new Error("Server URL must not contain credentials, a query, or a fragment");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("Server URL must use HTTPS, except for loopback development");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.href.replace(/\/$/u, "");
}

function validateOAuthUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  const loopback = url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !loopback) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(`${label} must use HTTPS without credentials or a fragment`);
  }
  return url.href;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function options(args: string[], name: string): string[] {
  const values: string[] = [];
  for (;;) {
    const value = option(args, name);
    if (value === undefined) return values;
    values.push(value);
  }
}

function requireArgument(value: string | undefined, usage: string): string {
  if (value === undefined) throw new Error(`Missing argument. Usage: ${usage}`);
  return value;
}

function flag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function rejectUnknownArguments(args: string[]): void {
  if (args.length > 0) throw new Error(`Unknown arguments: ${args.join(" ")}`);
}

function commandHelp(command?: string): string {
  if (command === "login") {
    return [
      "Usage: bun run cloud -- login --server URL [--no-browser] [--json]",
      "Connect through browser OAuth. --no-browser prints the URL for manual opening.",
    ].join("\n");
  }
  if (command === "files") return "Usage: bun run cloud -- files [--json]";
  if (command === "upload") return "Usage: bun run cloud -- upload PATH [--json]";
  if (command === "schema") return "Usage: bun run cloud -- schema <FILE_ID|--latest> [--json]";
  if (command === "query") {
    return [
      "Usage: bun run cloud -- query <FILE_ID|--latest> --mode MODE [options] [--json]",
      "Coordinates: --key NAME | --slot N | --col N",
      "Options: --value VALUE, --where JSON, --limit N, --template N, --request JSON",
      "Examples:",
      "  bun run cloud -- query --latest --mode count --key type --value push",
      "  bun run cloud -- query --latest --mode max --key status",
    ].join("\n");
  }
  if (command === "delete") return "Usage: bun run cloud -- delete <FILE_ID|--latest> [--json]";
  if (command === "logout") return "Usage: bun run cloud -- logout [--json]";
  return [
    "Usage: bun run cloud -- <command> [options]",
    "",
    "Commands:",
    "  login    Connect through browser OAuth",
    "  files    List active files",
    "  upload   Upload and encode a file",
    "  schema   Read a file schema",
    "  query    Run a structured query",
    "  delete   Delete an active file",
    "  logout   Revoke and remove credentials",
    "",
    "Run `bun run cloud -- help COMMAND` for command-specific help.",
  ].join("\n");
}

async function writeProfile(profile: CredentialProfile): Promise<void> {
  const path = profilePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function readProfile(): Promise<CredentialProfile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(profilePath(), "utf8"));
  } catch {
    throw new Error("Not logged in. Run: bun run cloud -- login --server https://your-server");
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("Stored cloud profile is invalid");
  const profile = parsed as Partial<CredentialProfile>;
  if (
    profile.version !== 1 ||
    typeof profile.server !== "string" ||
    typeof profile.issuer !== "string" ||
    typeof profile.clientId !== "string" ||
    typeof profile.tokenEndpoint !== "string" ||
    typeof profile.revocationEndpoint !== "string" ||
    typeof profile.resource !== "string"
  ) throw new Error("Stored cloud profile is invalid");
  const server = normalizeServer(profile.server);
  const expectedResource = `${server}/mcp`;
  if (profile.resource !== expectedResource) throw new Error("Stored cloud profile has an invalid resource");
  validateOAuthUrl(profile.issuer, "Stored OAuth issuer");
  validateOAuthUrl(profile.tokenEndpoint, "Stored OAuth token endpoint");
  validateOAuthUrl(profile.revocationEndpoint, "Stored OAuth revocation endpoint");
  return profile as CredentialProfile;
}

async function runWithSecretInput(command: string, args: string[], input: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(stderr.trim() || "Credential store rejected the token")));
    child.stdin.end(input);
  });
}

function securityInteractiveArgument(value: string): string {
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error("Credential data cannot contain line breaks");
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function keyringStore(server: string, secret: TokenSecret): Promise<void> {
  const serialized = JSON.stringify(secret);
  if (platform() === "darwin") {
    const command = [
      "add-generic-password",
      "-U",
      "-a",
      securityInteractiveArgument(server),
      "-s",
      "schemagrep-cloud",
      "-w",
      securityInteractiveArgument(serialized),
    ].join(" ");
    await runWithSecretInput("security", ["-i"], `${command}\n`);
    return;
  }
  if (platform() !== "linux") throw new Error("Secure credential storage is not supported on this platform");
  await runWithSecretInput(
    "secret-tool",
    ["store", "--label=schemagrep cloud OAuth token", "service", "schemagrep-cloud", "server", server],
    serialized,
  );
}

async function keyringRead(server: string): Promise<TokenSecret> {
  const result = platform() === "darwin"
    ? await execFileAsync("security", ["find-generic-password", "-a", server, "-s", "schemagrep-cloud", "-w"])
    : platform() === "linux"
      ? await execFileAsync("secret-tool", ["lookup", "service", "schemagrep-cloud", "server", server])
      : undefined;
  if (result === undefined) throw new Error("Secure credential storage is not supported on this platform");
  let value: unknown;
  try {
    value = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("No OAuth token was found in the OS credential store; log in again");
  }
  if (typeof value !== "object" || value === null) throw new Error("Stored OAuth token is invalid");
  const secret = value as Partial<TokenSecret>;
  if (typeof secret.accessToken !== "string" || typeof secret.expiresAt !== "number") {
    throw new Error("Stored OAuth token is invalid");
  }
  return secret as TokenSecret;
}

async function keyringDelete(server: string): Promise<void> {
  try {
    if (platform() === "darwin") {
      await execFileAsync("security", ["delete-generic-password", "-a", server, "-s", "schemagrep-cloud"]);
    } else if (platform() === "linux") {
      await execFileAsync("secret-tool", ["clear", "service", "schemagrep-cloud", "server", server]);
    }
  } catch (error) {
    const failure = error as { code?: string | number; stderr?: string };
    const missingMacItem = platform() === "darwin" &&
      (failure.code === 44 || failure.stderr?.includes("could not be found in the keychain") === true);
    if (!missingMacItem) throw error;
  }
}

async function saveCredentials(credentials: Credentials): Promise<void> {
  const { accessToken, refreshToken, expiresAt, ...profile } = credentials;
  await keyringStore(profile.server, {
    accessToken,
    expiresAt,
    ...(refreshToken === undefined ? {} : { refreshToken }),
  });
  await writeProfile(profile);
}

async function requestJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) });
  const text = await response.text();
  let body: unknown;
  try {
    body = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  }
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body
      ? JSON.stringify(body)
      : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("Server returned invalid JSON");
  return body as Record<string, unknown>;
}

async function revokeAndDeleteCredentials(profile: CredentialProfile): Promise<void> {
  const secret = await keyringRead(profile.server);
  const token = secret.refreshToken ?? secret.accessToken;
  let response: Response;
  try {
    response = await fetch(profile.revocationEndpoint, {
      signal: AbortSignal.timeout(30_000),
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token,
        token_type_hint: secret.refreshToken === undefined ? "access_token" : "refresh_token",
        client_id: profile.clientId,
      }),
    });
  } catch (error) {
    throw new Error("OAuth token revocation could not reach the server; credentials were retained", {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new Error(
      `OAuth token revocation failed (${response.status} ${response.statusText}); credentials were retained`,
    );
  }
  await keyringDelete(profile.server);
}

async function discover(server: string): Promise<{ metadata: AuthorizationMetadata; resource: string }> {
  const expectedResource = `${server}/mcp`;
  const resourceMetadata = await requestJson(`${server}/.well-known/oauth-protected-resource/mcp`);
  if (resourceMetadata.resource !== expectedResource) {
    throw new Error("Protected resource metadata does not identify this schemagrep server");
  }
  const authorizationServers = resourceMetadata.authorization_servers;
  if (!Array.isArray(authorizationServers) || typeof authorizationServers[0] !== "string") {
    throw new Error("Server did not advertise an OAuth authorization server");
  }
  const issuer = validateOAuthUrl(authorizationServers[0], "OAuth issuer").replace(/\/$/u, "");
  const issuerUrl = new URL(issuer);
  if (issuerUrl.search.length > 0) throw new Error("OAuth issuer must not contain a query");
  const metadataUrl = `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerUrl.pathname}`;
  const metadata = await requestJson(metadataUrl);
  if (
    metadata.issuer !== issuer ||
    typeof metadata.authorization_endpoint !== "string" ||
    typeof metadata.token_endpoint !== "string" ||
    typeof metadata.revocation_endpoint !== "string"
  ) {
    throw new Error("Authorization server metadata is incomplete or has an issuer mismatch");
  }
  return {
    metadata: {
      issuer,
      authorization_endpoint: validateOAuthUrl(metadata.authorization_endpoint, "OAuth authorization endpoint"),
      token_endpoint: validateOAuthUrl(metadata.token_endpoint, "OAuth token endpoint"),
      revocation_endpoint: validateOAuthUrl(metadata.revocation_endpoint, "OAuth revocation endpoint"),
    },
    resource: expectedResource,
  };
}

function launchBrowser(url: string): void {
  const command = platform() === "darwin" ? "open" : platform() === "win32" ? "rundll32.exe" : "xdg-open";
  const args = platform() === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function receiveAuthorizationCode(expectedState: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("OAuth login timed out"));
    }, LOGIN_TIMEOUT_MS);
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", CLI_REDIRECT_URI);
      if (url.pathname !== "/callback") {
        response.writeHead(404).end("Not found");
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (url.searchParams.get("state") !== expectedState || code === null || error !== null) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Authorization failed. Return to the terminal.");
        clearTimeout(timer);
        server.close();
        reject(new Error(error ?? "OAuth state validation failed"));
        return;
      }
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("schemagrep is connected. You may close this tab.");
      clearTimeout(timer);
      server.close();
      resolve(code);
    });
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not open OAuth callback on ${CLI_REDIRECT_URI}: ${error.message}`));
    });
    server.listen(47831, "127.0.0.1", () => undefined);
  });
}

async function login(serverArgument: string, openBrowser: boolean): Promise<string> {
  const server = normalizeServer(serverArgument);
  const { metadata, resource } = await discover(server);
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");
  const authorizationUrl = new URL(metadata.authorization_endpoint);
  authorizationUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: CLI_CLIENT_ID,
    redirect_uri: CLI_REDIRECT_URI,
    scope: OAUTH_SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    resource,
  }).toString();

  const codePromise = receiveAuthorizationCode(state);
  if (openBrowser) {
    console.error(`Opening ${authorizationUrl.origin} for authorization…`);
    launchBrowser(authorizationUrl.href);
  } else {
    console.error("Open this authorization URL in a browser on this computer:");
    console.log(authorizationUrl.href);
  }
  const code = await codePromise;
  const token = await requestJson(metadata.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLI_CLIENT_ID,
      redirect_uri: CLI_REDIRECT_URI,
      code,
      code_verifier: verifier,
      resource,
    }),
  });
  if (typeof token.access_token !== "string" || typeof token.expires_in !== "number") {
    throw new Error("Authorization server returned an invalid token response");
  }
  const accessToken = token.access_token;
  const expiresIn = token.expires_in;
  const refreshToken = typeof token.refresh_token === "string" ? token.refresh_token : undefined;
  await withCredentialLock(async () => {
    let previousProfile: CredentialProfile | undefined;
    try {
      previousProfile = await readProfile();
    } catch {
      // First login has no prior profile.
    }
    if (previousProfile !== undefined && previousProfile.server !== server) {
      await revokeAndDeleteCredentials(previousProfile);
    }
    await saveCredentials({
      version: 1,
      server,
      issuer: metadata.issuer,
      clientId: CLI_CLIENT_ID,
      tokenEndpoint: metadata.token_endpoint,
      revocationEndpoint: metadata.revocation_endpoint,
      resource,
      accessToken,
      expiresAt: Date.now() + expiresIn * 1000,
      ...(refreshToken === undefined ? {} : { refreshToken }),
    });
  });
  return server;
}

async function readStoredCredentials(): Promise<Credentials> {
  const profile = await readProfile();
  return { ...profile, ...await keyringRead(profile.server) };
}

async function loadCredentials(): Promise<Credentials> {
  const initial = await readStoredCredentials();
  if (initial.expiresAt > Date.now() + 30_000) return initial;
  return withCredentialLock(async () => {
    let credentials = await readStoredCredentials();
    if (credentials.expiresAt > Date.now() + 30_000) return credentials;
    if (credentials.refreshToken === undefined) {
      throw new Error("OAuth token expired and cannot be refreshed; log in again");
    }
    const token = await requestJson(credentials.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: credentials.clientId,
        refresh_token: credentials.refreshToken,
        resource: credentials.resource,
      }),
    });
    if (typeof token.access_token !== "string" || typeof token.expires_in !== "number") {
      throw new Error("Authorization server returned an invalid refresh response");
    }
    credentials = {
      ...credentials,
      accessToken: token.access_token,
      expiresAt: Date.now() + token.expires_in * 1000,
      refreshToken: typeof token.refresh_token === "string" ? token.refresh_token : credentials.refreshToken,
    };
    await saveCredentials(credentials);
    return credentials;
  });
}

async function authenticatedRequest(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const credentials = await loadCredentials();
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${credentials.accessToken}`);
  return requestJson(`${credentials.server}${path}`, { ...init, headers });
}

function parseValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function buildQuery(args: string[]): Record<string, unknown> {
  const raw = option(args, "--request");
  if (raw !== undefined) {
    const value = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("--request must be a JSON object");
    return value as Record<string, unknown>;
  }
  const mode = requireArgument(option(args, "--mode"), "query FILE_ID --mode MODE [--key NAME|--slot N|--col N]");
  const key = option(args, "--key");
  const slot = option(args, "--slot");
  const col = option(args, "--col");
  const coordinates = [key, slot, col].filter((value) => value !== undefined);
  if (coordinates.length > 1) throw new Error("Use exactly one of --key, --slot, or --col");
  const target = key !== undefined
    ? { key }
    : slot !== undefined
      ? { slot: Number(slot) }
      : col !== undefined
        ? { col: Number(col) }
        : null;
  const filters = options(args, "--where").map((value) => JSON.parse(value));
  const value = option(args, "--value");
  const limit = option(args, "--limit");
  const template = option(args, "--template");
  return {
    mode,
    target,
    filters,
    ...(value === undefined ? {} : { value: parseValue(value) }),
    ...(limit === undefined ? {} : { limit: Number(limit) }),
    ...(template === undefined ? {} : { template: Number(template) }),
  };
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Server returned an invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function fileRecords(value: unknown): Record<string, unknown>[] {
  const response = objectValue(value, "file listing");
  if (!Array.isArray(response.files)) throw new Error("Server returned an invalid file listing");
  return response.files.map((file) => objectValue(file, "file record"));
}

function requiredString(
  record: Record<string, unknown>,
  name: string,
  label: string,
): string {
  const value = record[name];
  if (typeof value !== "string") throw new Error(`Server returned an invalid ${label}`);
  return value;
}

function printFiles(response: Record<string, unknown>, json: boolean): void {
  if (json) {
    printJson(response);
    return;
  }
  const files = fileRecords(response);
  if (files.length === 0) {
    console.log("No active files.");
    return;
  }
  console.log(`Active files (${files.length}):`);
  for (const file of files) {
    const id = requiredString(file, "id", "file record");
    const name = requiredString(file, "originalName", "file record");
    const codec = requiredString(file, "codec", "file record").toUpperCase();
    const expiresAt = requiredString(file, "expiresAt", "file record");
    console.log(`  ${id}  ${name}  ${codec}  expires ${expiresAt}`);
  }
}

function printUpload(response: Record<string, unknown>, json: boolean): void {
  if (json) {
    printJson(response);
    return;
  }
  const id = requiredString(response, "id", "upload response");
  const name = requiredString(response, "originalName", "upload response");
  const expiresAt = requiredString(response, "expiresAt", "upload response");
  console.log(`Uploaded ${name}`);
  console.log(`ID: ${id}`);
  console.log(`Expires: ${expiresAt}`);
  console.log("");
  console.log("Next:");
  console.log(`  bun run cloud -- schema ${id}`);
  console.log(`  bun run cloud -- query ${id} --mode count --key FIELD --value VALUE`);
  console.log("  Or use --latest instead of the file ID.");
}

async function latestFileId(): Promise<string> {
  const files = fileRecords(await authenticatedRequest("/v1/files"));
  const latest = files[0];
  if (latest === undefined) throw new Error("No active files. Upload a file first.");
  return requiredString(latest, "id", "file record");
}

async function resolveFileArgument(args: string[], usage: string): Promise<string> {
  const latest = flag(args, "--latest");
  const explicit = args[0] !== undefined && !args[0].startsWith("--")
    ? args.shift()
    : undefined;
  if (latest && explicit !== undefined) throw new Error("Use a file ID or --latest, not both");
  if (latest) return latestFileId();
  return requireArgument(explicit, usage);
}

async function main(): Promise<void> {
  const rawArguments = process.argv.slice(2);
  if (rawArguments.some((argument) => argument.trim().length === 0)) {
    throw new Error([
      "A blank argument was received. Your shell probably broke a multiline command.",
      "Retry with the entire command on one line.",
    ].join("\n"));
  }
  const [command, ...args] = rawArguments;
  if (command === undefined || command === "--help" || command === "-h") {
    console.log(commandHelp());
    return;
  }
  if (command === "help") {
    console.log(commandHelp(args[0]));
    return;
  }
  if (flag(args, "--help") || flag(args, "-h")) {
    console.log(commandHelp(command));
    return;
  }
  const json = flag(args, "--json");
  if (command === "login") {
    const noBrowser = flag(args, "--no-browser");
    const serverArgument = option(args, "--server") ?? process.env.SCHEMAGREP_CLOUD_URL;
    rejectUnknownArguments(args);
    const server = await login(
      requireArgument(serverArgument, "login --server https://your-server"),
      !noBrowser,
    );
    if (json) {
      printJson({ connected: true, server, mcp: `${server}/mcp` });
    } else {
      console.log(`Connected to ${server}`);
      console.log("");
      console.log("Next:");
      console.log("  bun run cloud -- upload ./data.jsonl");
      console.log("  bun run cloud -- files");
      console.log(`MCP: ${server}/mcp`);
    }
  } else if (command === "logout") {
    rejectUnknownArguments(args);
    await withCredentialLock(async () => {
      await revokeAndDeleteCredentials(await readProfile());
      await rm(profilePath(), { force: true });
    });
    if (json) printJson({ loggedOut: true });
    else console.log("Logged out");
  } else if (command === "files") {
    rejectUnknownArguments(args);
    printFiles(await authenticatedRequest("/v1/files"), json);
  } else if (command === "upload") {
    const path = requireArgument(args.shift(), "upload PATH");
    rejectUnknownArguments(args);
    const form = new FormData();
    form.append("file", await openAsBlob(path), basename(path));
    const response = await authenticatedRequest("/v1/files", { method: "POST", body: form });
    printUpload(response, json);
  } else if (command === "schema") {
    const fileId = await resolveFileArgument(args, "schema <FILE_ID|--latest>");
    rejectUnknownArguments(args);
    const credentials = await loadCredentials();
    const response = await fetch(`${credentials.server}/v1/files/${encodeURIComponent(fileId)}/schema`, {
      headers: { authorization: `Bearer ${credentials.accessToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    const schema = await response.text();
    if (json) printJson({ fileId, schema });
    else process.stdout.write(schema);
  } else if (command === "query") {
    const fileId = await resolveFileArgument(args, "query <FILE_ID|--latest> --mode MODE [options]");
    const request = buildQuery(args);
    rejectUnknownArguments(args);
    const response = await authenticatedRequest(`/v1/files/${encodeURIComponent(fileId)}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    if (json) {
      printJson(response);
    } else {
      const answer = response.answer;
      if (typeof answer !== "string") throw new Error("Server returned an invalid query response");
      console.log(`Answer: ${answer}`);
    }
  } else if (command === "delete") {
    const fileId = await resolveFileArgument(args, "delete <FILE_ID|--latest>");
    rejectUnknownArguments(args);
    await authenticatedRequest(`/v1/files/${encodeURIComponent(fileId)}`, { method: "DELETE" });
    if (json) printJson({ deleted: true, fileId });
    else console.log(`Deleted ${fileId}`);
  } else {
    console.error(commandHelp());
    process.exitCode = 2;
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
