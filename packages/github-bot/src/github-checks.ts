import { z } from "zod";
import { GITHUB_API_REQUEST_TIMEOUT_MS } from "./github-auth";

export const AI_REVIEW_CHECK_NAME = "AI Review";

/** Identifier of the "Review now" button; GitHub echoes it in `check_run.requested_action`. */
export const REVIEW_ACTION_IDENTIFIER = "review";

/** An installation token scoped to one repository's REST root. */
export interface GitHubRepoClient {
  token: string;
  userAgent: string;
  /** `https://api.github.com/repos/{owner}/{repo}` */
  repoUrl: string;
}

export interface CheckOutput {
  title: string;
  summary: string;
}

export type CheckConclusion = "success" | "failure" | "neutral" | "action_required";

export type CheckRunState =
  | { status: "in_progress"; output: CheckOutput }
  | {
      status: "completed";
      conclusion: CheckConclusion;
      output: CheckOutput;
      /** Offer the "Review now" button. */
      reviewAction: boolean;
    };

function headers(client: GitHubRepoClient, accept = "application/vnd.github+json") {
  return {
    Authorization: `Bearer ${client.token}`,
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": client.userAgent,
  };
}

function checkRunBody(state: CheckRunState): Record<string, unknown> {
  if (state.status === "in_progress") return { status: state.status, output: state.output };
  return {
    status: state.status,
    conclusion: state.conclusion,
    output: state.output,
    actions: state.reviewAction
      ? [
          {
            label: "Review now",
            description: "Run the AI review on this commit",
            identifier: REVIEW_ACTION_IDENTIFIER,
          },
        ]
      : [],
  };
}

const createdCheckRunSchema = z.object({ id: z.number() });

/**
 * Creates the AI Review check run on a commit and returns its id, or null when GitHub
 * refuses. A new run replaces an earlier one of the same name on that commit.
 */
export async function createCheckRun(
  client: GitHubRepoClient,
  headSha: string,
  startedAt: string,
  state: CheckRunState
): Promise<number | null> {
  try {
    const response = await fetch(`${client.repoUrl}/check-runs`, {
      method: "POST",
      headers: headers(client),
      body: JSON.stringify({
        name: AI_REVIEW_CHECK_NAME,
        head_sha: headSha,
        started_at: startedAt,
        ...checkRunBody(state),
      }),
      signal: AbortSignal.timeout(GITHUB_API_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const parsed = createdCheckRunSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.id : null;
  } catch {
    return null;
  }
}

export async function updateCheckRun(
  client: GitHubRepoClient,
  checkRunId: number,
  state: CheckRunState
): Promise<boolean> {
  try {
    const response = await fetch(`${client.repoUrl}/check-runs/${checkRunId}`, {
      method: "PATCH",
      headers: headers(client),
      body: JSON.stringify(checkRunBody(state)),
      signal: AbortSignal.timeout(GITHUB_API_REQUEST_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const checkRunsResponseSchema = z.object({
  check_runs: z.array(
    z.object({
      id: z.number(),
      status: z.string(),
      started_at: z.string().nullable(),
    })
  ),
});

export interface ExistingCheckRun {
  id: number;
  status: string;
  startedAt: string | null;
}

/**
 * The App's newest AI Review check run on a commit (`run: null` when there is none), or
 * null when GitHub cannot be read.
 */
export async function findCheckRun(
  client: GitHubRepoClient,
  appId: string,
  headSha: string
): Promise<{ run: ExistingCheckRun | null } | null> {
  const query = new URLSearchParams({
    check_name: AI_REVIEW_CHECK_NAME,
    app_id: appId,
    filter: "latest",
  });
  try {
    const response = await fetch(`${client.repoUrl}/commits/${headSha}/check-runs?${query}`, {
      headers: headers(client),
      signal: AbortSignal.timeout(GITHUB_API_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const parsed = checkRunsResponseSchema.safeParse(await response.json());
    if (!parsed.success) return null;
    // Ids grow with creation time, so the highest id is the newest run.
    const newest = parsed.data.check_runs.reduce<(typeof parsed.data.check_runs)[number] | null>(
      (latest, run) => (latest === null || run.id > latest.id ? run : latest),
      null
    );
    return {
      run: newest && { id: newest.id, status: newest.status, startedAt: newest.started_at },
    };
  } catch {
    return null;
  }
}

/**
 * The diff a pull request shows (`base...head`, from their merge base), or null when
 * GitHub cannot produce it — for example a diff over GitHub's size limit.
 */
export async function getCompareDiff(
  client: GitHubRepoClient,
  baseSha: string,
  headSha: string
): Promise<string | null> {
  try {
    const response = await fetch(`${client.repoUrl}/compare/${baseSha}...${headSha}`, {
      headers: headers(client, "application/vnd.github.diff"),
      signal: AbortSignal.timeout(GITHUB_API_REQUEST_TIMEOUT_MS),
    });
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}
