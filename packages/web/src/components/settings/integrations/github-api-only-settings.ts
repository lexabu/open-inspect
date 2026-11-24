import type { GitHubBotSettings } from "@open-inspect/shared/types/integrations";

/**
 * The GitHub settings the forms do not edit yet, to carry into a save unchanged so it
 * keeps whatever the API set. Unset ones stay undefined, which a JSON body leaves out.
 */
export function apiOnlyGitHubSettings(
  settings: GitHubBotSettings | undefined
): Pick<
  GitHubBotSettings,
  "reviewers" | "commentOnlyReviews" | "reviewTip" | "reviewFooter" | "mergeGate"
> {
  const { reviewers, commentOnlyReviews, reviewTip, reviewFooter, mergeGate } = settings ?? {};
  return { reviewers, commentOnlyReviews, reviewTip, reviewFooter, mergeGate };
}
