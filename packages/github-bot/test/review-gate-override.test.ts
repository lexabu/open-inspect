import { beforeEach, describe, expect, it, vi } from "vitest";
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

import { handleIssueComment } from "../src/handlers";
import { parseOverrideCommand } from "../src/review-gate-override";
import { checkSenderPermission, postIssueComment, postReaction } from "../src/github-auth";
import {
  alice,
  bob,
  BOT,
  createEnv,
  createLogger,
  HEAD,
  overrideComment,
  resetGateMocks,
  useConfig,
} from "./review-gate-fixtures";

beforeEach(resetGateMocks);

type TestEnv = ReturnType<typeof createEnv>["env"];
const skip = (skip_reason: string) => ({ outcome: "skipped", skip_reason });
const comment = (env: TestEnv, body: string, sender = bob) =>
  handleIssueComment(env, createLogger(), overrideComment(body, sender), "trace");
const refused = (reason: string, detail: string) => ({
  overrides: { outcome: "refused", reason, detail },
});

describe("override command", () => {
  const parse = (body: string) => parseOverrideCommand(body, BOT);

  it("reads a line of its own that names a commit and gives a reason", () => {
    expect(parse("@test-bot override aaaaaaa reviewer is wrong about the cache")).toEqual({
      commit: "aaaaaaa",
      reason: "reviewer is wrong about the cache",
    });
    expect(
      parse("Talked to Sam.\n\n  @test-bot[bot] override AAAAAAA1 hotfix  \n\nThanks")
    ).toEqual({
      commit: "aaaaaaa1",
      reason: "hotfix",
    });
    expect(parse("@test-bot override aaaaaaa")).toEqual({ commit: "aaaaaaa", reason: "" });
  });

  it.each([
    ["a request in prose", "@test-bot override the retry limit for this client"],
    ["no commit", "@test-bot override because the reviewer is flaky"],
    ["a commit prefix that is too short", "@test-bot override aaaaaa too short"],
    ["text before the mention", "please @test-bot override aaaaaaa hotfix"],
    ["a longer word", "@test-bot overrides aaaaaaa hotfix"],
    ["another bot's handle", "@test-bot-other override aaaaaaa hotfix"],
    ["a fenced example", "Use:\n```\n@test-bot override aaaaaaa hotfix\n```"],
    ["no mention at all", "override aaaaaaa hotfix"],
  ])("does not read %s as an override", (_name, body) => {
    expect(parse(body)).toBeNull();
  });
});

describe("override", () => {
  it("asks the gate to pass the named commit, without starting a session", async () => {
    const { env, gateCalls, sessionsStarted } = createEnv();

    const result = await comment(
      env,
      "@test-bot override aaaaaaa reviewer is wrong about the cache"
    );

    expect(result).toEqual({
      outcome: "processed",
      sessions: [],
      handler_action: "check_overridden",
    });
    expect(sessionsStarted()).toBe(0);
    expect(gateCalls("overrides")).toEqual([
      {
        repository: { owner: "acme", name: "widgets" },
        pullNumber: 42,
        commit: "aaaaaaa",
        reason: "reviewer is wrong about the cache",
        overriddenBy: "bob",
      },
    ]);
    expect(checkSenderPermission).toHaveBeenCalledWith(
      "installation-token",
      "acme",
      "widgets",
      "bob",
      expect.any(String)
    );
    expect(postReaction).toHaveBeenCalledWith(
      "installation-token",
      "https://api.github.com/repos/acme/widgets/issues/comments/100/reactions",
      "+1",
      expect.any(String)
    );
    expect(await env.GITHUB_KV.get("ai-review:override:acme/widgets#100")).toBe(HEAD);
  });

  it("applies a comment once, however often it is delivered", async () => {
    const { env, gateCalls } = createEnv();

    await comment(env, "@test-bot override aaaaaaa ok");
    const again = await comment(env, "@test-bot override aaaaaaa ok");

    expect(again).toEqual(skip("override_already_applied"));
    expect(gateCalls("overrides")).toHaveLength(1);
  });

  it.each([
    ["wrong_commit", "override_wrong_commit", "The head is `aaaaaaa`."],
    ["by_author", "override_by_author", "The author can't override."],
    ["shared_head", "override_shared_head", "Also the head of #57."],
  ])("replies with the gate's reason for %s", async (reason, skip_reason, detail) => {
    const { env, sessionsStarted } = createEnv(refused(reason, detail));

    expect(await comment(env, "@test-bot override ccccccc it was fine")).toEqual(skip(skip_reason));
    expect(postIssueComment).toHaveBeenCalledWith(
      "installation-token",
      "https://api.github.com/repos/acme/widgets/issues/42/comments",
      detail,
      expect.any(String)
    );
    expect(sessionsStarted()).toBe(0);
    expect(postReaction).not.toHaveBeenCalled();
    expect(await env.GITHUB_KV.get("ai-review:override:acme/widgets#100")).toBeNull();
  });

  it("stays quiet when the gate refuses without a reply", async () => {
    const { env } = createEnv(refused("pr_not_open", ""));

    expect(await comment(env, "@test-bot override aaaaaaa late")).toEqual(skip("pr_not_open"));
    expect(postIssueComment).not.toHaveBeenCalled();
  });

  it.each([
    ["override_missing_reason", "@test-bot override aaaaaaa", { hasPermission: true }, "reason"],
    [
      "override_not_authorized",
      "@test-bot override aaaaaaa x",
      { hasPermission: false },
      "write access",
    ],
  ])("rejects with %s before asking the gate", async (skip_reason, body, permission, reply) => {
    vi.mocked(checkSenderPermission).mockResolvedValue(permission);
    const { env, gateCalls } = createEnv();

    expect(await comment(env, body)).toEqual(skip(skip_reason));
    expect(postIssueComment).toHaveBeenCalledWith(
      "installation-token",
      "https://api.github.com/repos/acme/widgets/issues/42/comments",
      expect.stringContaining(reply),
      expect.any(String)
    );
    expect(gateCalls("overrides")).toEqual([]);
  });

  it.each([
    ["override_not_authorized", { ...bob, type: "Bot" }, { hasPermission: true }],
    ["permission_check_failed", bob, { hasPermission: false, error: true }],
  ])(
    "skips with %s, without a reply or a call to the gate",
    async (skip_reason, sender, permission) => {
      vi.mocked(checkSenderPermission).mockResolvedValue(permission);
      const { env, gateCalls, sessionsStarted } = createEnv();

      expect(await comment(env, "@test-bot override aaaaaaa because", sender)).toEqual(
        skip(skip_reason)
      );
      expect(postIssueComment).not.toHaveBeenCalled();
      expect(gateCalls("overrides")).toEqual([]);
      expect(sessionsStarted()).toBe(0);
    }
  );

  it("leaves the author check to the gate, which reads the live pull request", async () => {
    const { env, gateCalls } = createEnv(refused("by_author", "The author can't override."));

    await comment(env, "@test-bot override aaaaaaa mine", alice);

    expect(gateCalls("overrides")[0]).toMatchObject({ overriddenBy: "alice" });
  });

  it("treats the comment as an ordinary mention while the gate is off", async () => {
    useConfig({ mergeGate: "off" });
    const { env, sessionsStarted, ownPrompts, gateCalls } = createEnv();

    const result = await comment(env, "@test-bot override aaaaaaa hotfix");

    expect(result).toMatchObject({ outcome: "processed", handler_action: "comment" });
    expect(sessionsStarted()).toBe(1);
    expect(ownPrompts()[0]).toContain("override aaaaaaa hotfix");
    expect(gateCalls("overrides")).toEqual([]);
  });

  it("starts a comment session for a request in prose that begins with override", async () => {
    const { env, sessionsStarted, gateCalls } = createEnv();

    const result = await comment(env, "@test-bot override the retry limit for this client");

    expect(result).toMatchObject({ outcome: "processed", handler_action: "comment" });
    expect(sessionsStarted()).toBe(1);
    expect(gateCalls("overrides")).toEqual([]);
  });
});
