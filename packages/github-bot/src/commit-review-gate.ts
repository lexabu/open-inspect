import { createKvCacheStore, type CacheStore } from "@open-inspect/shared/cache-store";
import { isBotLogin } from "@open-inspect/shared/github-mention";
import type { Env } from "./types";
import type { Logger } from "./logger";
import { getPullRequestState, listPullRequestReviews } from "./github-auth";

/**
 * About as long as a review takes. A skipped approval is not retried, so a short claim
 * keeps a failed pre-merge review from blocking later approvals of the same commit for
 * long; once a review posts, GitHub's review list marks the commit reviewed.
 */
const REVIEW_CLAIM_TTL_MS = 15 * 60 * 1000;

/**
 * Marks one commit of one PR as under pre-merge review, so a second approval of it does
 * not start a duplicate. Opening reviews do not claim: an approval during one costs at
 * most a duplicate review, while a claim from a failed one would lose the pre-merge pass.
 */
export interface CommitReviewClaim {
  /** Skip with a reason when a pre-merge review would repeat or miss the live head. */
  checkPreMerge(): Promise<string | null>;
  claim(): Promise<void>;
  release(): Promise<void>;
}

export function commitReviewClaim(
  env: Env,
  log: Logger,
  github: { token: string; userAgent: string; pullUrl: string },
  meta: Record<string, unknown>,
  commit: string
): CommitReviewClaim {
  const store: CacheStore = createKvCacheStore(env.GITHUB_KV);
  const key = `review-claim:${github.pullUrl}@${commit}`;

  return {
    async checkPreMerge() {
      // KV is not atomic: two approvals within moments can still both start a review.
      if ((await store.get(key)) !== null) return "commit_review_claimed";

      // The webhook may be delayed or redelivered; act on the live PR.
      const live = await getPullRequestState(github.token, github.pullUrl, github.userAgent);
      if (live === null) {
        log.warn("handler.pull_request_unreadable", { ...meta, commit });
      } else {
        if (live.state !== "open") return "pr_not_open";
        if (live.draft) return "draft_pr";
        if (live.headSha !== commit) return "approval_not_on_head";
      }

      const reviews = await listPullRequestReviews(
        github.token,
        `${github.pullUrl}/reviews`,
        github.userAgent
      );
      // Unreadable reviews start the review anyway: a duplicate costs less than a missed pass.
      if (reviews === null) {
        log.warn("handler.reviews_unreadable", { ...meta, commit });
        return null;
      }
      // A dismissed review no longer counts, so the pre-merge pass runs again.
      const reviewed = reviews.some(
        (review) =>
          review.commitId === commit &&
          review.state.toUpperCase() !== "DISMISSED" &&
          isBotLogin(review.login, env.GITHUB_BOT_USERNAME)
      );
      return reviewed ? "commit_already_reviewed" : null;
    },
    claim: () => store.put(key, "1", { ttlMs: REVIEW_CLAIM_TTL_MS }),
    release: () => store.delete(key),
  };
}
