import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestChangedPayload } from "../src/types";
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

import { handlePullRequestChanged } from "../src/ai-review-check";
import { normalizeDiff } from "../src/ai-review-diff";
import { getPullRequest } from "../src/github-auth";
import { createCheckRun, getCompareDiff, listOpenPullsWithHead } from "../src/github-checks";
import {
  attempt,
  ATTEMPT_KEY,
  BASE,
  createEnv,
  createLogger,
  HEAD,
  livePull,
  OLD_HEAD,
  resetGateMocks,
  sha256Hex,
  synchronized,
  useConfig,
  verdict,
  VERDICT_KEY,
} from "./ai-review-fixtures";

beforeEach(resetGateMocks);

const changed = (env: ReturnType<typeof createEnv>["env"], payload = synchronized) =>
  handlePullRequestChanged(env, createLogger(), payload, "trace");
const posted = (call = 0) => vi.mocked(createCheckRun).mock.calls[call];
/** A verdict reached on an earlier head, for a pull request whose diff was `diff`. */
const earlier = async (diff: string, overrides: object = {}) =>
  verdict({
    sha: OLD_HEAD,
    reviewedSha: OLD_HEAD,
    diffHash: await sha256Hex(normalizeDiff(diff)),
    ...overrides,
  });

const TEXT_DIFF = [
  "diff --git a/src/cache.ts b/src/cache.ts",
  "index 1111111..2222222 100644",
  "--- a/src/cache.ts",
  "+++ b/src/cache.ts",
  "@@ -10,3 +10,4 @@ export function read() {",
  " const key = id;",
  "+const ttl = 60;",
  " return store.get(key);",
].join("\n");

describe("a new head", () => {
  it.each([
    ["required", "action_required"],
    ["shadow", "neutral"],
  ] as const)(
    "asks for a review in %s mode, without starting one",
    async (mergeGate, conclusion) => {
      useConfig({ mergeGate });
      const { env, sessionsStarted } = createEnv();

      const result = await changed(env);

      expect(result).toMatchObject({ outcome: "processed", handler_action: "check_needs_review" });
      expect(sessionsStarted()).toBe(0);
      expect(createCheckRun).toHaveBeenCalledWith(
        expect.anything(),
        { headSha: HEAD, startedAt: expect.any(String), externalId: "open-inspect:pr=42" },
        {
          status: "completed",
          conclusion,
          output: {
            title: "Re-run the AI review before merging",
            summary: expect.stringContaining("Click **Review now**"),
          },
          reviewAction: true,
        }
      );
    }
  );

  it("carries the verdict forward when only the base moved", async () => {
    const { env, json, seed } = createEnv();
    seed(VERDICT_KEY, await earlier(TEXT_DIFF));
    // The base touched the file above the hunk: new blob ids, shifted line numbers.
    vi.mocked(getCompareDiff).mockResolvedValue(
      TEXT_DIFF.replace("index 1111111..2222222", "index 3333333..4444444").replace(
        "@@ -10,3 +10,4 @@",
        "@@ -48,3 +48,4 @@"
      )
    );

    const result = await changed(env);

    expect(result).toMatchObject({ handler_action: "check_carried_forward" });
    expect(getCompareDiff).toHaveBeenLastCalledWith(expect.anything(), BASE, HEAD);
    expect(posted()[2]).toMatchObject({
      conclusion: "success",
      reviewAction: false,
      output: { title: "Approved (carried forward)" },
    });
    expect(posted()[2].output.summary).toContain("Carried forward from commit `ccccccc`");
    expect(json(VERDICT_KEY)).toMatchObject({ sha: HEAD, reviewedSha: OLD_HEAD });
  });

  it("carries a failed verdict forward as a failure", async () => {
    const { env, seed } = createEnv();
    vi.mocked(getCompareDiff).mockResolvedValue(TEXT_DIFF);
    seed(VERDICT_KEY, await earlier(TEXT_DIFF, { approved: false }));

    await changed(env);

    expect(posted()[2]).toMatchObject({
      conclusion: "failure",
      reviewAction: true,
      output: { title: "Not approved (carried forward)" },
    });
    // A failure shown on a shared commit blocks nothing it should not.
    expect(listOpenPullsWithHead).not.toHaveBeenCalled();
  });

  it("asks for a review when the pull request's own diff changed or cannot be read", async () => {
    const { env, seed, json } = createEnv();
    vi.mocked(getCompareDiff).mockResolvedValue(TEXT_DIFF.replace("ttl = 60", "ttl = 0"));
    seed(VERDICT_KEY, await earlier(TEXT_DIFF));

    await changed(env);
    expect(posted()[2]).toMatchObject({ conclusion: "action_required" });

    vi.mocked(getCompareDiff).mockResolvedValue(null);
    seed(VERDICT_KEY, await earlier(TEXT_DIFF, { diffHash: null }));
    const log = createLogger();
    await handlePullRequestChanged(env, log, synchronized, "trace");
    expect(posted(1)[2]).toMatchObject({ conclusion: "action_required" });
    expect(log.warn).toHaveBeenCalledWith("check.diff_unreadable", expect.anything());
    expect(json(VERDICT_KEY)).toMatchObject({ sha: OLD_HEAD });
  });

  it("does not carry a verdict reached against another base branch", async () => {
    const { env, seed } = createEnv();
    vi.mocked(getCompareDiff).mockResolvedValue(TEXT_DIFF);
    seed(VERDICT_KEY, await earlier(TEXT_DIFF, { baseRef: "release" }));

    await changed(env);

    expect(posted()[2]).toMatchObject({ conclusion: "action_required" });
  });

  it.each([
    ["another open pull request has the same head commit", [42, 57], "#57"],
    ["GitHub cannot say which pull requests are on the commit", null, "Could not confirm"],
  ])("does not carry an approval forward when %s", async (_name, pulls, text) => {
    const { env, seed, json } = createEnv();
    vi.mocked(getCompareDiff).mockResolvedValue(TEXT_DIFF);
    vi.mocked(listOpenPullsWithHead).mockResolvedValue(pulls);
    seed(VERDICT_KEY, await earlier(TEXT_DIFF));

    const result = await changed(env);

    expect(result).toMatchObject({ handler_action: "check_needs_review" });
    expect(posted()[2]).toMatchObject({ conclusion: "action_required" });
    expect(posted()[2].output.summary).toContain(text);
    expect(json(VERDICT_KEY)).toMatchObject({ sha: OLD_HEAD });
  });

  it("ignores a synchronize that is not for the live head", async () => {
    vi.mocked(getPullRequest).mockResolvedValue({
      ...livePull,
      head: { ref: "feature/cache", sha: "f".repeat(40) },
    });
    const { env } = createEnv();

    expect(await changed(env)).toEqual({ outcome: "skipped", skip_reason: "stale_synchronize" });
    expect(createCheckRun).not.toHaveBeenCalled();
  });

  it.each([
    ["draft_pr", { draft: true }, {}],
    ["pr_not_open", { state: "closed" }, {}],
    ["merge_gate_off", {}, { mergeGate: "off" as const }],
  ])("skips with %s, read from the live pull request", async (skip_reason, live, config) => {
    useConfig(config);
    vi.mocked(getPullRequest).mockResolvedValue({ ...livePull, ...live });
    const { env } = createEnv();

    expect(await changed(env)).toEqual({ outcome: "skipped", skip_reason });
    expect(createCheckRun).not.toHaveBeenCalled();
  });
});

describe("a new base branch", () => {
  const retargeted: PullRequestChangedPayload = { ...synchronized, action: "edited" };

  it("drops the verdict and the head's attempt, and asks for a review", async () => {
    vi.mocked(getPullRequest).mockResolvedValue({
      ...livePull,
      base: { ref: "release", sha: BASE },
    });
    vi.mocked(getCompareDiff).mockResolvedValue(TEXT_DIFF);
    const { env, seed, json } = createEnv();
    // Even a diff that hashes the same is not carried across base branches.
    seed(VERDICT_KEY, await earlier(TEXT_DIFF, { sha: HEAD, reviewedSha: HEAD }));
    seed(ATTEMPT_KEY, attempt());

    const result = await changed(env, retargeted);

    expect(result).toMatchObject({ handler_action: "check_needs_review" });
    expect(posted()[1]).toMatchObject({ headSha: HEAD, externalId: "open-inspect:pr=42" });
    expect(posted()[2]).toMatchObject({ conclusion: "action_required", reviewAction: true });
    expect(posted()[2].output.summary).toContain("The base branch changed to `release`.");
    expect(json(VERDICT_KEY)).toBeNull();
    expect(json(ATTEMPT_KEY)).toBeNull();
  });

  it("keeps an attempt that is reviewing an earlier head", async () => {
    const { env, seed, json } = createEnv();
    seed(ATTEMPT_KEY, attempt({ headSha: OLD_HEAD }));

    await changed(env, retargeted);

    expect(json(ATTEMPT_KEY)).toMatchObject({ headSha: OLD_HEAD });
  });
});

describe("normalizeDiff", () => {
  const BINARY = (from: string, to: string) =>
    [
      "diff --git a/logo.png b/logo.png",
      `index ${from}..${to} 100644`,
      "Binary files a/logo.png and b/logo.png differ",
    ].join("\n");

  it("drops only blob ids and hunk line numbers from a text file", () => {
    expect(normalizeDiff(TEXT_DIFF)).toBe(
      [
        "diff --git a/src/cache.ts b/src/cache.ts",
        "--- a/src/cache.ts",
        "+++ b/src/cache.ts",
        "@@ export function read() {",
        " const key = id;",
        "+const ttl = 60;",
        " return store.get(key);",
      ].join("\n")
    );
  });

  it("keeps content lines that only look like headers", () => {
    const diff = `${TEXT_DIFF}\n-index me\n+@@ -1 +1 @@ kept`;
    expect(normalizeDiff(diff)).toContain("-index me\n+@@ -1 +1 @@ kept");
  });

  it("tells a replaced binary file from the one that was reviewed", () => {
    expect(normalizeDiff(BINARY("aaaaaaa", "bbbbbbb"))).not.toBe(
      normalizeDiff(BINARY("aaaaaaa", "ccccccc"))
    );
    expect(normalizeDiff(BINARY("aaaaaaa", "bbbbbbb"))).toContain("index aaaaaaa..bbbbbbb");
  });

  it("keeps a binary file's identity next to a text file whose blob ids are dropped", () => {
    const both = (binaryTo: string, textIndex: string) =>
      normalizeDiff(
        `${BINARY("aaaaaaa", binaryTo)}\n${TEXT_DIFF.replace("index 1111111..2222222", textIndex)}`
      );
    expect(both("bbbbbbb", "index 1111111..2222222")).toBe(
      both("bbbbbbb", "index 5555555..6666666")
    );
    expect(both("bbbbbbb", "index 1111111..2222222")).not.toBe(
      both("ccccccc", "index 1111111..2222222")
    );
  });

  it("keeps mode changes", () => {
    const mode = (to: string) =>
      ["diff --git a/run.sh b/run.sh", "old mode 100644", `new mode ${to}`].join("\n");
    expect(normalizeDiff(mode("100755"))).toBe(mode("100755"));
    const withHunk = (to: string) =>
      `${mode(to)}\nindex 1111111..2222222\n--- a/run.sh\n+++ b/run.sh\n@@ -1 +1 @@\n-a\n+b`;
    expect(normalizeDiff(withHunk("100755"))).not.toBe(normalizeDiff(withHunk("100644")));
  });

  it("tells the same hunk in two files apart", () => {
    const inFile = (path: string) => TEXT_DIFF.replaceAll("src/cache.ts", path);
    expect(normalizeDiff(inFile("src/a.ts"))).not.toBe(normalizeDiff(inFile("src/b.ts")));
  });

  it("tells hunks apart by their context text and their order", () => {
    expect(normalizeDiff(TEXT_DIFF)).not.toBe(
      normalizeDiff(TEXT_DIFF.replace("export function read()", "export function write()"))
    );
    const second = "@@ -30,2 +31,3 @@ export function write() {\n line\n+added";
    const [header, hunk] = [
      TEXT_DIFF.split("\n").slice(0, 4).join("\n"),
      TEXT_DIFF.split("\n").slice(4).join("\n"),
    ];
    expect(normalizeDiff(`${header}\n${hunk}\n${second}`)).not.toBe(
      normalizeDiff(`${header}\n${second}\n${hunk}`)
    );
  });
});
