import { beforeEach, describe, expect, it } from "vitest";
import { REVIEW_HEAD_GIVE_UP_MS } from "../../src/github-review/gate";
import { cleanD1Tables } from "./cleanup";
import { harness, HEAD, started, verdictBlock } from "./github-review-gate-harness";

beforeEach(cleanD1Tables);

describe("a check that shows a pass the facts no longer support", () => {
  it("is never given up on, however long GitHub cannot be written", async () => {
    const h = harness();
    await started(h);
    await h.complete("session-1", verdictBlock("approve"));
    expect(h.shown(HEAD)).toBe("success");
    // The base branch changes while the check cannot be written, for longer than the
    // recovery pass keeps trying an ordinary head.
    h.world.updateFails = true;
    await h.change("base");
    h.clock.now += REVIEW_HEAD_GIVE_UP_MS + 60_000;
    await h.gate.recover();
    h.world.updateFails = false;

    h.clock.now += 3_600_000;
    await h.gate.recover();

    expect(h.shown(HEAD)).toBe("action_required");
  });

  it("is retried less and less often, up to once an hour", async () => {
    const h = harness();
    await started(h);
    await h.complete("session-1", verdictBlock("approve"));
    h.world.updateFails = true;
    await h.change("base");
    const dueIn = async (ms: number) =>
      (await h.store.listDirtyHeads(h.clock.now + ms, 0)).map((head) => head.headSha);

    // Right after the failure it waits a minute; a day later, an hour between attempts.
    expect(await dueIn(30_000)).toEqual([]);
    expect(await dueIn(61_000)).toEqual([HEAD]);
    h.clock.now += 24 * 3_600_000;
    await h.gate.recover();
    expect(await dueIn(59 * 60_000)).toEqual([]);
    expect(await dueIn(61 * 60_000)).toEqual([HEAD]);
  });

  it("gives up on a head that shows no pass, until its next event", async () => {
    const h = harness();
    h.world.createFails = true;
    await h.change("head");
    h.clock.now += REVIEW_HEAD_GIVE_UP_MS + 3_600_000;
    h.world.createFails = false;
    await h.gate.recover();
    expect(h.world.checks).toEqual([]);

    // The same head event again, with nothing to carry: the head is looked at afresh.
    expect(await h.change("head")).toEqual({ outcome: "needs_review" });

    expect(h.shown(HEAD)).toBe("action_required");
  });
});

describe("a reconciler that outlives its lease", () => {
  it("does not leave its late write standing over a newer one", async () => {
    const h = harness();
    await started(h);
    // The reconciler of the approval is slow: its reads use up most of its lease, and
    // its write would still be in flight when the lease runs out. Meanwhile the base
    // branch changes, another reconciler takes the head over and writes that, and only
    // then does the first write land, its answer lost.
    h.world.duringNextRead = async () => {
      h.clock.now += 4 * 60_000;
    };
    h.world.duringNextUpdateThenLost = async () => {
      h.clock.now += 2 * 60_000;
      await h.change("base");
    };

    await h.complete("session-1", verdictBlock("approve"));
    h.clock.now += 10 * 60_000;
    await h.gate.recover();
    h.clock.now += 10 * 60_000;
    await h.gate.recover();

    // Whatever happened in between, GitHub must end up showing what the facts say.
    const passes = h.shown(HEAD) === "success";
    expect(passes).toBe((await h.evidence())?.kind === "review");
  });
});
