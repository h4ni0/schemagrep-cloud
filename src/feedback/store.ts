import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FeedbackSubmission } from "./contract";

const FORMAT_VERSION = 1;
const MAX_RETAINED_ENTRIES = 10_000;

export interface StoredFeedback extends Omit<FeedbackSubmission, "consentToStoreText"> {
  v: typeof FORMAT_VERSION;
  submittedAt: string;
  expiresAt: string;
}

function isStoredFeedback(value: unknown): value is StoredFeedback {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return event.v === FORMAT_VERSION
    && typeof event.submittedAt === "string"
    && typeof event.expiresAt === "string"
    && typeof event.client === "string"
    && typeof event.outcome === "string"
    && typeof event.question === "string"
    && (event.expectedAnswer === undefined || typeof event.expectedAnswer === "string")
    && (event.notes === undefined || typeof event.notes === "string");
}

export async function readActiveFeedback(path: string, now = Date.now()): Promise<StoredFeedback[]> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const active: StoredFeedback[] = [];
  for (const line of content.split("\n")) {
    if (line.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (isStoredFeedback(value) && Date.parse(value.expiresAt) > now) active.push(value);
  }
  return active.slice(-MAX_RETAINED_ENTRIES);
}

export class FeedbackStore {
  private pending: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly retentionMs: number,
  ) {}

  submit(submission: FeedbackSubmission): Promise<void> {
    const operation = this.pending.then(async () => {
      const now = Date.now();
      const entries = await readActiveFeedback(this.path, now);
      entries.push({
        v: FORMAT_VERSION,
        submittedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + this.retentionMs).toISOString(),
        client: submission.client,
        outcome: submission.outcome,
        question: submission.question,
        ...(submission.expectedAnswer === undefined ? {} : { expectedAnswer: submission.expectedAnswer }),
        ...(submission.notes === undefined ? {} : { notes: submission.notes }),
      });
      const retained = entries.slice(-MAX_RETAINED_ENTRIES);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporaryPath = `${this.path}.tmp-${process.pid}`;
      await writeFile(temporaryPath, `${retained.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.path);
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  flush(): Promise<void> {
    return this.pending;
  }
}
