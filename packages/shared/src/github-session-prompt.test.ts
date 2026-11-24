import { describe, expect, it } from "vitest";
import { promptPullRequest, pullRequestPromptLead } from "./github-session-prompt";

describe("the GitHub prompt's pull request lead", () => {
  it.each(["reviewing", "working on"] as const)(
    "reads back the pull request it names (%s)",
    (action) => {
      const pull = { owner: "acme", repo: "widgets.js", number: 2009 };
      const content = `${pullRequestPromptLead(action, pull)}\nThe repository has been cloned.`;
      expect(promptPullRequest(content)).toEqual(pull);
    }
  );

  it.each([
    "Please review PR #7 in acme/widgets.",
    "Context first.\nYou are reviewing Pull Request #7 in acme/widgets.",
    "You are reviewing Pull Request #0 in acme/widgets.",
    "You are reviewing Pull Request #7 in acme/widgets/extra.",
    "",
  ])("names no pull request for %j", (content) => {
    expect(promptPullRequest(content)).toBeNull();
  });
});
