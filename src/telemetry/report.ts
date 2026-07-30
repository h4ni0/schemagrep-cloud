import { resolve } from "node:path";
import { summarizeProductTelemetry } from "./product";

const requestedPath = process.argv[2] ?? process.env.PRODUCT_TELEMETRY_PATH;
if (requestedPath === undefined || requestedPath.length === 0) {
  process.stderr.write("usage: bun src/telemetry/report.ts <telemetry.jsonl>\n");
  process.exit(2);
}

const summary = await summarizeProductTelemetry(resolve(requestedPath));
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
