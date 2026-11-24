import { beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";
import {
  harness,
  HEAD,
  NEW_BASE,
  NEW_HEAD,
  started,
  verdictBlock,
} from "./github-review-gate-harness";

beforeEach(cleanD1Tables);

const THIRD_HEAD = "e".repeat(40);

describe("a write whose record was lost", () => {
  it("is written over, not trusted: a pass that landed unrecorded does not stand", async () => {
    const h = harness();
    await h.change("reopened");
    // The override's success lands on GitHub, and the record of it is lost.
    h.loseNextPublicationRecord();
    await h.override();
    expect(h.shown(HEAD)).toBe("success");

    // Reopened again: the state due is the very one last on record as published.
    await h.change("reopened");
    h.clock.now += 3_600_000;
    await h.gate.recover();

    expect(h.shown(HEAD)).toBe("action_required");
  });

  it("does not create a second run when the first was created and not recorded", async () => {
    const h = harness();
    h.loseNextPublicationRecord();
    await h.change("head");
    expect(h.world.checks).toHaveLength(1);

    h.clock.now += 3_600_000;
    await h.gate.recover();
    await started(h);

    expect(h.world.checks).toHaveLength(1);
    expect(h.shown(HEAD)).toBe("in_progress");
  });
});

describe("a head the pull request returns to", () => {
  it("is validated again, not left showing what it showed before", async () => {
    const h = harness();
    const first = h.world.pull!;
    await started(h);
    await h.complete("session-1", verdictBlock("approve"));
    h.world.pull = { ...first, headSha: NEW_HEAD };
    await h.change("head");
    // The base branch moves on so that the first head's diff is no longer the one
    // reviewed, and the pull request is force-pushed back to that head.
    h.world.diffs.set(`${NEW_BASE}...${HEAD}`, "hash-of-another-diff");
    h.world.pull = { ...first, baseSha: NEW_BASE };

    await h.change("head");

    expect(h.shown(HEAD)).toBe("action_required");
  });
});

describe("a carried verdict and a newer verdict", () => {
  /** An approved first head, then a second head with another diff, under review. */
  async function approvedThenReviewingAnother(h: ReturnType<typeof harness>) {
    await started(h);
    await h.complete("session-1", verdictBlock("approve"));
    h.world.diffs.set(`${h.world.pull!.baseSha}...${NEW_HEAD}`, "hash-of-another-diff");
    h.world.pull = { ...h.world.pull!, headSha: NEW_HEAD };
    await started(h);
    // A third head whose diff is the first head's again.
    h.world.pull = { ...h.world.pull!, headSha: THIRD_HEAD };
  }

  it("does not carry an approval when a rejection lands while it is being carried", async () => {
    const h = harness();
    await approvedThenReviewingAnother(h);
    h.world.duringNextHash = () => h.complete("session-2", verdictBlock("request_changes"));

    await h.change("head");

    expect(h.shown(THIRD_HEAD)).toBe("action_required");
  });

  it("drops a carried approval when a newer verdict lands after it", async () => {
    const h = harness();
    await approvedThenReviewingAnother(h);
    await h.change("head");
    expect(h.shown(THIRD_HEAD)).toBe("success");

    await h.complete("session-2", verdictBlock("request_changes"));

    expect(h.shown(THIRD_HEAD)).toBe("action_required");
  });
});

describe("an override and the base it was given for", () => {
  it("does not pass when the base branch changes while the override is being recorded", async () => {
    const h = harness();
    // The retarget lands after the override has read the pull request and before it is
    // on record.
    h.world.duringNextShared = async () => {
      h.world.pull = { ...h.world.pull!, baseRef: "release" };
      await h.change("base");
    };

    await h.override();

    expect(h.shown(HEAD)).toBe("action_required");
    expect(h.state(HEAD)?.output.summary).toContain("from `main` to `release`");
  });

  it("stands when the base branch only moved on and the diff is the same", async () => {
    const h = harness();
    await h.override();
    h.world.pull = { ...h.world.pull!, baseSha: NEW_BASE };

    await h.change("head");

    expect(h.shown(HEAD)).toBe("success");
  });

  it("asks for a review when the base branch moved on and the diff changed", async () => {
    const h = harness();
    await h.override();
    h.world.diffs.set(`${NEW_BASE}...${HEAD}`, "hash-of-another-diff");
    h.world.pull = { ...h.world.pull!, baseSha: NEW_BASE };

    await h.change("head");

    expect(h.shown(HEAD)).toBe("action_required");
  });
});
