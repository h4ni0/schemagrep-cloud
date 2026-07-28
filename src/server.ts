import { buildApp } from "./app";
import { loadConfig } from "./config";
import { assertSchemagrepBinary, assertWorkerSandbox } from "./schemagrep/probe";

const config = loadConfig();
await assertSchemagrepBinary(config.schemagrepBinary);
await assertWorkerSandbox(config.workerSandbox, config.bubblewrapBinary);
const app = buildApp({ config, logger: true });

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "Shutting down");

  try {
    await app.close();
  } catch (error) {
    app.log.error(error, "Shutdown failed");
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
