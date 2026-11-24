import { beforeEach, describe, expect, it } from "vitest";
import { REVIEW_ATTEMPT_TIMEOUT_MS } from "../../src/github-review/gate";
import { cleanD1Tables } from "./cleanup";
import {
  BASE,
  HAIKU,
  harness,
  HEAD,
  NEW_BASE,
  NEW_HEAD,
  pullKey,
  repository,
  SOL,
  started,
  verdictBlock,
} from "./github-review-gate-harness";

beforeEach(cleanD1Tables);

describe("starting a review", () => {
  it("claims an attempt, starts one session per reviewer and shows the check in progress", async () => {
    const h = harness();

    const response = await h.start([HAIKU, SOL]);

    expect(response).toEqual({
      outcome: "started",
      attemptId: expect.any(String),
      sessions: [
        { sessionId: "session-1", messageId: "message-for-session-1", model: HAIKU },
        { sessionId: "session-2", messageId: "message-for-session-2", model: SOL },
      ],
    });
    const attemptId = response.outcome === "started" ? response.attemptId : "";
    expect(await h.store.getAttempt(attemptId)).toMatchObject({
      status: "running",
      repoId: 99,
      prNumber: 42,
      headSha: HEAD,
      baseRef: "main",
      baseSha: BASE,
      diffHash: "hash-of-the-usual-diff",
      checkRunId: 1,
    });
    expect(h.world.checks).toEqual([
      {
        id: 1,
        headSha: HEAD,
        externalId: `open-inspect:pr=42;attempt=${attemptId}`,
        states: [expect.objectContaining({ status: "in_progress" })],
      },
    ]);
    expect((await h.store.listSessions(attemptId)).map((session) => session.verdict)).toEqual([
      null,
      null,
    ]);
  });

  it.each([
    ["merge_gate_off", (h: ReturnType<typeof harness>) => (h.settings.mode = "off")],
    ["pr_not_open", (h: ReturnType<typeof harness>) => (h.world.pull!.open = false)],
    ["draft_pr", (h: ReturnType<typeof harness>) => (h.world.pull!.draft = true)],
    ["stale_head", (h: ReturnType<typeof harness>) => (h.world.pull!.headSha = NEW_HEAD)],
  ])(
    "skips with %s, read from the live pull request, and starts nothing",
    async (reason, arrange) => {
      const h = harness();
      const request = h.request();
      arrange(h);

      expect(await h.gate.start(request, repository, h.sessions)).toEqual({
        outcome: "skipped",
        reason,
      });
      expect(h.sessions.prompted).toEqual([]);
      expect(h.world.checks).toEqual([]);
    }
  );

  it("starts one attempt when two starts race, and when a click repeats", async () => {
    const h = harness();

    const outcomes = await Promise.all([h.start(), h.start(), h.start()]);
    const again = await h.start();

    expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual([
      "skipped",
      "skipped",
      "started",
    ]);
    expect(again).toEqual({ outcome: "skipped", reason: "review_in_progress" });
    expect(h.sessions.prompted).toEqual(["session-1"]);
    expect(h.world.checks).toHaveLength(1);
  });

  it("supersedes a review of an earlier head, and closes its check run", async () => {
    const h = harness();
    const first = await started(h);
    h.world.pull!.headSha = NEW_HEAD;

    const second = await started(h);

    expect(await h.attemptStatus(first)).toBe("superseded");
    expect(await h.attemptStatus(second)).toBe("running");
    expect(h.latest(1)).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
      output: { title: "Superseded" },
      reviewAction: false,
    });
    expect(h.world.checks[1]).toMatchObject({ headSha: NEW_HEAD });
  });

  it("leaves no running attempt behind when a session cannot be created", async () => {
    const h = harness();
    h.sessions.failOn = 2;

    await expect(h.start([HAIKU, SOL])).rejects.toThrow("sandbox quota exceeded");

    expect(await h.store.getActiveAttempt(pullKey)).toBeNull();
    expect(h.sessions.prompted).toEqual([]);
    h.sessions.failOn = null;
    expect(await h.start()).toMatchObject({ outcome: "started" });
  });

  it("still concludes when GitHub refused the in-progress check run", async () => {
    const h = harness();
    h.world.createFails = true;
    await started(h);
    expect(h.log.error).toHaveBeenCalledWith(
      "github_review.check_create_failed",
      expect.anything()
    );
    h.world.createFails = false;

    await h.complete("session-1", verdictBlock("approve"));

    expect(h.world.checks).toHaveLength(1);
    expect(h.latest(1)).toMatchObject({ status: "completed", conclusion: "success" });
  });
});

describe("concluding from the sessions' own verdicts", () => {
  it("passes the check when the reviewer approves, and keeps the verdict", async () => {
    const h = harness();
    const attemptId = await started(h);

    await h.complete("session-1", verdictBlock("approve", "Reads well."));

    expect(h.latest(1)).toEqual({
      status: "completed",
      conclusion: "success",
      output: { title: "Approved", summary: "- Claude Haiku 4.5: approve. Reads well." },
      reviewAction: false,
    });
    expect(await h.attemptStatus(attemptId)).toBe("concluded");
    expect(await h.store.getVerdict(pullKey)).toMatchObject({
      sha: HEAD,
      reviewedSha: HEAD,
      baseRef: "main",
      baseSha: BASE,
      diffHash: "hash-of-the-usual-diff",
      approved: true,
      attemptId,
    });
  });

  it.each([
    ["required", "failure"],
    ["shadow", "neutral"],
  ] as const)("concludes requested changes in %s mode as %s", async (mode, conclusion) => {
    const h = harness(mode);
    await started(h);

    await h.complete("session-1", verdictBlock("request_changes", "The cache never expires."));

    const state = h.latest(1);
    expect(state).toMatchObject({
      conclusion,
      reviewAction: true,
      output: { title: "Changes requested" },
    });
    const summary = state?.output.summary ?? "";
    expect(summary).toContain("- Claude Haiku 4.5: changes requested. The cache never expires.");
    expect(summary).toContain("`@test-bot override aaaaaaa <reason>`");
    expect(summary.includes("Shadow mode")).toBe(mode === "shadow");
    expect(await h.store.getVerdict(pullKey)).toMatchObject({ approved: false });
  });

  it("waits for every reviewer, and passes only when all approve", async () => {
    const h = harness();
    await started(h, [HAIKU, SOL]);

    await h.complete("session-1", verdictBlock("approve"));
    expect(h.latest(1)).toMatchObject({ status: "in_progress" });
    await h.complete("session-2", verdictBlock("request_changes", "Missing a test."));

    expect(h.latest(1)).toMatchObject({ conclusion: "failure" });
    expect(h.latest(1)?.output.summary).toContain(
      "- Claude Haiku 4.5: approve. Reads well.\n- GPT 5.6 Sol: changes requested. Missing a test."
    );
  });

  it.each([
    ["fails", "", false, "The session did not complete."],
    ["ends without a verdict", "I reviewed it and it looks fine.", true, "ended without a verdict"],
    [
      "ends with a verdict block that lacks its nonce",
      '```json\n{"verdict": "approve", "summary": "No nonce."}\n```',
      true,
      "ended without a verdict",
    ],
  ])("concludes as unfinished when a session %s", async (_name, message, success, text) => {
    const h = harness();
    const attemptId = await started(h, [HAIKU, SOL]);

    await h.complete("session-1", verdictBlock("approve"));
    await h.complete("session-2", message, success);

    const state = h.latest(1);
    expect(state).toMatchObject({
      conclusion: "failure",
      reviewAction: true,
      output: { title: "The AI review did not finish" },
    });
    expect(state?.output.summary).toContain(`- GPT 5.6 Sol: no verdict. `);
    expect(state?.output.summary).toContain(text);
    expect(state?.output.summary).toContain("Re-run this check");
    expect(await h.attemptStatus(attemptId)).toBe("concluded");
    // An unfinished review is evidence of nothing: no verdict to carry forward.
    expect(await h.store.getVerdict(pullKey)).toBeNull();
  });

  it("takes each session's first report and nothing after it", async () => {
    const h = harness();
    await started(h);

    await h.complete("session-1", verdictBlock("request_changes"));
    await h.complete("session-1", verdictBlock("approve"));

    expect(h.latest(1)).toMatchObject({ conclusion: "failure" });
    expect(await h.store.getVerdict(pullKey)).toMatchObject({ approved: false });
  });

  it("ignores a session that is not a reviewer session", async () => {
    const h = harness();
    await started(h);

    await h.complete("someone-elses-session", verdictBlock("approve"));

    expect(h.latest(1)).toMatchObject({ status: "in_progress" });
  });

  it("closes the check without blocking when the gate was turned off mid-review", async () => {
    const h = harness();
    await started(h);
    h.settings.mode = "off";

    await h.complete("session-1", verdictBlock("request_changes"));

    expect(h.latest(1)).toMatchObject({ status: "completed", conclusion: "neutral" });
  });
});

describe("an approval passes only the pull request that was reviewed", () => {
  it("passes when the base moved on but the diff is still the one reviewed", async () => {
    const h = harness();
    await started(h);
    h.world.pull!.baseSha = NEW_BASE;

    await h.complete("session-1", verdictBlock("approve"));

    expect(h.latest(1)).toMatchObject({ conclusion: "success" });
  });

  it.each([
    [
      "the base moved on and the diff changed",
      (h: ReturnType<typeof harness>) => {
        h.world.pull!.baseSha = NEW_BASE;
        h.world.diffs.set(`${NEW_BASE}...${HEAD}`, "hash-of-another-diff");
      },
      "moved during the review",
    ],
    [
      "the base moved on and the diff cannot be hashed",
      (h: ReturnType<typeof harness>) => {
        h.world.pull!.baseSha = NEW_BASE;
        h.world.diffs.set(`${NEW_BASE}...${HEAD}`, null);
      },
      "moved during the review",
    ],
    [
      "the base branch changed",
      (h: ReturnType<typeof harness>) => (h.world.pull!.baseRef = "release"),
      "from `main` to `release`",
    ],
    [
      "another open pull request shares the head commit",
      (h: ReturnType<typeof harness>) => (h.world.shared = "Commit is also the head of #57."),
      "#57",
    ],
    [
      "the commit is no longer the head",
      (h: ReturnType<typeof harness>) => (h.world.pull!.headSha = NEW_HEAD),
      "no longer the head",
    ],
    [
      "the pull request cannot be read",
      (h: ReturnType<typeof harness>) => (h.world.pull = null),
      "Could not read #42",
    ],
  ])("asks for a review instead when %s", async (_name, arrange, text) => {
    const h = harness();
    await started(h);
    arrange(h);

    await h.complete("session-1", verdictBlock("approve"));

    const state = h.latest(1);
    expect(state).toMatchObject({
      conclusion: "action_required",
      reviewAction: true,
      output: { title: "Re-run the AI review before merging" },
    });
    expect(state?.output.summary).toContain(text);
    // The reviewers did approve the diff they were given; that evidence is kept.
    expect(await h.store.getVerdict(pullKey)).toMatchObject({
      approved: true,
      diffHash: "hash-of-the-usual-diff",
    });
  });

  it("does not look for other pull requests before failing a check", async () => {
    const h = harness();
    await started(h);
    h.world.shared = "Commit is also the head of #57.";

    await h.complete("session-1", verdictBlock("request_changes"));

    expect(h.latest(1)).toMatchObject({ conclusion: "failure" });
  });
});

describe("recovery", () => {
  it("writes the check again when the conclusion could not be written", async () => {
    const h = harness();
    const attemptId = await started(h);
    h.world.updateFails = true;
    await expect(h.complete("session-1", verdictBlock("approve"))).rejects.toThrow(
      "could not be written"
    );
    expect(await h.attemptStatus(attemptId)).toBe("running");
    expect(await h.store.getVerdict(pullKey)).toBeNull();

    h.world.updateFails = false;
    await h.gate.recover();

    expect(h.latest(1)).toMatchObject({ conclusion: "success" });
    expect(await h.attemptStatus(attemptId)).toBe("concluded");
  });

  it("concludes an attempt as unfinished once its sessions are past the time limit", async () => {
    const h = harness("shadow");
    const attemptId = await started(h, [HAIKU, SOL]);
    await h.complete("session-1", verdictBlock("approve"));

    await h.gate.recover();
    expect(h.latest(1)).toMatchObject({ status: "in_progress" });

    h.clock.now += REVIEW_ATTEMPT_TIMEOUT_MS + 60_000;
    await h.gate.recover();

    expect(h.latest(1)).toMatchObject({
      conclusion: "neutral",
      output: { title: "The AI review did not finish" },
    });
    expect(h.latest(1)?.output.summary).toContain("did not report within the time limit");
    expect(await h.attemptStatus(attemptId)).toBe("concluded");
  });

  it("drops an old attempt that never recorded a session, so a new review can start", async () => {
    const h = harness();
    await h.store.claimAttempt(
      {
        id: "orphan",
        repoOwner: "acme",
        repoName: "widgets",
        repoId: 99,
        prNumber: 42,
        headSha: HEAD,
        baseRef: "main",
        baseSha: BASE,
        diffHash: null,
      },
      h.clock.now - REVIEW_ATTEMPT_TIMEOUT_MS - 60_000
    );
    expect(await h.start()).toEqual({ outcome: "skipped", reason: "review_in_progress" });

    await h.gate.recover();

    expect(await h.attemptStatus("orphan")).toBe("superseded");
    expect(await h.start()).toMatchObject({ outcome: "started" });
  });

  it("keeps going when one attempt cannot be recovered", async () => {
    const h = harness();
    await started(h);
    h.world.updateFails = true;
    await expect(h.complete("session-1", verdictBlock("approve"))).rejects.toThrow();

    await expect(h.gate.recover()).resolves.toBeUndefined();
    expect(h.log.error).toHaveBeenCalledWith("github_review.recovery_failed", expect.anything());
  });
});

describe("a pull request that changed", () => {
  /** A concluded, approving review of HEAD, then a push to NEW_HEAD. */
  async function reviewedThenPushed(h: ReturnType<typeof harness>, verdict = "approve") {
    const attemptId = await started(h);
    await h.complete("session-1", verdictBlock(verdict));
    h.world.pull!.headSha = NEW_HEAD;
    h.world.pull!.baseSha = NEW_BASE;
    return attemptId;
  }

  it.each([
    ["required", "action_required"],
    ["shadow", "neutral"],
  ] as const)(
    "asks for a review of a new head in %s mode, starting none",
    async (mode, conclusion) => {
      const h = harness(mode);

      expect(await h.change("head")).toEqual({ outcome: "needs_review" });

      expect(h.sessions.prompted).toEqual([]);
      expect(h.world.checks).toEqual([
        {
          id: 1,
          headSha: HEAD,
          externalId: "open-inspect:pr=42",
          states: [
            {
              status: "completed",
              conclusion,
              output: {
                title: "Re-run the AI review before merging",
                summary: expect.stringContaining("Click **Review now**"),
              },
              reviewAction: true,
            },
          ],
        },
      ]);
    }
  );

  it("carries the verdict forward when only the base moved", async () => {
    const h = harness();
    const attemptId = await reviewedThenPushed(h);

    expect(await h.change("head")).toEqual({ outcome: "carried_forward" });

    const carried = h.world.checks.at(-1);
    expect(carried).toMatchObject({ headSha: NEW_HEAD, externalId: "open-inspect:pr=42" });
    expect(carried?.states[0]).toMatchObject({
      conclusion: "success",
      reviewAction: false,
      output: { title: "Approved (carried forward)" },
    });
    expect(carried?.states[0].output.summary).toContain("Carried forward from commit `aaaaaaa`");
    expect(await h.store.getVerdict(pullKey)).toMatchObject({
      sha: NEW_HEAD,
      reviewedSha: HEAD,
      attemptId,
    });
    // The evidence outlives the verdict that rests on it.
    expect(await h.attemptStatus(attemptId)).toBe("concluded");
  });

  it("carries a failed verdict forward as a failure", async () => {
    const h = harness();
    await reviewedThenPushed(h, "request_changes");
    h.world.shared = "Commit is also the head of #57.";

    expect(await h.change("head")).toEqual({ outcome: "carried_forward" });
    expect(h.world.checks.at(-1)?.states[0]).toMatchObject({
      conclusion: "failure",
      reviewAction: true,
      output: { title: "Not approved (carried forward)" },
    });
  });

  it.each([
    [
      "the pull request's own diff changed",
      (h: ReturnType<typeof harness>) =>
        h.world.diffs.set(`${NEW_BASE}...${NEW_HEAD}`, "hash-of-another-diff"),
      "No AI review covers this diff.",
    ],
    [
      "the diff cannot be hashed, or is ambiguous",
      (h: ReturnType<typeof harness>) => h.world.diffs.set(`${NEW_BASE}...${NEW_HEAD}`, null),
      "No AI review covers this diff.",
    ],
    [
      "the verdict was reached against another base branch",
      (h: ReturnType<typeof harness>) => (h.world.pull!.baseRef = "release"),
      "No AI review covers this diff.",
    ],
    [
      "another open pull request shares the new head",
      (h: ReturnType<typeof harness>) => (h.world.shared = "Commit is also the head of #57."),
      "#57",
    ],
  ])("asks for a review instead of carrying an approval when %s", async (_name, arrange, text) => {
    const h = harness();
    await reviewedThenPushed(h);
    arrange(h);

    expect(await h.change("head")).toEqual({ outcome: "needs_review" });

    const state = h.world.checks.at(-1)?.states[0];
    expect(state).toMatchObject({ status: "completed", conclusion: "action_required" });
    expect(state?.output.summary).toContain(text);
    expect(await h.store.getVerdict(pullKey)).toMatchObject({ sha: HEAD });
  });

  it("never carries a verdict whose reviewed diff could not be hashed", async () => {
    const h = harness();
    h.world.diffs.set(`${BASE}...${HEAD}`, null);
    await reviewedThenPushed(h);
    h.world.diffs.set(`${NEW_BASE}...${NEW_HEAD}`, null);

    expect(await h.change("head")).toEqual({ outcome: "needs_review" });
  });

  it.each([
    ["stale_head", (h: ReturnType<typeof harness>) => (h.world.pull!.headSha = NEW_HEAD)],
    ["draft_pr", (h: ReturnType<typeof harness>) => (h.world.pull!.draft = true)],
    ["pr_not_open", (h: ReturnType<typeof harness>) => (h.world.pull!.open = false)],
    ["merge_gate_off", (h: ReturnType<typeof harness>) => (h.settings.mode = "off")],
  ])("skips a new head with %s, read from the live pull request", async (reason, arrange) => {
    const h = harness();
    arrange(h);

    // The event was about HEAD, whatever the pull request has become since.
    const response = await h.gate.pullChanged(
      {
        repository: { owner: "acme", name: "widgets" },
        pullNumber: 42,
        change: "head",
        headSha: HEAD,
      },
      repository
    );

    expect(response).toEqual({ outcome: "skipped", reason });
    expect(h.world.checks).toEqual([]);
  });

  it.each([
    ["base", "The base branch changed to `release`."],
    ["reopened", "The pull request was reopened."],
  ] as const)("drops the verdict and the running review on a %s change", async (kind, text) => {
    const h = harness();
    await started(h);
    await h.complete("session-1", verdictBlock("approve"));
    h.world.pull!.headSha = NEW_HEAD;
    const running = await started(h);
    if (kind === "base") h.world.pull!.baseRef = "release";

    expect(await h.change(kind)).toEqual({ outcome: "needs_review" });

    expect(await h.store.getVerdict(pullKey)).toBeNull();
    expect(await h.attemptStatus(running)).toBe("superseded");
    expect(h.latest(2)).toMatchObject({ conclusion: "cancelled", output: { title: "Superseded" } });
    const posted = h.world.checks.at(-1);
    expect(posted).toMatchObject({ headSha: NEW_HEAD, externalId: "open-inspect:pr=42" });
    expect(posted?.states[0].output.summary).toContain(text);

    // The superseded review can no longer decide anything.
    await h.complete("session-2", verdictBlock("approve"));
    expect(h.latest(2)).toMatchObject({ output: { title: "Superseded" } });
    expect(await h.store.getVerdict(pullKey)).toBeNull();
  });

  it("posts a check that asks for a review when the bot could not start one", async () => {
    const h = harness();

    expect(await h.change("review_not_started", "auto_review_disabled")).toEqual({
      outcome: "needs_review",
    });
    expect(h.world.checks[0].states[0].output.summary).toContain(
      "The AI review did not start (auto_review_disabled)."
    );
  });

  it("leaves a running review's check alone when told a review did not start", async () => {
    const h = harness();
    await started(h);

    expect(await h.change("review_not_started", "review_in_progress")).toEqual({
      outcome: "skipped",
      reason: "review_in_progress",
    });
    expect(h.world.checks).toHaveLength(1);
  });
});

describe("override", () => {
  it("passes the head's check, records it, and ends the running review", async () => {
    const h = harness();
    const running = await started(h);

    expect(await h.override()).toEqual({ outcome: "overridden", headSha: HEAD });

    expect(h.world.checks.at(-1)).toMatchObject({
      headSha: HEAD,
      externalId: "open-inspect:pr=42",
      states: [
        {
          status: "completed",
          conclusion: "success",
          output: {
            title: "Overridden by @bob",
            summary:
              "@bob overrode the AI Review check on commit `aaaaaaa`.\n\nReason: verified by hand",
          },
          reviewAction: false,
        },
      ],
    });
    expect(await h.store.getVerdict(pullKey)).toMatchObject({
      sha: HEAD,
      approved: true,
      attemptId: null,
    });
    expect(await h.attemptStatus(running)).toBe("superseded");
    expect(h.latest(1)).toMatchObject({ output: { title: "Superseded" } });

    // The review that was in flight reports afterwards: the override stands.
    await h.complete("session-1", verdictBlock("request_changes"));
    expect(await h.store.getVerdict(pullKey)).toMatchObject({ approved: true, attemptId: null });
    expect(h.latest(1)).toMatchObject({ output: { title: "Superseded" } });
  });

  it("applies to the commit it names only: a later head asks for a review", async () => {
    const h = harness();
    await h.override();
    // The same diff on a new head, as after "Update branch": a review would carry forward.
    h.world.pull!.headSha = NEW_HEAD;

    expect(await h.change("head")).toEqual({ outcome: "needs_review" });
    expect(h.world.checks.at(-1)?.states[0]).toMatchObject({ conclusion: "action_required" });
  });

  it.each([
    ["wrong_commit", () => harness().override("ccccccc"), "The head is `aaaaaaa`"],
    ["by_author", () => harness().override("aaaaaaa", "Alice"), "author"],
    [
      "shared_head",
      () => {
        const h = harness();
        h.world.shared = "Commit is also the head of #57.";
        return h.override();
      },
      "#57",
    ],
  ])("refuses with %s and a sentence for the commenter", async (reason, run, text) => {
    const response = await run();

    expect(response).toMatchObject({ outcome: "refused", reason });
    expect(response.outcome === "refused" ? response.detail : "").toContain(text);
  });

  it.each([
    ["pr_not_open", (h: ReturnType<typeof harness>) => (h.world.pull!.open = false)],
    ["merge_gate_off", (h: ReturnType<typeof harness>) => (h.settings.mode = "off")],
  ])("refuses with %s, quietly, and writes nothing", async (reason, arrange) => {
    const h = harness();
    arrange(h);

    expect(await h.override()).toEqual({ outcome: "refused", reason, detail: "" });
    expect(h.world.checks).toEqual([]);
    expect(await h.store.getVerdict(pullKey)).toBeNull();
  });
});
