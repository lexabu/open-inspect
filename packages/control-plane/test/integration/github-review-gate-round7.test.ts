import { beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";
import { harness, NEW_BASE, NEW_HEAD, started, verdictBlock } from "./github-review-gate-harness";

beforeEach(cleanD1Tables);

const THIRD_HEAD = "e".repeat(40);
const LATER_BASE = "f".repeat(40);

describe("a head the pull request returns to, resting on a carried verdict", () => {
  it("does not claim the diff is unchanged once the base changed it", async () => {
    const h = harness();
    await started(h);
    await h.complete("session-1", verdictBlock("request_changes"));
    h.world.pull = { ...h.world.pull!, headSha: NEW_HEAD, baseSha: NEW_BASE };
    expect(await h.change("head")).toEqual({ outcome: "carried_forward" });
    expect(h.state(NEW_HEAD)).toMatchObject({
      output: { title: "Not approved (carried forward)" },
    });
    h.world.pull = { ...h.world.pull!, headSha: THIRD_HEAD };
    await h.change("head");
    // The base advances and changes that head's diff; a force-push returns to it.
    h.world.diffs.set(`${LATER_BASE}...${NEW_HEAD}`, "hash-of-another-diff");
    h.world.pull = { ...h.world.pull!, headSha: NEW_HEAD, baseSha: LATER_BASE };

    expect(await h.change("head")).toEqual({ outcome: "needs_review" });

    expect(h.state(NEW_HEAD)).toMatchObject({
      conclusion: "action_required",
      output: { title: "Re-run the AI review before merging" },
    });
    expect(h.state(NEW_HEAD)?.output.summary).not.toContain("diff is unchanged");
  });

  it("adopts a newer verdict of the same diff in place of the one it carried", async () => {
    const h = harness();
    await started(h);
    await h.complete("session-1", verdictBlock("approve"));
    h.world.pull = { ...h.world.pull!, headSha: NEW_HEAD, baseSha: NEW_BASE };
    await h.change("head");
    expect(h.shown(NEW_HEAD)).toBe("success");
    // A third head with the same diff is reviewed in its own right, and rejected.
    h.world.pull = { ...h.world.pull!, headSha: THIRD_HEAD };
    const newer = await started(h);
    await h.complete("session-2", verdictBlock("request_changes"));
    h.world.pull = { ...h.world.pull!, headSha: NEW_HEAD };

    expect(await h.change("head")).toEqual({ outcome: "carried_forward" });

    expect(await h.evidence(NEW_HEAD)).toEqual({ kind: "carried", attemptId: newer });
    expect(h.state(NEW_HEAD)).toMatchObject({
      conclusion: "failure",
      output: { title: "Not approved (carried forward)" },
    });
  });

  it("says a review is needed when the carry it rests on is obsolete and nothing replaces it", async () => {
    const h = harness();
    await started(h);
    await h.complete("session-1", verdictBlock("approve"));
    h.world.pull = { ...h.world.pull!, headSha: NEW_HEAD, baseSha: NEW_BASE };
    await h.change("head");
    // A third head with another diff is reviewed; its verdict is the latest.
    h.world.diffs.set(`${NEW_BASE}...${THIRD_HEAD}`, "hash-of-another-diff");
    h.world.pull = { ...h.world.pull!, headSha: THIRD_HEAD };
    await started(h);
    await h.complete("session-2", verdictBlock("approve"));
    h.world.pull = { ...h.world.pull!, headSha: NEW_HEAD };

    expect(await h.change("head")).toEqual({ outcome: "needs_review" });
    expect(h.shown(NEW_HEAD)).toBe("action_required");
  });
});
