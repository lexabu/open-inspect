import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import type { FetchClient } from "../platform-ports";
import {
  CallbackNotificationService,
  type CallbackRepository,
  type GitHubReviewCompletionHandler,
} from "./callback-notification-service";
import type { MessageRepository } from "./message-repository";

function createLogger(): Logger {
  const log: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => log),
  };
  return log;
}

/** A session whose prompt carries the AI Review gate's callback context. */
function harness(completeGitHubReview?: GitHubReviewCompletionHandler) {
  const slackBot = { fetch: vi.fn<FetchClient["fetch"]>() };
  const linearBot = { fetch: vi.fn<FetchClient["fetch"]>() };
  const messages = {
    getMessageCallbackContext: vi.fn(() => ({
      callback_context: JSON.stringify({ source: "github-review", attemptId: "attempt-1" }),
      source: "github",
    })),
    getProcessingMessageWithStartedAt: vi.fn(() => null),
    getSession: vi.fn(() => null),
  };
  const log = createLogger();
  const service = new CallbackNotificationService({
    repository: messages as CallbackRepository,
    messageRepository: messages as unknown as MessageRepository,
    slackPostScope: { getSession: vi.fn(), getChannelBinding: vi.fn() },
    env: {
      SERVICE_AUTH_SECRET_SLACK_BOT: "test-secret",
      SERVICE_AUTH_SECRET_LINEAR_BOT: "test-secret",
      SLACK_BOT: slackBot,
      LINEAR_BOT: linearBot,
    },
    log,
    getSessionId: () => "gate-session-1",
    completeGitHubReview,
    sleep: vi.fn(async () => {}),
  });
  return { service, slackBot, linearBot, log };
}

describe("CallbackNotificationService: AI Review gate sessions", () => {
  it.each([true, false])(
    "reports completion (success %s) to the gate, in process",
    async (success) => {
      const complete = vi.fn<GitHubReviewCompletionHandler>(async () => {});
      const { service, slackBot, linearBot } = harness(complete);

      await service.notifyComplete("message-1", success, success ? undefined : "sandbox died");

      expect(complete).toHaveBeenCalledWith({
        sessionId: "gate-session-1",
        messageId: "message-1",
        success,
      });
      // Nothing about a reviewer session reaches a bot.
      expect(slackBot.fetch).not.toHaveBeenCalled();
      expect(linearBot.fetch).not.toHaveBeenCalled();
    }
  );

  it("retries a gate that fails, and reports the delivery as failed when it keeps failing", async () => {
    const complete = vi
      .fn<GitHubReviewCompletionHandler>()
      .mockRejectedValueOnce(new Error("D1 unavailable"))
      .mockResolvedValue(undefined);
    const recovered = harness(complete);
    await recovered.service.notifyComplete("message-1", true);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(recovered.log.error).not.toHaveBeenCalled();

    const failing = harness(vi.fn(async () => Promise.reject(new Error("still down"))));
    await failing.service.notifyComplete("message-1", true);
    expect(failing.log.error).toHaveBeenCalledWith(
      "callback.complete_delivery",
      expect.objectContaining({ source: "github-review", outcome: "error" })
    );
  });

  it("does not fall back to a bot when no gate handler is wired", async () => {
    const { service, slackBot, log } = harness();

    await service.notifyComplete("message-1", true);

    expect(slackBot.fetch).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      "callback.complete_delivery",
      expect.objectContaining({ source: "github-review", reject_reason: "no_binding" })
    );
  });

  it("forwards no tool calls of a reviewer session", async () => {
    const { service, slackBot, linearBot } = harness(vi.fn(async () => {}));

    await service.notifyToolCall("message-1", {
      type: "tool_call",
      tool: "bash",
      args: { command: "gh api repos/acme/widgets/pulls/42/reviews" },
      callId: "call-1",
      status: "running",
    } as Parameters<CallbackNotificationService["notifyToolCall"]>[1]);

    expect(slackBot.fetch).not.toHaveBeenCalled();
    expect(linearBot.fetch).not.toHaveBeenCalled();
  });
});
