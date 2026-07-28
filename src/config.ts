export interface ServiceConfig {
  host: string;
  port: number;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 3000;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT must be an integer from 1 to 65535; received ${value}`);
  }

  return port;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  return {
    host: env.HOST ?? "127.0.0.1",
    port: parsePort(env.PORT),
  };
}
