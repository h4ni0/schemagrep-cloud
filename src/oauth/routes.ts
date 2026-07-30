import type { FastifyInstance, FastifyReply } from "fastify";
import formbody from "@fastify/formbody";
import { ApiKeyAuthenticator } from "../security/auth";
import type { OAuthService } from "./provider";

interface OAuthRouteOptions {
  oauth: OAuthService;
  inviteAuthenticator: ApiKeyAuthenticator;
}

interface InteractionParams {
  uid: string;
}

interface InteractionBody {
  action?: string;
  betaKey?: string;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function oauthPage(reply: FastifyReply, title: string, body: string, statusCode = 200): FastifyReply {
  return reply
    .code(statusCode)
    .headers({
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    })
    .type("text/html; charset=utf-8")
    .send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · schemagrep</title><style>
:root{color-scheme:dark}body{font-family:system-ui,sans-serif;background:#101114;color:#f5f5f5;margin:0;min-height:100vh;display:grid;place-items:center}.card{width:min(32rem,calc(100% - 3rem));padding:2rem;border:1px solid #34363d;border-radius:1rem;background:#191b20}h1{margin-top:0}p{color:#b9bdc7;line-height:1.5}label{display:block;margin:.75rem 0 .4rem}input{box-sizing:border-box;width:100%;padding:.8rem;border:1px solid #484b55;border-radius:.5rem;background:#111217;color:#fff}button{margin-top:1rem;padding:.75rem 1rem;border:0;border-radius:.5rem;background:#e8ff65;color:#111;font-weight:700;cursor:pointer}.secondary{margin-left:.5rem;background:#30333b;color:#fff}.error{color:#ff8b8b}.scopes{padding-left:1.25rem;color:#d9dce3}
</style></head><body><main class="card">${body}</main></body></html>`);
}

export async function registerOAuthRoutes(
  app: FastifyInstance,
  options: OAuthRouteOptions,
): Promise<void> {
  await app.register(formbody);

  const resourceMetadata = options.oauth.protectedResourceMetadata();
  const authorizationMetadata = options.oauth.metadata();
  for (const path of [
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-protected-resource",
  ]) {
    app.get(path, async (_request, reply) => reply
      .header("access-control-allow-origin", "*")
      .header("cache-control", "public, max-age=300")
      .send(resourceMetadata));
  }
  app.get("/.well-known/oauth-authorization-server/oauth", async (_request, reply) => reply
    .header("access-control-allow-origin", "*")
    .header("cache-control", "public, max-age=300")
    .send(authorizationMetadata));

  app.get<{ Params: InteractionParams }>("/oauth-login/:uid", async (request, reply) => {
    const details = await options.oauth.provider.interactionDetails(request.raw, reply.raw);
    const clientId = String(details.params.client_id ?? "unknown client");
    const client = await options.oauth.provider.Client.find(clientId);
    const clientName = client?.clientName ?? clientId;

    if (details.prompt.name === "login") {
      return oauthPage(reply, "Authorize", `
<h1>Connect ${escapeHtml(clientName)}</h1>
<p>Enter your schemagrep invite key once. The client receives a limited OAuth token; it never receives the invite key.</p>
<form method="post" action="/oauth-login/${encodeURIComponent(request.params.uid)}">
<input type="hidden" name="action" value="login">
<label for="beta-key">Beta invite key</label>
<input id="beta-key" name="betaKey" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Continue</button>
</form>`);
    }

    if (details.prompt.name === "consent") {
      const scopes = String(details.params.scope ?? "files:read").split(" ").filter(Boolean);
      return oauthPage(reply, "Approve access", `
<h1>Approve ${escapeHtml(clientName)}</h1>
<p>This client is requesting access to your ephemeral schemagrep workspace:</p>
<ul class="scopes">${scopes.map((scope) => `<li>${escapeHtml(scope)}</li>`).join("")}</ul>
<form method="post" action="/oauth-login/${encodeURIComponent(request.params.uid)}">
<button type="submit" name="action" value="consent">Authorize</button>
<button class="secondary" type="submit" name="action" value="deny">Deny</button>
</form>`);
    }

    return oauthPage(reply, "Unsupported request", "<h1>Authorization could not continue</h1><p class=\"error\">Unsupported OAuth interaction.</p>", 400);
  });

  app.post<{ Params: InteractionParams; Body: InteractionBody }>(
    "/oauth-login/:uid",
    async (request, reply) => {
      const details = await options.oauth.provider.interactionDetails(request.raw, reply.raw);
      if (request.body.action === "deny") {
        reply.hijack();
        await options.oauth.provider.interactionFinished(
          request.raw,
          reply.raw,
          { error: "access_denied", error_description: "The user denied access" },
          { mergeWithLastSubmission: false },
        );
        return;
      }

      if (details.prompt.name === "login" && request.body.action === "login") {
        const tenantId = options.inviteAuthenticator.authenticate(
          request.body.betaKey === undefined ? undefined : `Bearer ${request.body.betaKey}`,
        );
        if (tenantId === undefined) {
          return oauthPage(reply, "Authorize", `
<h1>Invite key rejected</h1><p class="error">The invite key is missing, invalid, or revoked.</p>
<form method="post" action="/oauth-login/${encodeURIComponent(request.params.uid)}">
<input type="hidden" name="action" value="login"><label for="beta-key">Beta invite key</label>
<input id="beta-key" name="betaKey" type="password" required autofocus><button type="submit">Try again</button></form>`, 401);
        }
        reply.hijack();
        await options.oauth.provider.interactionFinished(
          request.raw,
          reply.raw,
          { login: { accountId: tenantId, acr: "urn:schemagrep:invite", amr: ["pwd"] } },
          { mergeWithLastSubmission: false },
        );
        return;
      }

      if (details.prompt.name === "consent" && request.body.action === "consent") {
        const accountId = details.session?.accountId;
        if (accountId === undefined) return oauthPage(reply, "Session expired", "<h1>Session expired</h1><p>Restart the connection from your client.</p>", 400);
        let grantId = details.grantId;
        const grant = grantId === undefined
          ? new options.oauth.provider.Grant({ accountId, clientId: String(details.params.client_id) })
          : await options.oauth.provider.Grant.find(grantId);
        if (grant === undefined) return oauthPage(reply, "Session expired", "<h1>Session expired</h1><p>Restart the connection from your client.</p>", 400);

        const promptDetails = details.prompt.details as {
          missingOIDCScope?: string[];
          missingOIDCClaims?: string[];
          missingResourceScopes?: Record<string, string[]>;
        };
        if (promptDetails.missingOIDCScope !== undefined) {
          grant.addOIDCScope(promptDetails.missingOIDCScope.join(" "));
        }
        if (promptDetails.missingOIDCClaims !== undefined) grant.addOIDCClaims(promptDetails.missingOIDCClaims);
        for (const [resource, scopes] of Object.entries(promptDetails.missingResourceScopes ?? {})) {
          grant.addResourceScope(resource, scopes.join(" "));
        }
        grantId = await grant.save();
        reply.hijack();
        await options.oauth.provider.interactionFinished(
          request.raw,
          reply.raw,
          { consent: details.grantId === undefined ? { grantId } : {} },
          { mergeWithLastSubmission: true },
        );
        return;
      }

      return oauthPage(reply, "Invalid request", "<h1>Authorization could not continue</h1><p class=\"error\">Invalid interaction submission.</p>", 400);
    },
  );

}
