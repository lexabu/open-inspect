/**
 * The control-plane API behind the GitHub bot's `AI Review` merge gate. The bot handles
 * GitHub's webhooks and decides who may ask for a review; the control plane owns every
 * review attempt, runs its sessions, reads their verdicts and writes the check run.
 */
import { z } from "zod";
import { harnessIdSchema } from "../harnesses";
import { MAX_GITHUB_REVIEWERS } from "./integrations";

export const AI_REVIEW_CHECK_NAME = "AI Review";

/** Identifier of the check's "Review now" button; GitHub echoes it in `check_run.requested_action`. */
export const REVIEW_ACTION_IDENTIFIER = "review";

/** A check run's `external_id`: its pull request and, for a review, the attempt. */
export function reviewCheckExternalId(pullNumber: number, attemptId?: string): string {
  const pull = `open-inspect:pr=${pullNumber}`;
  return attemptId ? `${pull};attempt=${attemptId}` : pull;
}

/** The pull request a check run names in its `external_id`, or null when it names none. */
export function pullNumberFromReviewCheck(externalId: string | null | undefined): number | null {
  const match = /^open-inspect:pr=(\d+)(?:;attempt=[\w-]+)?$/.exec(externalId ?? "");
  return match ? Number(match[1]) : null;
}

const repositorySchema = z.object({ owner: z.string().min(1), name: z.string().min(1) });
const pullNumberSchema = z.number().int().positive();
// SHA-1 repositories use 40 hex characters, SHA-256 repositories 64.
const commitShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

/** Start a review of a pull request's head commit, one session per reviewer. */
export const startGateReviewRequestSchema = z.object({
  repository: repositorySchema,
  pullNumber: pullNumberSchema,
  /** The head the prompts were written for; refused when it is no longer the live head. */
  headSha: commitShaSchema,
  /**
   * The base the prompts tell the reviewers to diff against. It is recorded as the base that
   * was reviewed; a start whose base branch is no longer the live one is refused.
   */
  base: z.object({ ref: z.string().min(1), sha: commitShaSchema }),
  reviewers: z
    .array(
      z.object({
        model: z.string().min(1),
        harness: harnessIdSchema,
        reasoningEffort: z.string().nullable(),
        title: z.string().min(1),
        prompt: z.string().min(1),
      })
    )
    .min(1)
    .max(MAX_GITHUB_REVIEWERS),
});
export type StartGateReviewRequest = z.infer<typeof startGateReviewRequestSchema>;

export const startGateReviewResponseSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("started"),
    attemptId: z.string(),
    sessions: z.array(
      z.object({ sessionId: z.string(), messageId: z.string(), model: z.string() })
    ),
  }),
  z.object({
    outcome: z.literal("skipped"),
    reason: z.enum([
      "merge_gate_off",
      "review_in_progress",
      "pr_not_open",
      "draft_pr",
      "stale_head",
      "stale_base",
      "superseded",
    ]),
  }),
]);
export type StartGateReviewResponse = z.infer<typeof startGateReviewResponseSchema>;

/**
 * Something changed on a pull request that no review covers yet:
 * - `head`: a new head commit. The last verdict carries forward when the diff is unchanged.
 * - `base`: another base branch. Nothing carries over.
 * - `reopened`: the pull request was reopened.
 * - `review_not_started`: a review was due but the bot could not start one.
 */
export const gatePullChangeRequestSchema = z.object({
  repository: repositorySchema,
  pullNumber: pullNumberSchema,
  change: z.enum(["head", "base", "reopened", "review_not_started"]),
  /** The head commit the event was about; a `head` change for a stale commit is ignored. */
  headSha: commitShaSchema,
  /** Why the review did not start, for `review_not_started`. */
  detail: z.string().max(200).optional(),
});
export type GatePullChangeRequest = z.infer<typeof gatePullChangeRequestSchema>;

export const gatePullChangeResponseSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("needs_review") }),
  z.object({ outcome: z.literal("carried_forward") }),
  z.object({
    outcome: z.literal("skipped"),
    reason: z.enum([
      "merge_gate_off",
      "pr_not_open",
      "draft_pr",
      "stale_head",
      "review_in_progress",
    ]),
  }),
]);
export type GatePullChangeResponse = z.infer<typeof gatePullChangeResponseSchema>;

/** A human passes the head's check. The bot has already checked their repository access. */
export const gateOverrideRequestSchema = z.object({
  repository: repositorySchema,
  pullNumber: pullNumberSchema,
  /** At least seven characters of the commit the human named. */
  commit: z.string().regex(/^[0-9a-f]{7,64}$/),
  reason: z.string().trim().min(1).max(1_000),
  overriddenBy: z.string().min(1),
});
export type GateOverrideRequest = z.infer<typeof gateOverrideRequestSchema>;

export const gateOverrideResponseSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("overridden"), headSha: z.string() }),
  z.object({
    outcome: z.literal("refused"),
    reason: z.enum(["merge_gate_off", "pr_not_open", "wrong_commit", "by_author", "shared_head"]),
    /** A sentence for the person who commented; empty when no reply is due. */
    detail: z.string(),
  }),
]);
export type GateOverrideResponse = z.infer<typeof gateOverrideResponseSchema>;
