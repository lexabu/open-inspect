/**
 * The footer touches only posts on the pull request the session was started for (Sol H1,
 * Claude M2), and skips a turn whose tool calls are over the read budget (Sol H2).
 */
import { describe, expect, it } from "vitest";
import { bash, FakeGitHub, footer, message, postedReview } from "./service.test-support";

describe("ReviewFooter and the triggering pull request", () => {
  it("footers nothing when the prompt names no pull request", async () => {
    const github = new FakeGitHub().add("review", 111, "Body");
    const { footer: subject, log } = footer(github, [postedReview(111)], {
      getMessage: (id) => message({ id, content: "Review the open pull requests." }),
    });

    await subject.apply("msg-1");

    expect(github.reads).toEqual([]);
    expect(log.info).toHaveBeenCalledWith(
      "review_footer",
      expect.objectContaining({ outcome: "skipped", reason: "no_pull_request" })
    );
  });

  it("footers nothing when the prompt names another repository's pull request", async () => {
    const github = new FakeGitHub().add("review", 111, "Body");
    const { footer: subject, log } = footer(github, [postedReview(111)], {
      getMessage: (id) =>
        message({ id, content: "You are reviewing Pull Request #7 in acme/other." }),
    });

    await subject.apply("msg-1");

    expect(github.reads).toEqual([]);
    expect(log.info).toHaveBeenCalledWith(
      "review_footer",
      expect.objectContaining({ reason: "no_pull_request" })
    );
  });

  it("footers only the post on the session's own pull request", async () => {
    const github = new FakeGitHub().add("review", 111, "Mine").add("review", 444, "Other PR");
    const { footer: subject } = footer(github, [
      postedReview(111),
      bash(
        "gh api -X POST repos/acme/widgets/pulls/8/reviews --input r.json",
        JSON.stringify({ html_url: "https://github.com/acme/widgets/pull/8#pullrequestreview-444" })
      ),
    ]);

    await subject.apply("msg-1");

    expect(github.writes).toEqual(["review:111"]);
    expect(github.body("review", 444)).toBe("Other PR");
  });

  it("footers nothing when the turn's tool calls are over the read budget", async () => {
    const github = new FakeGitHub().add("review", 111, "Body");
    const { footer: subject, log } = footer(github, [postedReview(111)], {
      scanToolCalls: () => false,
    });

    await subject.apply("msg-1");

    expect(github.reads).toEqual([]);
    expect(log.info).toHaveBeenCalledWith(
      "review_footer",
      expect.objectContaining({ outcome: "skipped", reason: "tool_calls_over_budget" })
    );
  });
});
