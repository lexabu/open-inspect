/**
 * The GitHub the AI Review merge gate sees: one repository's pull requests and its own
 * check runs, through a token that can do nothing else.
 */
import { DEFAULT_APP_NAME } from "@open-inspect/shared/app-name";
import {
  AI_REVIEW_CHECK_NAME,
  REVIEW_ACTION_IDENTIFIER,
} from "@open-inspect/shared/types/github-review-gate";
import { encodeRepositoryPathSegments } from "@open-inspect/shared/types/repositories";
import { z } from "zod";
import { fetchWithTimeout, mintReviewGateToken, type GitHubAppConfig } from "../auth/github-app";
import { hashDiff } from "./diff";

interface CheckOutput {
  title: string;
  summary: string;
}

export type CheckRunState =
  | { status: "in_progress"; output: CheckOutput }
  | {
      status: "completed";
      conclusion: "success" | "failure" | "neutral" | "action_required" | "cancelled";
      output: CheckOutput;
      /** Offer the "Review now" button. */
      reviewAction: boolean;
    };

const pullSchema = z
  .object({
    number: z.number(),
    state: z.string(),
    draft: z.boolean(),
    user: z.object({ login: z.string() }),
    head: z.object({ ref: z.string(), sha: z.string(), label: z.string() }),
    base: z.object({ ref: z.string(), sha: z.string() }),
  })
  .transform((pull) => ({
    number: pull.number,
    open: pull.state === "open",
    draft: pull.draft,
    author: pull.user.login,
    headSha: pull.head.sha,
    /** `owner:branch`, which also names a fork's branch. */
    headLabel: pull.head.label,
    baseRef: pull.base.ref,
    baseSha: pull.base.sha,
  }));
/** A pull request as GitHub has it now. */
export type LivePull = z.infer<typeof pullSchema>;

const headPullsSchema = z.array(
  z.object({ number: z.number(), state: z.string(), head: z.object({ sha: z.string() }) })
);
const createdCheckRunSchema = z.object({ id: z.number() });
const PULLS_PAGE_SIZE = 100;

export interface GateGitHub {
  /** The pull request, or null when GitHub cannot be read. */
  getPull(pullNumber: number): Promise<LivePull | null>;
  /**
   * Hash of the diff a pull request shows (`base...head`, from their merge base). Null
   * when GitHub cannot produce it (a diff over its size limit) or it is ambiguous.
   */
  hashPullDiff(baseSha: string, headSha: string): Promise<string | null>;
  /**
   * Why the pull request is not shown to be the only open one on its head commit, or
   * null when it is. A check run belongs to a commit, so a pass would show on every
   * pull request that shares it.
   */
  sharedHeadReason(pull: LivePull): Promise<string | null>;
  /** Creates the AI Review check run on a commit; null when GitHub refuses. */
  createCheck(
    run: { headSha: string; externalId: string; startedAt: string },
    state: CheckRunState
  ): Promise<number | null>;
  updateCheck(checkRunId: number, state: CheckRunState): Promise<boolean>;
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

export function createGateGitHub(
  config: GitHubAppConfig,
  repository: { owner: string; name: string; id: number },
  userAgent: string = DEFAULT_APP_NAME
): GateGitHub {
  const repoUrl = `https://api.github.com/repos/${encodeRepositoryPathSegments({
    repoOwner: repository.owner,
    repoName: repository.name,
  })}`;
  let token: Promise<string> | undefined;
  const request = async (
    path: string,
    init: { method?: string; body?: unknown; accept?: string } = {}
  ): Promise<Response | null> => {
    // A token that cannot be minted is a configuration fault (the App lacks Checks
    // write, say), not an unreadable pull request: it is thrown, not answered with null.
    token ??= mintReviewGateToken(config, userAgent, repository.id);
    const authorization = `Bearer ${await token}`;
    try {
      return await fetchWithTimeout(`${repoUrl}${path}`, {
        method: init.method ?? "GET",
        headers: {
          Authorization: authorization,
          Accept: init.accept ?? "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": userAgent,
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch {
      return null;
    }
  };
  const json = async <T>(path: string, schema: z.ZodType<T>): Promise<T | null> => {
    const response = await request(path);
    if (!response?.ok) return null;
    const parsed = schema.safeParse(await response.json().catch(() => null));
    return parsed.success ? parsed.data : null;
  };
  /** Open pull requests in a listing whose head is `headSha`; null when it may be incomplete. */
  const openOnHead = async (path: string, headSha: string): Promise<number[] | null> => {
    const pulls = await json(path, headPullsSchema);
    if (pulls === null || pulls.length === PULLS_PAGE_SIZE) return null;
    return pulls
      .filter((pull) => pull.state === "open" && pull.head.sha === headSha)
      .map((pull) => pull.number);
  };

  return {
    getPull: (pullNumber) => json(`/pulls/${pullNumber}`, pullSchema),

    async hashPullDiff(baseSha, headSha) {
      const response = await request(`/compare/${baseSha}...${headSha}`, {
        accept: "application/vnd.github.diff",
      });
      return response?.ok ? hashDiff(await response.text()) : null;
    },

    async sharedHeadReason(pull) {
      const unconfirmed = `Could not confirm that #${pull.number} is the only open pull request on commit \`${pull.headSha.slice(0, 7)}\`.`;
      let onHead = await openOnHead(
        `/commits/${pull.headSha}/pulls?per_page=${PULLS_PAGE_SIZE}`,
        pull.headSha
      );
      if (onHead === null) return unconfirmed;
      if (onHead.length === 0) {
        // GitHub's commit index can lag a push; the branch's own pull requests settle it.
        const query = new URLSearchParams({
          state: "open",
          head: pull.headLabel,
          per_page: String(PULLS_PAGE_SIZE),
        });
        onHead = await openOnHead(`/pulls?${query}`, pull.headSha);
        if (onHead === null) return unconfirmed;
      }
      if (!onHead.includes(pull.number)) return unconfirmed;
      const others = onHead.filter((number) => number !== pull.number);
      return others.length === 0
        ? null
        : `Commit \`${pull.headSha.slice(0, 7)}\` is also the head of ${others.map((number) => `#${number}`).join(", ")}, and a check run cannot tell pull requests on one commit apart.`;
    },

    async createCheck(run, state) {
      const response = await request("/check-runs", {
        method: "POST",
        body: {
          name: AI_REVIEW_CHECK_NAME,
          head_sha: run.headSha,
          started_at: run.startedAt,
          external_id: run.externalId,
          ...checkRunBody(state),
        },
      });
      if (!response?.ok) return null;
      const parsed = createdCheckRunSchema.safeParse(await response.json().catch(() => null));
      return parsed.success ? parsed.data.id : null;
    },

    async updateCheck(checkRunId, state) {
      const response = await request(`/check-runs/${checkRunId}`, {
        method: "PATCH",
        body: checkRunBody(state),
      });
      return response?.ok === true;
    },
  };
}
