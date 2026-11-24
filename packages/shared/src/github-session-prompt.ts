/**
 * The first line of every prompt the GitHub bot sends names the pull request the session
 * works on. The bot writes it with `pullRequestPromptLead`; the control plane reads it back
 * with `promptPullRequest`, so the two cannot drift apart.
 */

export interface PromptPullRequest {
  owner: string;
  repo: string;
  number: number;
}

export type PullRequestPromptAction = "reviewing" | "working on";

export function pullRequestPromptLead(
  action: PullRequestPromptAction,
  pull: PromptPullRequest
): string {
  return `You are ${action} Pull Request #${pull.number} in ${pull.owner}/${pull.repo}.`;
}

const LEAD = /^You are (?:reviewing|working on) Pull Request #(\d+) in ([^/\s]+)\/([^/\s]+)\.$/;

/** The pull request a GitHub prompt's first line names, or null when it names none. */
export function promptPullRequest(content: string): PromptPullRequest | null {
  const match = LEAD.exec(content.split("\n", 1)[0]);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0
    ? { owner: match[2], repo: match[3], number }
    : null;
}
