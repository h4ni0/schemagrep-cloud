import "fastify";
import type { AuthInfo } from "@modelcontextprotocol/server";

declare module "fastify" {
  interface FastifyRequest {
    tenantId: string;
    authInfo: AuthInfo | null;
  }
}
