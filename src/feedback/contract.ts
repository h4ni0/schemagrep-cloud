const OUTCOMES = [
  "correct",
  "incorrect",
  "unsupported",
  "confusing",
  "connection_failure",
] as const;

export type FeedbackOutcome = typeof OUTCOMES[number];

export interface FeedbackSubmission {
  client: string;
  outcome: FeedbackOutcome;
  question: string;
  expectedAnswer?: string;
  notes?: string;
  consentToStoreText: true;
}

export class InvalidFeedbackError extends Error {}

function invalid(message: string): never {
  throw new InvalidFeedbackError(message);
}

function parseText(
  value: unknown,
  field: string,
  maximumBytes: number,
  required: boolean,
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (
    typeof value !== "string" ||
    (required && value.trim().length === 0) ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    value.includes("\u0000")
  ) {
    invalid(`${field} must be ${required ? "a non-empty" : "a"} string of at most ${maximumBytes} bytes`);
  }
  return value.trim();
}

export function parseFeedbackSubmission(value: unknown): FeedbackSubmission {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid("Feedback must be a JSON object");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "client",
    "outcome",
    "question",
    "expectedAnswer",
    "notes",
    "consentToStoreText",
  ]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown !== undefined) invalid(`Unknown feedback field: ${unknown}`);
  if (input.consentToStoreText !== true) {
    invalid("consentToStoreText must be true before question text can be stored");
  }
  if (typeof input.outcome !== "string" || !OUTCOMES.includes(input.outcome as FeedbackOutcome)) {
    invalid(`outcome must be one of ${OUTCOMES.join(", ")}`);
  }

  const client = parseText(input.client, "client", 100, true);
  const question = parseText(input.question, "question", 4_000, true);
  const expectedAnswer = parseText(input.expectedAnswer, "expectedAnswer", 2_000, false);
  const notes = parseText(input.notes, "notes", 4_000, false);
  if (client === undefined || question === undefined) throw new Error("Required feedback text missing");

  return {
    client,
    outcome: input.outcome as FeedbackOutcome,
    question,
    ...(expectedAnswer === undefined || expectedAnswer.length === 0 ? {} : { expectedAnswer }),
    ...(notes === undefined || notes.length === 0 ? {} : { notes }),
    consentToStoreText: true,
  };
}
