import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply } from "fastify";

const [dashboardHtml, dashboardCss, dashboardJavaScript] = await Promise.all([
  readFile(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8"),
  readFile(fileURLToPath(new URL("./dashboard.css", import.meta.url)), "utf8"),
  readFile(fileURLToPath(new URL("./dashboard.js", import.meta.url)), "utf8"),
]);

function secureBrowserResponse(reply: FastifyReply): FastifyReply {
  return reply.headers({
    "content-security-policy": "default-src 'none'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; script-src 'self'; style-src 'self'",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), geolocation=(), microphone=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
}

export async function registerDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (_request, reply) => secureBrowserResponse(reply)
    .header("cache-control", "no-store")
    .type("text/html; charset=utf-8")
    .send(dashboardHtml));

  app.get("/assets/dashboard.css", async (_request, reply) => secureBrowserResponse(reply)
    .header("cache-control", "no-store")
    .type("text/css; charset=utf-8")
    .send(dashboardCss));

  app.get("/assets/dashboard.js", async (_request, reply) => secureBrowserResponse(reply)
    .header("cache-control", "no-store")
    .type("text/javascript; charset=utf-8")
    .send(dashboardJavaScript));
}
