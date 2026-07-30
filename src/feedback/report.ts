import { resolve } from "node:path";
import { readActiveFeedback } from "./store";

const requestedPath = process.argv[2] ?? process.env.FEEDBACK_PATH;
if (requestedPath === undefined || requestedPath.length === 0) {
  process.stderr.write("usage: bun src/feedback/report.ts <feedback.jsonl>\n");
  process.exit(2);
}

const entries = await readActiveFeedback(resolve(requestedPath));
process.stdout.write(`${JSON.stringify({ activeFeedback: entries.length, entries }, null, 2)}\n`);
