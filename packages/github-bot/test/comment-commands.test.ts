import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueCommentPayload, ReviewCommentPayload } from "../src/types";
import type * as GitHubAuth from "../src/github-auth";

vi.mock("../src/github-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubAuth>()),
  generateInstallationToken: vi.fn(),
  postReaction: vi.fn(),
  postIssueComment: vi.fn(),
  checkSenderPermission: vi.fn(),
  getPullRequest: vi.fn(),
}));

vi.mock("../src/github-checks", () => ({ findSuiteReviewRun: vi.fn() }));

vi.mock("../src/utils/integration-config", () => ({ getGitHubConfig: vi.fn() }));

import { handleIssueComment, handleReviewComment } from "../src/handlers";
import { checkSenderPermission, getPullRequest, postReaction } from "../src/github-auth";
import {
  BASE,
  bob,
  createEnv,
  createLogger,
  HEAD,
  livePull,
  overrideComment,
  repository,
  resetGateMocks,
  useConfig,
} from "./review-gate-fixtures";

beforeEach(resetGateMocks);

/** An env whose bot also answers to `npai`. */
function commandEnv() {
  const fixture = createEnv();
  fixture.env.GITHUB_BOT_COMMAND = "npai";
  return fixture;
}

const comment = (body: string): IssueCommentPayload => overrideComment(body);

function reviewComment(body: string): ReviewCommentPayload {
  return {
    action: "created",
    pull_request: {
      number: 42,
      title: "Add caching",
      base: { ref: "main" },
      head: { ref: "feature/cache", sha: HEAD },
    },
    comment: {
      id: 300,
      body,
      user: { login: bob.login },
      path: "src/cache.ts",
      diff_hunk: "@@ -1 +1 @@",
      in_reply_to_id: null,
    },
    repository,
    sender: bob,
  };
}

const reactionUrls = () => vi.mocked(postReaction).mock.calls.map(([, url]) => url);

describe("review commands with the merge gate on", () => {
  it.each([
    ["npai", null],
    ["/npai review", null],
    ["@test-bot review", null],
    ["npai security", "focus on security"],
    ["npai review performance", "focus on performance"],
    ["/npai bugs", "focus on correctness bugs"],
    ["npai tests", "focus on tests"],
  ])("starts %j through the gate on the live head", async (body, focusLine) => {
    const { env, gateCalls, sessionsStarted } = commandEnv();

    const result = await handleIssueComment(env, createLogger(), comment(body), "trace");

    expect(result).toMatchObject({ outcome: "processed", handler_action: "review" });
    expect(sessionsStarted()).toBe(0);
    const [request] = gateCalls("reviews");
    expect(request).toMatchObject({
      pullNumber: 42,
      headSha: HEAD,
      base: { ref: "main", sha: BASE },
    });
    const prompt: string = request.reviewers[0].prompt;
    expect(prompt).toContain(`compare/${BASE}...${HEAD}`);
    if (focusLine) expect(prompt).toContain(focusLine);
    else expect(prompt).not.toContain("## Focus");
    // A comment-triggered review is not a pre-merge re-run.
    expect(prompt).not.toContain("## Pre-merge Review");
    expect(reactionUrls()).toEqual([
      "https://api.github.com/repos/acme/widgets/issues/comments/100/reactions",
    ]);
  });

  it("passes free text after review as untrusted focus", async () => {
    const { env, gateCalls } = commandEnv();

    await handleIssueComment(env, createLogger(), comment("npai review the cache TTLs"), "trace");

    const prompt: string = gateCalls("reviews")[0].reviewers[0].prompt;
    expect(prompt).toContain("## Focus");
    expect(prompt).toContain(
      '<user_content source="github_review_focus" author="github">\nthe cache TTLs\n</user_content>'
    );
  });

  it("starts a review from an inline review comment, acknowledged on that comment", async () => {
    const { env, gateCalls } = commandEnv();

    const result = await handleReviewComment(env, createLogger(), reviewComment("npai bugs"), "t");

    expect(result).toMatchObject({ outcome: "processed", handler_action: "review" });
    expect(gateCalls("reviews")).toHaveLength(1);
    expect(reactionUrls()).toEqual([
      "https://api.github.com/repos/acme/widgets/pulls/comments/300/reactions",
    ]);
  });

  it("skips a draft pull request", async () => {
    const { env, gateCalls } = commandEnv();
    vi.mocked(getPullRequest).mockResolvedValue({ ...livePull, draft: true });

    const result = await handleIssueComment(env, createLogger(), comment("npai"), "trace");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "draft_pr" });
    expect(gateCalls("reviews")).toHaveLength(0);
  });

  it("skips a closed pull request", async () => {
    const { env, gateCalls } = commandEnv();
    vi.mocked(getPullRequest).mockResolvedValue({ ...livePull, state: "closed" });

    const result = await handleIssueComment(env, createLogger(), comment("npai"), "trace");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "pr_not_open" });
    expect(gateCalls("reviews")).toHaveLength(0);
  });

  it("applies caller gating before the gate is asked", async () => {
    const { env, gateCalls } = commandEnv();
    vi.mocked(checkSenderPermission).mockResolvedValue({ hasPermission: false });

    const result = await handleIssueComment(env, createLogger(), comment("npai security"), "t");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "sender_insufficient_permission" });
    expect(gateCalls("reviews")).toHaveLength(0);
  });

  it("reports the gate's refusal when a review already runs on the head", async () => {
    const { env } = commandEnv();
    const gate = createEnv({ reviews: { outcome: "skipped", reason: "review_in_progress" } });
    gate.env.GITHUB_BOT_COMMAND = env.GITHUB_BOT_COMMAND;

    const result = await handleIssueComment(gate.env, createLogger(), comment("npai"), "trace");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "review_in_progress" });
  });
});

describe("review commands with the merge gate off", () => {
  it("starts an ordinary review session pinned to the live head", async () => {
    useConfig({ mergeGate: "off" });
    const { env, gateCalls, sessionsStarted, ownPrompts } = commandEnv();

    const result = await handleIssueComment(env, createLogger(), comment("npai security"), "t");

    expect(result).toMatchObject({ outcome: "processed", handler_action: "review" });
    expect(gateCalls("reviews")).toHaveLength(0);
    expect(sessionsStarted()).toBe(1);
    const [prompt] = ownPrompts();
    expect(prompt).toContain(`git checkout --detach ${HEAD}`);
    expect(prompt).toContain("focus on security");
  });
});

describe("other comments", () => {
  it("starts a free-form session for a question", async () => {
    useConfig({ mergeGate: "off" });
    const { env, gateCalls, ownPrompts } = commandEnv();

    const result = await handleIssueComment(
      env,
      createLogger(),
      comment("npai why is the TTL 60s?"),
      "trace"
    );

    expect(result).toMatchObject({ outcome: "processed", handler_action: "comment" });
    expect(gateCalls("reviews")).toHaveLength(0);
    expect(ownPrompts()[0]).toContain("\nwhy is the TTL 60s?\n</user_content>");
  });

  it("ignores npai in the middle of prose", async () => {
    const { env, gateCalls, sessionsStarted } = commandEnv();

    const result = await handleIssueComment(
      env,
      createLogger(),
      comment("I'll ask npai about it later"),
      "trace"
    );

    expect(result).toEqual({ outcome: "skipped", skip_reason: "no_mention" });
    expect(gateCalls("reviews")).toHaveLength(0);
    expect(sessionsStarted()).toBe(0);
  });

  it.each(["npai override abcdef1 flaky upstream", "/npai override abcdef1 flaky upstream"])(
    "keeps %j an override, not a review",
    async (body) => {
      const { env, gateCalls } = commandEnv();

      const result = await handleIssueComment(env, createLogger(), comment(body), "trace");

      expect(result).toMatchObject({ outcome: "processed", handler_action: "check_overridden" });
      expect(gateCalls("overrides")).toEqual([
        expect.objectContaining({ commit: "abcdef1", reason: "flaky upstream" }),
      ]);
      expect(gateCalls("reviews")).toHaveLength(0);
    }
  );

  it("reads a loose override as a request, not an override", async () => {
    useConfig({ mergeGate: "off" });
    const { env, gateCalls } = commandEnv();

    const result = await handleIssueComment(
      env,
      createLogger(),
      comment("npai override the retry limit for this client"),
      "trace"
    );

    expect(result).toMatchObject({ outcome: "processed", handler_action: "comment" });
    expect(gateCalls("overrides")).toHaveLength(0);
  });
});

describe("the review command tip", () => {
  const tip = (gate: boolean) =>
    `Commands: \`npai\` (full review) · \`npai security|performance|bugs|tests\` · \`npai <question>\`${gate ? " · Re-run on the AI Review check" : ""}`;

  it("ends the review prompt with the tip line where the repository wants it", async () => {
    useConfig({ reviewTip: true });
    const { env, gateCalls } = commandEnv();

    await handleIssueComment(env, createLogger(), comment("npai"), "trace");

    const prompt: string = gateCalls("reviews")[0].reviewers[0].prompt;
    expect(prompt).toContain(`## Command Tip`);
    expect(prompt).toContain(`\n${tip(true)}\n`);
  });

  it("leaves out the check re-run where the merge gate is off", async () => {
    useConfig({ reviewTip: true, mergeGate: "off" });
    const { env, ownPrompts } = commandEnv();

    await handleIssueComment(env, createLogger(), comment("npai"), "trace");

    expect(ownPrompts()[0]).toContain(`\n${tip(false)}\n`);
  });

  it("names the mention where no short command is set", async () => {
    useConfig({ reviewTip: true });
    const { env, gateCalls } = createEnv();

    await handleIssueComment(env, createLogger(), comment("@test-bot"), "trace");

    expect(gateCalls("reviews")[0].reviewers[0].prompt).toContain(
      "Commands: `@test-bot` (full review)"
    );
  });

  it("adds no tip by default", async () => {
    const { env, gateCalls } = commandEnv();

    await handleIssueComment(env, createLogger(), comment("npai"), "trace");

    expect(gateCalls("reviews")[0].reviewers[0].prompt).not.toContain("Commands:");
  });
});
