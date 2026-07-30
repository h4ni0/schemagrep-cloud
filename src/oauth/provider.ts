import { generateKeyPairSync, randomUUID } from "node:crypto";
import Provider, {
  type Adapter,
  type AdapterPayload,
  type Configuration,
} from "oidc-provider";
import type { AuthInfo } from "@modelcontextprotocol/server";

export const OAUTH_SCOPES = ["files:read", "files:write", "files:delete"] as const;
export const CLI_CLIENT_ID = "schemagrep-cli";
export const CLI_REDIRECT_URI = "http://127.0.0.1:47831/callback";

interface StoredModel {
  payload: AdapterPayload;
  createdAt: number;
  expiresAt: number;
  activeClient?: boolean;
  accountId?: string;
  lastActiveAt?: number;
}

const models = new Map<string, Map<string, StoredModel>>();
const MAX_PENDING_CLIENTS = 100;
const MAX_ACTIVE_CLIENTS_PER_ACCOUNT = 20;
const MAX_MODEL_RECORDS = 5000;
const MAX_OWNER_RECORDS = 500;
const PENDING_CLIENT_TTL_SECONDS = 60 * 60;
const ACTIVE_CLIENT_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_MODEL_TTL_SECONDS = 60 * 60;

function modelStore(name: string): Map<string, StoredModel> {
  let store = models.get(name);
  if (store === undefined) {
    store = new Map();
    models.set(name, store);
  }
  return store;
}

export class EphemeralOAuthAdapter implements Adapter {
  private readonly store: Map<string, StoredModel>;
  private readonly modelName: string;
  private readonly namespace: string;

  constructor(name: string) {
    this.store = modelStore(name);
    const separator = name.lastIndexOf(":");
    this.namespace = separator < 0 ? "" : name.slice(0, separator + 1);
    this.modelName = name.slice(separator + 1);
  }

  async upsert(id: string, payload: AdapterPayload, expiresIn: number): Promise<void> {
    const now = Date.now();
    this.pruneExpired(now);
    const existing = this.store.get(id);
    if (existing === undefined) this.makeRoom(payload);
    const dynamicClient = this.modelName === "Client";
    const ttlSeconds = expiresIn ??
      (dynamicClient
        ? existing?.activeClient === true ? ACTIVE_CLIENT_TTL_SECONDS : PENDING_CLIENT_TTL_SECONDS
        : DEFAULT_MODEL_TTL_SECONDS);
    this.store.set(id, {
      payload: structuredClone(payload),
      createdAt: existing?.createdAt ?? now,
      expiresAt: now + ttlSeconds * 1000,
      ...(existing?.activeClient === true ? { activeClient: true } : {}),
      ...(existing?.accountId === undefined ? {} : { accountId: existing.accountId }),
      ...(existing?.lastActiveAt === undefined ? {} : { lastActiveAt: existing.lastActiveAt }),
    });
    if (this.recordsClientActivity(payload)) {
      this.markClientActive(
        String(payload.clientId),
        now,
        typeof payload.accountId === "string" ? payload.accountId : undefined,
      );
    }
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    const record = this.store.get(id);
    if (record === undefined) return undefined;
    const now = Date.now();
    if (record.expiresAt <= now) {
      this.store.delete(id);
      return undefined;
    }
    if (this.recordsClientActivity(record.payload)) {
      this.markClientActive(
        String(record.payload.clientId),
        now,
        typeof record.payload.accountId === "string" ? record.payload.accountId : undefined,
      );
    }
    return structuredClone(record.payload);
  }

  async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    return this.findBy("userCode", userCode);
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    return this.findBy("uid", uid);
  }

  async consume(id: string): Promise<void> {
    const record = this.store.get(id);
    if (record !== undefined) record.payload.consumed = Math.floor(Date.now() / 1000);
  }

  async destroy(id: string): Promise<void> {
    this.store.delete(id);
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    for (const [id, record] of this.store) {
      if (record.payload.grantId === grantId) this.store.delete(id);
    }
  }

  private makeRoom(payload: AdapterPayload): void {
    if (this.modelName === "Client") {
      while (this.countRecords(this.store, (record) => record.activeClient !== true) >= MAX_PENDING_CLIENTS) {
        this.evictOldest((record) => record.activeClient !== true);
      }
      return;
    }
    const owner = typeof payload.accountId === "string"
      ? `account:${payload.accountId}`
      : typeof payload.clientId === "string"
        ? `client:${payload.clientId}`
        : undefined;
    if (owner !== undefined) {
      const owned = (record: StoredModel): boolean => {
        const recordOwner = typeof record.payload.accountId === "string"
          ? `account:${record.payload.accountId}`
          : typeof record.payload.clientId === "string"
            ? `client:${record.payload.clientId}`
            : undefined;
        return recordOwner === owner;
      };
      while (this.countRecords(this.store, owned) >= MAX_OWNER_RECORDS) {
        this.evictOldest(owned);
      }
    }
    while (this.store.size >= MAX_MODEL_RECORDS) this.evictOldest(() => true);
  }

  private countRecords(
    store: Map<string, StoredModel>,
    predicate: (record: StoredModel) => boolean,
  ): number {
    let count = 0;
    for (const record of store.values()) {
      if (predicate(record)) count += 1;
    }
    return count;
  }

  private evictOldest(predicate: (record: StoredModel) => boolean): void {
    let oldest: { id: string; createdAt: number } | undefined;
    for (const [id, record] of this.store) {
      if (!predicate(record)) continue;
      if (oldest === undefined || record.createdAt < oldest.createdAt) {
        oldest = { id, createdAt: record.createdAt };
      }
    }
    if (oldest !== undefined) this.store.delete(oldest.id);
  }

  private evictLeastRecentlyActive(
    clients: Map<string, StoredModel>,
    predicate: (record: StoredModel) => boolean,
  ): void {
    let leastRecent: { id: string; timestamp: number } | undefined;
    for (const [id, record] of clients) {
      if (!predicate(record)) continue;
      const timestamp = record.lastActiveAt ?? record.createdAt;
      if (leastRecent === undefined || timestamp < leastRecent.timestamp) {
        leastRecent = { id, timestamp };
      }
    }
    if (leastRecent !== undefined) clients.delete(leastRecent.id);
  }

  private markClientActive(clientId: string, now: number, accountId: string | undefined): void {
    const clients = modelStore(`${this.namespace}Client`);
    for (const [id, record] of clients) {
      if (record.expiresAt <= now) clients.delete(id);
    }
    const client = clients.get(clientId);
    if (client === undefined) return;
    const owner = accountId ?? client.accountId ?? "unknown";
    if (client.activeClient !== true) {
      const sameAccount = (record: StoredModel): boolean =>
        record.activeClient === true && (record.accountId ?? "unknown") === owner;
      while (this.countRecords(clients, sameAccount) >= MAX_ACTIVE_CLIENTS_PER_ACCOUNT) {
        this.evictLeastRecentlyActive(clients, sameAccount);
      }
    }
    client.activeClient = true;
    client.accountId = owner;
    client.lastActiveAt = now;
    client.expiresAt = now + ACTIVE_CLIENT_TTL_SECONDS * 1000;
  }

  private recordsClientActivity(payload: AdapterPayload): boolean {
    return typeof payload.clientId === "string" &&
      ["AuthorizationCode", "AccessToken", "RefreshToken"].includes(this.modelName);
  }

  private pruneExpired(now: number): void {
    for (const [id, record] of this.store) {
      if (record.expiresAt <= now) this.store.delete(id);
    }
  }

  private async findBy(field: "uid" | "userCode", value: string): Promise<AdapterPayload | undefined> {
    const now = Date.now();
    this.pruneExpired(now);
    for (const record of this.store.values()) {
      if (record.payload[field] !== value) continue;
      if (this.recordsClientActivity(record.payload)) {
        this.markClientActive(
          String(record.payload.clientId),
          now,
          typeof record.payload.accountId === "string" ? record.payload.accountId : undefined,
        );
      }
      return structuredClone(record.payload);
    }
    return undefined;
  }
}

export interface OAuthServiceOptions {
  publicBaseUrl: string;
  cookieKey: string;
}

export class OAuthService {
  readonly issuer: string;
  readonly resourceUrl: string;
  readonly resourceMetadataUrl: string;
  readonly provider: Provider;

  constructor(options: OAuthServiceOptions) {
    const baseUrl = options.publicBaseUrl.replace(/\/+$/u, "");
    this.issuer = `${baseUrl}/oauth`;
    this.resourceUrl = `${baseUrl}/mcp`;
    this.resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource/mcp`;
    const secureCookies = new URL(baseUrl).protocol === "https:";
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = privateKey.export({ format: "jwk" });
    const adapterNamespace = randomUUID();

    const configuration: Configuration = {
      adapter: (name) => new EphemeralOAuthAdapter(`${adapterNamespace}:${name}`),
      clients: [
        {
          client_id: CLI_CLIENT_ID,
          client_name: "schemagrep terminal",
          redirect_uris: [CLI_REDIRECT_URI],
          response_types: ["code"],
          grant_types: ["authorization_code", "refresh_token"],
          token_endpoint_auth_method: "none",
        },
      ],
      cookies: {
        keys: [options.cookieKey],
        long: { httpOnly: true, sameSite: "lax", secure: secureCookies },
        short: { httpOnly: true, sameSite: "lax", secure: secureCookies },
      },
      features: {
        devInteractions: { enabled: false },
        registration: {
          enabled: true,
          issueRegistrationAccessToken: false,
        },
        revocation: {
          enabled: true,
          allowedPolicy: (_ctx, client, token) => token.clientId === client.clientId,
        },
        resourceIndicators: {
          enabled: true,
          defaultResource: () => this.resourceUrl,
          useGrantedResource: () => true,
          getResourceServerInfo: (_ctx, resourceIndicator) => {
            if (resourceIndicator !== this.resourceUrl) throw new Error("Unknown resource indicator");
            return {
              scope: OAUTH_SCOPES.join(" "),
              audience: this.resourceUrl,
              accessTokenFormat: "opaque",
              accessTokenTTL: 3600,
            };
          },
        },
      },
      interactions: {
        url: (_ctx, interaction) => `/oauth-login/${encodeURIComponent(interaction.uid)}`,
      },
      pkce: { required: () => true },
      scopes: [...OAUTH_SCOPES],
      responseTypes: ["code"],
      issueRefreshToken: (_ctx, client) => client.grantTypeAllowed("refresh_token"),
      rotateRefreshToken: true,
      ttl: {
        AccessToken: 3600,
        AuthorizationCode: 60,
        Grant: 30 * 24 * 60 * 60,
        RefreshToken: 30 * 24 * 60 * 60,
        Interaction: 10 * 60,
        Session: 30 * 24 * 60 * 60,
      },
      findAccount: (_ctx, accountId) => Promise.resolve({
        accountId,
        claims: () => Promise.resolve({ sub: accountId }),
      }),
      jwks: {
        keys: [{ ...jwk, kid: "schemagrep-oauth", use: "sig", alg: "RS256" }],
      },
    };

    this.provider = new Provider(this.issuer, configuration);
    this.provider.proxy = true;
  }

  metadata(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/auth`,
      token_endpoint: `${this.issuer}/token`,
      registration_endpoint: `${this.issuer}/reg`,
      revocation_endpoint: `${this.issuer}/token/revocation`,
      jwks_uri: `${this.issuer}/jwks`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [...OAUTH_SCOPES],
    };
  }

  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.resourceUrl,
      authorization_servers: [this.issuer],
      scopes_supported: [...OAUTH_SCOPES],
      resource_name: "schemagrep cloud",
    };
  }

  async verifyAccessToken(tokenValue: string): Promise<AuthInfo | undefined> {
    const token = await this.provider.AccessToken.find(tokenValue);
    if (
      token === undefined ||
      token.accountId === undefined ||
      token.exp === undefined ||
      token.exp <= Math.floor(Date.now() / 1000)
    ) {
      return undefined;
    }
    return {
      token: "[validated-and-redacted]",
      clientId: token.accountId,
      scopes: token.scope?.split(" ").filter(Boolean) ?? [],
      expiresAt: token.exp,
    };
  }
}
