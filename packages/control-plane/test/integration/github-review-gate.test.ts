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
    });
    expect(await h.evidence()).toEqual({ kind: "review", attemptId });
    expect(h.world.checks).toEqual([
      {
        id: 1,
        headSha: HEAD,
        externalId: "open-inspect:pr=42",
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

  it("supersedes a review of an earlier head, whose check then asks for a review", async () => {
    const h = harness();
    const first = await started(h);
    h.world.pull = { ...h.world.pull!, headSha: NEW_HEAD };

    const second = await started(h);

    expect(await h.attemptStatus(first)).toBe("superseded");
    expect(await h.attemptStatus(second)).toBe("running");
    expect(h.state(HEAD)).toMatchObject({ status: "completed", conclusion: "action_required" });
    expect(h.state(HEAD)?.output.summary).toContain("A review of a newer commit replaced");
    expect(h.shown(NEW_HEAD)).toBe("in_progress");
    expect(h.world.checks).toHaveLength(2);

    // The replaced review can no longer decide anything, on either head.
    await h.complete("session-1", verdictBlock("approve"));
    expect(h.shown(HEAD)).toBe("action_required");
    expect(h.shown(NEW_HEAD)).toBe("in_progress");
  });

  it("leaves no running attempt behind when a session cannot be created", async () => {
    const h = harness();
    h.sessions.failOn = 2;

    await expect(h.start([HAIKU, SOL])).rejects.toThrow("sandbox quota exceeded");

    expect(h.sessions.prompted).toEqual([]);
    expect(await h.evidence()).toEqual({
      kind: "none",
      note: "The AI review could not be started.",
    });
    // Nothing is running, so the head must not be left in progress or passing.
    expect(h.shown(HEAD)).toBe("action_required");
    h.sessions.failOn = null;
    expect(await h.start()).toMatchObject({ outcome: "started" });
    expect(h.shown(HEAD)).toBe("in_progress");
    expect(h.world.checks).toHaveLength(1);
  });

  it("reviews again on the same check run when a concluded head is re-run", async () => {
    const h = harness();
    await started(h);
    await h.complete("session-1", verdictBlock("request_changes"));

    await started(h);
    expect(h.shown(HEAD)).toBe("in_progress");
    await h.complete("session-2", verdictBlock("approve"));

    expect(h.world.checks).toHaveLength(1);
    expect(h.world.checks[0].states.map((state) => state.output.title)).toEqual([
      "AI review in progress",
      "Changes requested",
      "AI review in progress",
      "Approved",
    ]);
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
    expect(await h.evidence()).toEqual({ kind: "review", attemptId });
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
    expect(await h.store.findCarrySource({ repoId: 99, prNumber: 42 })).toBeNull();
  });

  it("takes each session's first report and nothing after it", async () => {
    const h = harness();
    await started(h);

    await h.complete("session-1", verdictBlock("request_changes"));
    await h.complete("session-1", verdictBlock("approve"));

    expect(h.latest(1)).toMatchObject({ conclusion: "failure" });
    expect(h.world.checks[0].states).toHaveLength(2);
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
      "could not be shown to be the one that was reviewed",
    ],
    [
      "the base moved on and the diff cannot be hashed",
      (h: ReturnType<typeof harness>) => {
        h.world.pull!.baseSha = NEW_BASE;
        h.world.diffs.set(`${NEW_BASE}...${HEAD}`, null);
      },
      "could not be shown to be the one that was reviewed",
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
    expect(await h.store.findCarrySource({ repoId: 99, prNumber: 42 })).toMatchObject({
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

describe("the time limit", () => {
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

    // A session that reports after the limit changes nothing.
    await h.complete("session-2", verdictBlock("approve"));
    expect(h.latest(1)).toMatchObject({ output: { title: "The AI review did not finish" } });
  });

  it("concludes an old attempt that never recorded a session, so a new review can start", async () => {
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

    h.clock.now += 120_000;
    await h.gate.recover();

    expect(await h.attemptStatus("orphan")).toBe("concluded");
    expect(h.state(HEAD)).toMatchObject({
      conclusion: "failure",
      output: { title: "The AI review did not finish" },
    });
    expect(await h.start()).toMatchObject({ outcome: "started" });
  });
});

describe("a pull request that changed", () => {
  /** A concluded, approving review of HEAD, then a push to NEW_HEAD. */
  async function reviewedThenPushed(h: ReturnType<typeof harness>, verdict = "approve") {
    const attemptId = await started(h);
    await h.complete("session-1", verdictBlock(verdict));
    h.world.pull = { ...h.world.pull!, headSha: NEW_HEAD, baseSha: NEW_BASE };
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

    expect(h.state(NEW_HEAD)).toMatchObject({
      conclusion: "success",
      reviewAction: false,
      output: { title: "Approved (carried forward)" },
    });
    expect(h.state(NEW_HEAD)?.output.summary).toContain("Carried forward from commit `aaaaaaa`");
    expect(await h.evidence()).toEqual({ kind: "carried", attemptId });
    // The evidence outlives the verdict that rests on it.
    expect(await h.attemptStatus(attemptId)).toBe("concluded");
  });

  it("carries a failed verdict forward as a failure", async () => {
    const h = harness();
    await reviewedThenPushed(h, "request_changes");
    h.world.shared = "Commit is also the head of #57.";

    expect(await h.change("head")).toEqual({ outcome: "carried_forward" });
    expect(h.state(NEW_HEAD)).toMatchObject({
      conclusion: "failure",
      reviewAction: true,
      output: { title: "Not approved (carried forward)" },
    });
  });

  it("carries an approval onward, from the review, over several pushes", async () => {
    const h = harness();
    const attemptId = await reviewedThenPushed(h);
    await h.change("head");
    const third = "e".repeat(40);
    h.world.pull = { ...h.world.pull!, headSha: third };

    expect(await h.change("head")).toEqual({ outcome: "carried_forward" });

    expect(await h.evidence(third)).toEqual({ kind: "carried", attemptId });
    expect(h.shown(third)).toBe("success");
  });

  it("holds a carried approval back while another pull request shares the new head", async () => {
    const h = harness();
    await reviewedThenPushed(h);
    h.world.shared = "Commit is also the head of #57.";

    expect(await h.change("head")).toEqual({ outcome: "carried_forward" });

    expect(h.state(NEW_HEAD)).toMatchObject({ conclusion: "action_required" });
    expect(h.state(NEW_HEAD)?.output.summary).toContain("#57");
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
  ])("asks for a review instead of carrying an approval when %s", async (_name, arrange, text) => {
    const h = harness();
    await reviewedThenPushed(h);
    arrange(h);

    expect(await h.change("head")).toEqual({ outcome: "needs_review" });

    expect(h.state(NEW_HEAD)).toMatchObject({ status: "completed", conclusion: "action_required" });
    expect(h.state(NEW_HEAD)?.output.summary).toContain(text);
    expect(await h.evidence()).toMatchObject({ kind: "none" });
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
    ["base", "The base branch changed."],
    ["reopened", "The pull request was reopened."],
  ] as const)("drops the verdict and the running review on a %s change", async (kind, text) => {
    const h = harness();
    await started(h);
    await h.complete("session-1", verdictBlock("approve"));
    h.world.pull = { ...h.world.pull!, headSha: NEW_HEAD };
    const running = await started(h);
    if (kind === "base") h.world.pull = { ...h.world.pull!, baseRef: "release" };

    expect(await h.change(kind)).toEqual({ outcome: "needs_review" });

    expect(await h.attemptStatus(running)).toBe("superseded");
    expect(h.state(NEW_HEAD)).toMatchObject({ conclusion: "action_required" });
    expect(h.state(NEW_HEAD)?.output.summary).toContain(text);
    // The earlier head's approval is gone too: it was of another pull request.
    expect(h.shown(HEAD)).toBe("action_required");
    expect(h.world.checks).toHaveLength(2);

    // The dropped review can no longer decide anything, and nothing carries over.
    await h.complete("session-2", verdictBlock("approve"));
    expect(h.shown(NEW_HEAD)).toBe("action_required");
    expect(await h.store.findCarrySource({ repoId: 99, prNumber: 42 })).toBeNull();
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
      reason: "already_covered",
    });
    expect(h.world.checks).toHaveLength(1);
    expect(h.shown(HEAD)).toBe("in_progress");
  });

  it("leaves a running review's check alone when the head event arrives late", async () => {
    const h = harness();
    await started(h);

    expect(await h.change("head")).toEqual({ outcome: "skipped", reason: "already_covered" });
    expect(h.world.checks).toHaveLength(1);
    expect(h.world.checks[0].states).toHaveLength(1);
  });
});

describe("override", () => {
  it("passes the head's check, records it, and ends the running review", async () => {
    const h = harness();
    const running = await started(h);

    expect(await h.override()).toEqual({ outcome: "overridden", headSha: HEAD });

    expect(h.world.checks).toHaveLength(1);
    expect(h.state(HEAD)).toEqual({
      status: "completed",
      conclusion: "success",
      output: {
        title: "Overridden by @bob",
        summary:
          "@bob overrode the AI Review check on commit `aaaaaaa`.\n\nReason: verified by hand",
      },
      reviewAction: false,
    });
    expect(await h.evidence()).toEqual({ kind: "override", by: "bob", reason: "verified by hand" });
    expect(await h.attemptStatus(running)).toBe("superseded");

    // The review that was in flight reports afterwards: the override stands.
    await h.complete("session-1", verdictBlock("request_changes"));
    expect(h.state(HEAD)).toMatchObject({ output: { title: "Overridden by @bob" } });
  });

  it("applies to the commit it names only: a later head asks for a review", async () => {
    const h = harness();
    await h.override();
    // The same diff on a new head, as after "Update branch": a review would carry forward.
    h.world.pull = { ...h.world.pull!, headSha: NEW_HEAD };

    expect(await h.change("head")).toEqual({ outcome: "needs_review" });
    expect(h.shown(NEW_HEAD)).toBe("action_required");
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
    expect(await h.evidence()).toBeUndefined();
  });
});
