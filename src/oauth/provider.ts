import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Provider, { type Configuration } from "oidc-provider";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { CLI_CLIENT_ID, CLI_REDIRECT_URI, OAUTH_SCOPES } from "./constants";
import { PersistentOAuthAdapter, PersistentOAuthAdapterRepository } from "./adapter";

const SIGNING_KEY_FILENAME = "signing-key.json";

function readSigningKey(path: string): JsonWebKey {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as JsonWebKey).kty !== "RSA" ||
    typeof (parsed as JsonWebKey).n !== "string" ||
    typeof (parsed as JsonWebKey).e !== "string" ||
    typeof (parsed as JsonWebKey).d !== "string"
  ) {
    throw new Error(`Stored OAuth signing key is invalid: ${path}`);
  }
  chmodSync(path, 0o600);
  return parsed as JsonWebKey;
}

function loadOrCreateSigningKey(storageDirectory: string): JsonWebKey {
  mkdirSync(storageDirectory, { recursive: true, mode: 0o700 });
  const path = join(storageDirectory, SIGNING_KEY_FILENAME);
  try {
    return readSigningKey(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = privateKey.export({ format: "jwk" });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(jwk)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    linkSync(temporaryPath, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readSigningKey(path);
  } finally {
    unlinkSync(temporaryPath);
  }
  return jwk;
}
export interface OAuthServiceOptions {
  publicBaseUrl: string;
  cookieKey: string;
  storageDirectory: string;
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
    const jwk = loadOrCreateSigningKey(options.storageDirectory);
    const adapterRepository = new PersistentOAuthAdapterRepository(options.storageDirectory);

    const configuration: Configuration = {
      adapter: (name) => new PersistentOAuthAdapter(name, adapterRepository),
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
