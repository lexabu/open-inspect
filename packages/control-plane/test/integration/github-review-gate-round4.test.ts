import { beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";
import { harness, NEW_BASE, NEW_HEAD, started, verdictBlock } from "./github-review-gate-harness";

beforeEach(cleanD1Tables);

const conclusionOf = (state: { status: string; conclusion?: string } | undefined) =>
  state?.status === "completed" ? state.conclusion : state?.status;

describe("an override is about one commit", () => {
  it("leaves a review of a newer head running", async () => {
    const h = harness();
    // After the override's check is posted on the old head and before the override is
    // stored, a push arrives and a review of the new head starts.
    let reviewOfNewHead = "";
    h.world.afterNextCreate = async () => {
      // A new object: the override goes on with the pull request as it read it.
      h.world.pull = { ...h.world.pull!, headSha: NEW_HEAD };
      reviewOfNewHead = await started(h);
    };

    expect(await h.override()).toMatchObject({ outcome: "overridden" });

    expect(await h.attemptStatus(reviewOfNewHead)).toBe("running");
    const itsRun = h.world.checks.find((check) => check.externalId.includes(reviewOfNewHead));
    expect(itsRun?.states.at(-1)).toMatchObject({ status: "in_progress" });
  });
});

describe("a head event that races a review start", () => {
  it("does not leave a carried approval newer than the review's own check", async () => {
    const h = harness();
    await started(h);
    await h.complete("session-1", verdictBlock("approve"));
    h.world.pull!.headSha = NEW_HEAD;
    h.world.pull!.baseSha = NEW_BASE;
    // A review of the new head starts after the head event saw none running and before
    // it posts its carried-forward check.
    h.world.duringNextHash = () => h.start();

    await h.change("head");
    await h.complete("session-2", verdictBlock("request_changes"));

    // The review of this head says changes requested; the newest run must not pass.
    expect(["success", "neutral"]).not.toContain(
      conclusionOf(h.world.checks.at(-1)?.states.at(-1))
    );
  });
});

describe("a start that fails after it was replaced", () => {
  it("leaves the replacement's close of its run alone", async () => {
    const h = harness();
    // An override replaces the attempt while its reviewer is being prompted; the prompt
    // then fails.
    h.sessions.prompt = async () => {
      await h.override();
      throw new Error("session refused its prompt");
    };

    await expect(h.start()).rejects.toThrow("session refused its prompt");

    expect(h.latest(1)).toMatchObject({ output: { title: "Superseded" } });
  });

  it("does not supersede another review that became active meanwhile", async () => {
    const h = harness();
    let other = "";
    const prompt = h.sessions.prompt;
    h.sessions.prompt = async (sessionId, reviewer, nonce) => {
      if (other !== "") return prompt(sessionId, reviewer, nonce);
      // This attempt is replaced by an override, a push arrives, and a review of the
      // new head starts; only then does this attempt's prompt fail.
      await h.override();
      h.world.pull = { ...h.world.pull!, headSha: NEW_HEAD };
      other = "starting";
      other = await started(h);
      throw new Error("session refused its prompt");
    };

    await expect(h.start()).rejects.toThrow("session refused its prompt");

    expect(await h.attemptStatus(other)).toBe("running");
  });
});
