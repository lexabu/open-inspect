import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestOpenedPayload, ReviewRequestedPayload } from "../src/types";
import type * as GitHubAuth from "../src/github-auth";
import type * as GitHubChecks from "../src/github-checks";

vi.mock("../src/github-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubAuth>()),
  generateInstallationToken: vi.fn(),
  postReaction: vi.fn(),
  postIssueComment: vi.fn(),
  checkSenderPermission: vi.fn(),
  listPullRequestReviews: vi.fn(),
  getPullRequest: vi.fn(),
}));

vi.mock("../src/github-checks", async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubChecks>()),
  createCheckRun: vi.fn(),
  updateCheckRun: vi.fn(),
  getCompareDiff: vi.fn(),
  listOpenPullsWithHead: vi.fn(),
  findSuiteReviewRun: vi.fn(),
}));

vi.mock("../src/utils/integration-config", () => ({ getGitHubConfig: vi.fn() }));

import { handleBotReviewChanged } from "../src/ai-review-check";
import {
  handleCheckRunReviewRequested,
  handlePullRequestOpened,
  handleReviewRequested,
} from "../src/handlers";
import { checkSenderPermission, listPullRequestReviews } from "../src/github-auth";
import { createCheckRun, getCompareDiff, updateCheckRun } from "../src/github-checks";
import {
  alice,
  ATTEMPT_KEY,
  BASE,
  BOT,
  botReview,
  createEnv,
  createLogger,
  defaultControlPlane,
  HEAD,
  marker,
  opened,
  prompts,
  pullRequest,
  repository,
  rerequested,
  resetGateMocks,
  review,
  twoReviewers,
  useConfig,
} from "./ai-review-fixtures";

beforeEach(resetGateMocks);

describe("starting a review", () => {
  it("records the attempt, shows the check in progress and gives the reviewer its marker", async () => {
    const { env, json, controlPlaneFetch } = createEnv();

    const result = await handlePullRequestOpened(env, createLogger(), opened, "trace");

    expect(result).toMatchObject({ outcome: "processed", handler_action: "auto_review" });
    const recorded = json(ATTEMPT_KEY);
    expect(recorded).toEqual({
      id: expect.any(String),
      prNumber: 42,
      headSha: HEAD,
      baseSha: BASE,
      baseRef: "main",
      startedAt: expect.any(String),
      reviewers: [{ key: expect.any(String), model: "anthropic/claude-haiku-4-5" }],
      checkRunId: 7,
      diffHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      concludedAt: null,
    });
    expect(createCheckRun).toHaveBeenCalledOnce();
    const [client, run, state] = vi.mocked(createCheckRun).mock.calls[0];
    expect(client.repoUrl).toBe("https://api.github.com/repos/acme/widgets");
    expect(run).toEqual({
      headSha: HEAD,
      startedAt: recorded.startedAt,
      externalId: `open-inspect:pr=42;attempt=${recorded.id}`,
    });
    expect(state).toMatchObject({ status: "in_progress" });
    expect(getCompareDiff).toHaveBeenCalledWith(expect.anything(), BASE, HEAD);
    expect(prompts(controlPlaneFetch)).toEqual([
      expect.stringContaining(marker(recorded.reviewers[0].key, recorded.id)),
    ]);
  });

  it("gives each of several reviewers its own marker, in the configured order", async () => {
    useConfig({ reviewers: twoReviewers });
    const { env, json, controlPlaneFetch } = createEnv();
    controlPlaneFetch.mockImplementation(async (url: string) =>
      url === "https://internal/model-preferences?strict=true"
        ? Response.json({ enabledModels: twoReviewers.map((reviewer) => reviewer.model) })
        : defaultControlPlane(url)
    );

    await handlePullRequestOpened(env, createLogger(), opened, "trace");

    const { id, reviewers } = json(ATTEMPT_KEY);
    expect(reviewers.map((reviewer: { model: string }) => reviewer.model)).toEqual(
      twoReviewers.map((reviewer) => reviewer.model)
    );
    expect(reviewers[0].key).not.toBe(reviewers[1].key);
    const sent = prompts(controlPlaneFetch);
    expect(sent).toHaveLength(2);
    for (const { key } of reviewers) {
      expect(sent.filter((prompt) => prompt.includes(marker(key, id)))).toHaveLength(1);
    }
  });

  it("posts no check and no marker while the gate is off", async () => {
    useConfig({ mergeGate: "off" });
    const { env, sessionsStarted, controlPlaneFetch, json } = createEnv();

    await handlePullRequestOpened(env, createLogger(), opened, "trace");

    expect(sessionsStarted()).toBe(1);
    expect(createCheckRun).not.toHaveBeenCalled();
    expect(prompts(controlPlaneFetch)[0]).not.toContain("open-inspect:review");
    expect(json(ATTEMPT_KEY)).toBeNull();
  });

  it("posts no check for a repository the bot is not enabled on", async () => {
    useConfig({ enabledRepos: ["acme/other"] });
    const { env } = createEnv();

    const result = await handlePullRequestOpened(env, createLogger(), opened, "trace");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "repo_not_enabled" });
    expect(createCheckRun).not.toHaveBeenCalled();
  });

  it.each([
    ["required", "action_required"],
    ["shadow", "neutral"],
  ] as const)("asks for a review in %s mode when none started", async (mergeGate, conclusion) => {
    useConfig({ mergeGate, autoReviewOnOpen: false });
    const { env, json } = createEnv();

    const result = await handlePullRequestOpened(env, createLogger(), opened, "trace");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "auto_review_disabled" });
    const [, run, state] = vi.mocked(createCheckRun).mock.calls[0];
    expect(run.externalId).toBe("open-inspect:pr=42");
    expect(state).toMatchObject({
      status: "completed",
      conclusion,
      reviewAction: true,
      output: { title: "Re-run the AI review before merging" },
    });
    expect(json(ATTEMPT_KEY)).toBeNull();
  });

  it("asks for a review when the session start fails, and still fails the delivery", async () => {
    const { env, controlPlaneFetch, json } = createEnv();
    controlPlaneFetch.mockResolvedValue(new Response("boom", { status: 500 }));

    await expect(handlePullRequestOpened(env, createLogger(), opened, "trace")).rejects.toThrow();

    expect(vi.mocked(createCheckRun).mock.calls[0][2]).toMatchObject({
      conclusion: "action_required",
    });
    expect(json(ATTEMPT_KEY)).toBeNull();
  });

  it("logs a refused check write without failing a review that started", async () => {
    vi.mocked(createCheckRun).mockResolvedValue(null);
    const { env, json } = createEnv();
    const log = createLogger();

    const result = await handlePullRequestOpened(env, log, opened, "trace");

    expect(result).toMatchObject({ outcome: "processed" });
    expect(log.error).toHaveBeenCalledWith("check.create_failed", expect.anything());
    expect(json(ATTEMPT_KEY)).toBeNull();
  });

  it("reviews a pull request leaving draft only when the gate is on", async () => {
    const ready: PullRequestOpenedPayload = { ...opened, action: "ready_for_review" };
    const { env, sessionsStarted } = createEnv();

    await handlePullRequestOpened(env, createLogger(), ready, "trace");
    expect(sessionsStarted()).toBe(1);
    expect(vi.mocked(createCheckRun).mock.calls[0][2]).toMatchObject({ status: "in_progress" });

    useConfig({ mergeGate: "off" });
    const off = createEnv();
    const result = await handlePullRequestOpened(off.env, createLogger(), ready, "trace");
    expect(result).toEqual({ outcome: "skipped", skip_reason: "merge_gate_off" });
    expect(off.sessionsStarted()).toBe(0);
  });

  it("shows a requested review in progress, and leaves the check alone when it is refused", async () => {
    const requested: ReviewRequestedPayload = {
      action: "review_requested",
      pull_request: pullRequest,
      requested_reviewer: { login: BOT },
      repository,
      sender: alice,
    };
    const first = createEnv();
    await handleReviewRequested(first.env, createLogger(), requested, "trace");
    expect(vi.mocked(createCheckRun).mock.calls[0][2]).toMatchObject({ status: "in_progress" });

    vi.mocked(createCheckRun).mockClear();
    vi.mocked(checkSenderPermission).mockResolvedValue({ hasPermission: false });
    const refused = createEnv();
    const result = await handleReviewRequested(refused.env, createLogger(), requested, "trace");
    expect(result).toMatchObject({ outcome: "skipped" });
    expect(createCheckRun).not.toHaveBeenCalled();
    expect(refused.json(ATTEMPT_KEY)).toBeNull();
  });
});

describe("races", () => {
  it("claims the attempt before any session is launched", async () => {
    const { env, json, controlPlaneFetch } = createEnv();
    let claimedAtLaunch: unknown;
    controlPlaneFetch.mockImplementation(async (url: string) => {
      if (url === "https://internal/sessions") claimedAtLaunch = json(ATTEMPT_KEY);
      return defaultControlPlane(url);
    });

    await handlePullRequestOpened(env, createLogger(), opened, "trace");

    expect(claimedAtLaunch).toMatchObject({ headSha: HEAD, checkRunId: null, concludedAt: null });
  });

  it("starts one attempt for two clicks that overlap", async () => {
    const { env, controlPlaneFetch, sessionsStarted } = createEnv();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    controlPlaneFetch.mockImplementation(async (url: string) => {
      if (url === "https://internal/sessions") await held;
      return defaultControlPlane(url);
    });
    const click = () => handleCheckRunReviewRequested(env, createLogger(), rerequested, "trace");

    const first = click();
    // Let the first click claim the attempt and reach its session launch.
    await vi.waitFor(() => expect(sessionsStarted()).toBe(1));
    const second = await click();
    release();

    expect(second).toEqual({ outcome: "skipped", skip_reason: "review_in_progress" });
    expect(await first).toMatchObject({ outcome: "processed" });
    expect(sessionsStarted()).toBe(1);
    expect(createCheckRun).toHaveBeenCalledOnce();
  });

  it("starts one attempt for repeated clicks, until the first is taken to have died", async () => {
    const { env, sessionsStarted } = createEnv();
    const click = () => handleCheckRunReviewRequested(env, createLogger(), rerequested, "trace");

    await click();
    expect(await click()).toEqual({ outcome: "skipped", skip_reason: "review_in_progress" });
    expect(sessionsStarted()).toBe(1);

    vi.useFakeTimers({ now: Date.now() + 31 * 60 * 1000 });
    expect(await click()).toMatchObject({ outcome: "processed" });
    expect(sessionsStarted()).toBe(2);
  });

  it("gives way when another start took the claim first", async () => {
    const { env, sessionsStarted, seed } = createEnv();
    const kv = env.GITHUB_KV;
    const put = kv.put.bind(kv);
    // Another worker's write lands right after ours: its attempt is the one on record.
    kv.put = async (key: string, value: string) => {
      await put(key, value);
      if (key === ATTEMPT_KEY) seed(key, { ...JSON.parse(value), id: "the-other-attempt" });
    };

    const result = await handlePullRequestOpened(env, createLogger(), opened, "trace");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "review_in_progress" });
    expect(sessionsStarted()).toBe(0);
    expect(createCheckRun).not.toHaveBeenCalled();
  });

  it("concludes from a review that landed before the check run existed", async () => {
    const { env, json, controlPlaneFetch } = createEnv();
    let early: unknown;
    controlPlaneFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/prompt")) {
        // The reviewer posts at once; its webhook is handled before the check run is made.
        const { id, reviewers } = json(ATTEMPT_KEY);
        vi.mocked(listPullRequestReviews).mockResolvedValue([
          review({ state: "APPROVED", body: marker(reviewers[0].key, id) }),
        ]);
        early = await handleBotReviewChanged(env, createLogger(), botReview, "trace");
      }
      return defaultControlPlane(url);
    });

    await handlePullRequestOpened(env, createLogger(), opened, "trace");

    expect(early).toEqual({ outcome: "skipped", skip_reason: "check_not_created" });
    expect(updateCheckRun).toHaveBeenCalledWith(
      expect.anything(),
      7,
      expect.objectContaining({ conclusion: "success" })
    );
    expect(json(ATTEMPT_KEY).concludedAt).not.toBeNull();
  });

  it("leaves the record alone when the attempt was replaced while its sessions started", async () => {
    const { env, json, remove, controlPlaneFetch } = createEnv();
    controlPlaneFetch.mockImplementation(async (url: string) => {
      // An override or a base change removes the attempt mid-start.
      if (url.endsWith("/prompt")) remove(ATTEMPT_KEY);
      return defaultControlPlane(url);
    });

    const result = await handlePullRequestOpened(env, createLogger(), opened, "trace");

    expect(result).toMatchObject({ outcome: "processed" });
    expect(json(ATTEMPT_KEY)).toBeNull();
    expect(updateCheckRun).not.toHaveBeenCalled();
  });

  it("does not fail a started review when the early review lookup cannot read GitHub", async () => {
    vi.mocked(listPullRequestReviews).mockResolvedValue(null);
    const { env, json } = createEnv();
    const log = createLogger();

    const result = await handlePullRequestOpened(env, log, opened, "trace");

    expect(result).toMatchObject({ outcome: "processed" });
    expect(log.warn).toHaveBeenCalledWith("check.early_review_lookup_failed", expect.anything());
    expect(json(ATTEMPT_KEY)).toMatchObject({ checkRunId: 7 });
  });
});
