import { describe, expect, it } from "vitest";
import { REVIEW_FOOTER_MARKER } from "./render";
import type { ReviewFooterDeps } from "./service";
import {
  bash,
  FakeGitHub,
  footer,
  message,
  OPUS,
  postedComment,
  postedReview,
  recalled,
  session,
} from "./service.test-support";

const SOL_REVIEW_FOOTER =
  "Findings via GPT-6.2 Sol · Hindsight memory: searched, 2 facts recalled · Bedrock cost: $0.05";

describe("ReviewFooter", () => {
  it("footers the review a GitHub-triggered turn posted, with platform data", async () => {
    const github = new FakeGitHub().add("review", 111, "**Verdict: Approve.**");
    const { footer: subject, log } = footer(github, [recalled(2), postedReview(111)]);

    await subject.apply("msg-1");

    expect(github.body("review", 111)).toBe(
      `**Verdict: Approve.**\n\n${REVIEW_FOOTER_MARKER}\n${SOL_REVIEW_FOOTER}`
    );
    expect(log.info).toHaveBeenCalledWith(
      "review_footer",
      expect.objectContaining({ outcome: "success", posts: { "review:111": "updated" } })
    );
  });

  it("footers a reply comment, using the message's own model over the session's", async () => {
    const github = new FakeGitHub().add("comment", 222, "Done.");
    const { footer: subject } = footer(github, [postedComment(222)], {
      getMessage: (id) => message({ id, model: OPUS }),
      getSession: () => session({ total_cost: 0.28 }),
      hindsightServers: async () => [],
    });

    await subject.apply("msg-1");

    expect(github.body("comment", 222)).toBe(
      `Done.\n\n${REVIEW_FOOTER_MARKER}\nReply via Claude Opus 4.5 · Cost: $0.28`
    );
  });

  it("is idempotent: a re-run or redelivery leaves one footer and makes no second edit", async () => {
    const github = new FakeGitHub().add("review", 111, "Body");
    const { footer: subject } = footer(github, [recalled(2), postedReview(111)]);

    await subject.apply("msg-1");
    await subject.apply("msg-1");

    expect(github.body("review", 111)?.split(REVIEW_FOOTER_MARKER)).toHaveLength(2);
    expect(github.writes).toEqual(["review:111"]);
  });

  it("replaces an older footer, such as one written at an earlier cost", async () => {
    const github = new FakeGitHub().add(
      "review",
      111,
      `Body\n\n${REVIEW_FOOTER_MARKER}\nFindings via GPT-6.2 Sol · Bedrock cost: $0.01`
    );
    const { footer: subject } = footer(github, [recalled(2), postedReview(111)]);

    await subject.apply("msg-1");

    expect(github.body("review", 111)).toBe(
      `Body\n\n${REVIEW_FOOTER_MARKER}\n${SOL_REVIEW_FOOTER}`
    );
  });

  it("gives each reviewer's session a footer on its own post only", async () => {
    const github = new FakeGitHub()
      .add("review", 111, "**Reviewer: GPT-6.2 Sol**")
      .add("review", 333, "**Reviewer: Claude Opus 4.5**");
    // The Opus reviewer also read the Sol review; reading is not posting.
    const solTurn = [postedReview(111)];
    const opusTurn = [
      bash(
        "gh api repos/acme/widgets/pulls/7/reviews/111",
        JSON.stringify({ html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-111" })
      ),
      postedReview(333),
    ];
    const sol = footer(github, solTurn, { hindsightServers: async () => [] }).footer;
    const opus = footer(github, opusTurn, {
      getSession: () => session({ id: "session-2", model: OPUS, total_cost: 0.26 }),
      hindsightServers: async () => [],
    }).footer;

    await Promise.all([sol.apply("msg-1"), opus.apply("msg-1")]);

    expect(github.body("review", 111)).toBe(
      `**Reviewer: GPT-6.2 Sol**\n\n${REVIEW_FOOTER_MARKER}\nFindings via GPT-6.2 Sol · Bedrock cost: $0.05`
    );
    expect(github.body("review", 333)).toBe(
      `**Reviewer: Claude Opus 4.5**\n\n${REVIEW_FOOTER_MARKER}\nFindings via Claude Opus 4.5 · Cost: $0.26`
    );
  });

  describe("changes nothing and logs why", () => {
    it.each<[string, Partial<ReviewFooterDeps>, string, "debug" | "info"]>([
      [
        "a turn that did not come from GitHub",
        { getMessage: (id) => message({ id, source: "web" }) },
        "not_github",
        "debug",
      ],
      ["an unknown message", { getMessage: () => null }, "not_github", "debug"],
      [
        "a repository with the setting off",
        { footerEnabled: async () => false },
        "disabled",
        "debug",
      ],
      [
        "a session without a repository id",
        { getSession: () => session({ repo_id: null }) },
        "no_repository",
        "info",
      ],
      [
        "a deployment without the GitHub App",
        { github: () => null },
        "github_app_not_configured",
        "info",
      ],
      [
        "a turn whose tool calls are over the read budget",
        { scanToolCalls: () => false },
        "tool_calls_over_budget",
        "info",
      ],
    ])("for %s", async (_case, overrides, reason, level) => {
      const github = new FakeGitHub().add("review", 111, "Body");
      const { footer: subject, log } = footer(github, [postedReview(111)], overrides);

      await subject.apply("msg-1");

      expect(github.body("review", 111)).toBe("Body");
      expect(github.reads).toEqual([]);
      expect(log[level]).toHaveBeenCalledWith(
        "review_footer",
        expect.objectContaining({ outcome: "skipped", reason })
      );
    });

    it("for a turn that posted nothing", async () => {
      const github = new FakeGitHub();
      const { footer: subject, log } = footer(github, [bash("ls", "README.md")]);

      await subject.apply("msg-1");

      expect(github.reads).toEqual([]);
      expect(log.info).toHaveBeenCalledWith(
        "review_footer",
        expect.objectContaining({ outcome: "skipped", reason: "no_post" })
      );
    });

    it("for a post that is not the App's", async () => {
      const github = new FakeGitHub().add("comment", 222, "Mine", "alice");
      const { footer: subject, log } = footer(github, [postedComment(222)]);

      await subject.apply("msg-1");

      expect(github.body("comment", 222)).toBe("Mine");
      expect(github.writes).toEqual([]);
      expect(log.warn).toHaveBeenCalledWith(
        "review_footer",
        expect.objectContaining({ outcome: "partial", posts: { "comment:222": "not_bot_post" } })
      );
    });

    it("for a post GitHub refuses, without retrying", async () => {
      const github = new FakeGitHub().add("review", 111, "Body");
      github.writeAnswers = ["refused"];
      const { footer: subject, log, sleep } = footer(github, [postedReview(111)]);

      await subject.apply("msg-1");

      expect(github.body("review", 111)).toBe("Body");
      expect(github.writes).toEqual(["review:111"]);
      expect(sleep).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        "review_footer",
        expect.objectContaining({ posts: { "review:111": "refused" } })
      );
    });

    it("when GitHub keeps failing, after a bounded number of attempts", async () => {
      const github = new FakeGitHub().add("review", 111, "Body");
      github.readAnswers = ["failed", "failed", "failed", "failed"];
      const { footer: subject, log, sleep } = footer(github, [postedReview(111)]);

      await subject.apply("msg-1");

      expect(github.reads).toHaveLength(3);
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(github.body("review", 111)).toBe("Body");
      expect(log.warn).toHaveBeenCalledWith(
        "review_footer",
        expect.objectContaining({ posts: { "review:111": "failed" } })
      );
    });

    it("when a dependency throws, without throwing into completion handling", async () => {
      const github = new FakeGitHub().add("review", 111, "Body");
      const { footer: subject, log } = footer(github, [postedReview(111)], {
        footerEnabled: async () => {
          throw new Error("D1 unavailable");
        },
      });

      await expect(subject.apply("msg-1")).resolves.toBeUndefined();
      expect(log.error).toHaveBeenCalledWith(
        "review_footer",
        expect.objectContaining({ outcome: "error", error: new Error("D1 unavailable") })
      );
    });
  });

  it("retries a transient write failure and then footers the post", async () => {
    const github = new FakeGitHub().add("review", 111, "Body");
    github.writeAnswers = ["failed"];
    const { footer: subject } = footer(github, [postedReview(111)], {
      hindsightServers: async () => [],
    });

    await subject.apply("msg-1");

    expect(github.writes).toEqual(["review:111", "review:111"]);
    expect(github.body("review", 111)).toBe(
      `Body\n\n${REVIEW_FOOTER_MARKER}\nFindings via GPT-6.2 Sol · Bedrock cost: $0.05`
    );
  });
});
