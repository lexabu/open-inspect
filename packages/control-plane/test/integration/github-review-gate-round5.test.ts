import { beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";
import { harness, NEW_BASE, NEW_HEAD, started, verdictBlock } from "./github-review-gate-harness";

beforeEach(cleanD1Tables);

/** A concluded, approving review of the first head, then a base-only push to NEW_HEAD. */
async function approvedThenPushed(h: ReturnType<typeof harness>) {
  await started(h);
  await h.complete("session-1", verdictBlock("approve"));
  h.world.pull = { ...h.world.pull!, headSha: NEW_HEAD, baseSha: NEW_BASE };
}

describe("a head event that races a review of the same head", () => {
  it("shows the review's rejection, not the approval the head event carried forward", async () => {
    const h = harness();
    await approvedThenPushed(h);
    // While the head event is still working, a review of the new head starts and rejects.
    h.world.duringNextHash = async () => {
      await h.start();
      await h.complete("session-2", verdictBlock("request_changes"));
    };

    await h.change("head");

    expect(h.shown(NEW_HEAD)).toBe("failure");
  });

  it("shows the review's approval when it lands after the head event", async () => {
    const h = harness();
    await approvedThenPushed(h);
    h.world.diffs.set(`${NEW_BASE}...${NEW_HEAD}`, "hash-of-another-diff");
    h.world.duringNextHash = () => h.start();

    await h.change("head");
    await h.complete("session-2", verdictBlock("approve"));

    expect(h.shown(NEW_HEAD)).toBe("success");
  });
});

describe("a reopening whose check cannot be written", () => {
  it("still drops what was running: a review from before the reopening cannot pass", async () => {
    const h = harness();
    await started(h);
    h.world.createFails = true;
    h.world.updateFails = true;
    // The reopening is recorded even though GitHub cannot be written to right now.
    await h.change("reopened").catch(() => undefined);
    h.world.createFails = false;
    h.world.updateFails = false;

    await h.complete("session-1", verdictBlock("approve"));
    await h.gate.recover();

    expect(h.shown(h.world.pull!.headSha)).not.toBe("success");
  });
});
