import type { FastifyInstance } from "fastify";
import { InvalidFeedbackError, parseFeedbackSubmission } from "./contract";
import type { FeedbackStore } from "./store";

interface FeedbackRouteOptions {
  feedbackStore?: FeedbackStore;
}

export async function registerFeedbackRoutes(
  app: FastifyInstance,
  options: FeedbackRouteOptions,
): Promise<void> {
  app.post("/v1/feedback", async (request, reply) => {
    if (options.feedbackStore === undefined) {
      return reply.code(503).send({
        error: {
          code: "feedback_unavailable",
          message: "Feedback collection is not enabled on this service",
        },
      });
    }

    try {
      const submission = parseFeedbackSubmission(request.body);
      await options.feedbackStore.submit(submission);
      return reply
        .header("cache-control", "no-store")
        .code(201)
        .send({ accepted: true });
    } catch (error) {
      if (error instanceof InvalidFeedbackError) {
        return reply.code(400).send({
          error: { code: "invalid_feedback", message: error.message },
        });
      }
      request.log.error({ err: error }, "Feedback write failed");
      return reply.code(500).send({
        error: { code: "feedback_write_failed", message: "Feedback could not be stored" },
      });
    }
  });
}
