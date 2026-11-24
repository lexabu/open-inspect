import { describe, expect, it, vi } from "vitest";
import { createTestBackgroundTasks } from "../../background-tasks.test-support";
import type { Logger } from "../../logger";
import type { CallbackNotificationService } from "../callback-notification-service";
import type { MessageRepository } from "../message-repository";
import type { SessionStatusService } from "../session-status-service";
import { SandboxExecutionEventHandler } from "./execution.handler";

const log: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => log,
};

function handler(processingMessageId: string | null) {
  const backgroundTasks = createTestBackgroundTasks();
  const footerGitHubPosts = vi.fn(async (_messageId: string) => {});
  const messages = {
    recordMessageCompletion: vi.fn(() => ({
      messageId: "msg-1",
      messageCreatedAt: 1,
      messageStartedAt: 2,
      completedAt: 3,
      status: "completed",
    })),
    clearMessageAwaitingStopConfirmation: vi.fn(),
    getMessageContent: vi.fn(() => null),
    getProcessingMessage: vi.fn(() => null),
  };
  const subject = new SandboxExecutionEventHandler(
    backgroundTasks,
    log,
    messages as unknown as MessageRepository,
    { notifyComplete: vi.fn(async () => {}) } as unknown as CallbackNotificationService,
    { broadcast: vi.fn(), sendToSandbox: async () => {} },
    async () => {},
    { reconcileAfterExecution: vi.fn(async () => {}) } as unknown as SessionStatusService,
    async () => {},
    () => {},
    async () => {},
    async () => {},
    () => {},
    {
      observeExecutionCost: () => ({
        warningEvent: null,
        stopPreparation: null,
        statusChanged: false,
      }),
      deliverTransition: async () => {},
    },
    (closure) => closure(),
    () => {},
    () => {},
    footerGitHubPosts
  );
  const complete = () =>
    subject.handleExecutionComplete(
      {
        type: "execution_complete",
        messageId: "msg-1",
        success: true,
        sandboxId: "sb",
        timestamp: 2,
      },
      {
        now: 2000,
        messageId: "msg-1",
        processingMessage: processingMessageId ? { id: processingMessageId } : null,
      }
    );
  return { backgroundTasks, footerGitHubPosts, complete };
}

describe("execution completion and the review footer", () => {
  it("footers the finished turn's GitHub posts in the background", async () => {
    const { backgroundTasks, footerGitHubPosts, complete } = handler("msg-1");

    await complete();
    await backgroundTasks.settle();

    expect(footerGitHubPosts).toHaveBeenCalledExactlyOnceWith("msg-1");
    expect(backgroundTasks.submissions.map((submission) => submission.name)).toContain(
      "review_footer.apply"
    );
  });

  it("does nothing for a turn that was already stopped", async () => {
    const { backgroundTasks, footerGitHubPosts, complete } = handler(null);

    await complete();
    await backgroundTasks.settle();

    expect(footerGitHubPosts).not.toHaveBeenCalled();
  });
});
