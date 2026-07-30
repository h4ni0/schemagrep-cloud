import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import { FeedbackStore, readActiveFeedback } from "../src/feedback/store";

const BETA_KEY = "feedback-test-secret-0123456789abcdef";
const temporaryDirectories: string[] = [];
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "schemagrep-feedback-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("opt-in beta feedback", () => {
  test("requires authentication and explicit consent without attaching dataset identity", async () => {
    const directory = await temporaryDirectory();
    const feedbackPath = join(directory, "feedback.jsonl");
    app = buildApp({
      config: loadConfig({
        SCHEMAGREP_API_KEYS: JSON.stringify({ tester: BETA_KEY }),
        STORAGE_DIR: join(directory, "files"),
        FEEDBACK_PATH: feedbackPath,
        FEEDBACK_RETENTION_DAYS: "30",
        WORKER_SANDBOX: "disabled",
      }),
    });
    const submission = {
      client: "Claude Desktop",
      outcome: "incorrect",
      question: "How many failed checkouts occurred?",
      expectedAnswer: "42",
      notes: "The selected field was wrong.",
      consentToStoreText: true,
    };

    const unauthorized = await app.inject({
      method: "POST",
      url: "/v1/feedback",
      payload: submission,
    });
    const missingConsent = await app.inject({
      method: "POST",
      url: "/v1/feedback",
      headers: { authorization: `Bearer ${BETA_KEY}` },
      payload: { ...submission, consentToStoreText: false },
    });
    const accepted = await app.inject({
      method: "POST",
      url: "/v1/feedback",
      headers: { authorization: `Bearer ${BETA_KEY}` },
      payload: submission,
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(missingConsent.statusCode).toBe(400);
    expect(accepted.statusCode).toBe(201);
    expect(JSON.parse(accepted.body)).toEqual({ accepted: true });
    const entries = await readActiveFeedback(feedbackPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      client: "Claude Desktop",
      outcome: "incorrect",
      question: submission.question,
      expectedAnswer: "42",
      notes: submission.notes,
    });
    expect(entries[0]).not.toHaveProperty("tenant");
    expect(entries[0]).not.toHaveProperty("fileId");
    expect(entries[0]).not.toHaveProperty("consentToStoreText");
  });

  test("removes expired entries when the next consented report is stored", async () => {
    const directory = await temporaryDirectory();
    const feedbackPath = join(directory, "feedback.jsonl");
    await writeFile(feedbackPath, `${JSON.stringify({
      v: 1,
      submittedAt: "2025-01-01T00:00:00.000Z",
      expiresAt: "2025-01-02T00:00:00.000Z",
      client: "Old client",
      outcome: "correct",
      question: "Expired question",
    })}\n`);
    const store = new FeedbackStore(feedbackPath, 30 * 24 * 60 * 60 * 1000);

    await store.submit({
      client: "Codex",
      outcome: "correct",
      question: "How many rows are present?",
      consentToStoreText: true,
    });

    expect(await readActiveFeedback(feedbackPath)).toHaveLength(1);
    expect(await readFile(feedbackPath, "utf8")).not.toContain("Expired question");
  });
});
