import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    tenantId: string;
  }
}
