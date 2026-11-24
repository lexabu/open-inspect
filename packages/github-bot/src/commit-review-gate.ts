import { createKvCacheStore, type CacheStore } from "@open-inspect/shared/cache-store";
import { isBotLogin } from "@open-inspect/shared/github-mention";
import type { Env } from "./types";
import type { Logger } from "./logger";
import { getPullRequestState, listPullRequestReviews } from "./github-auth";

/**
 * Long enough to outlast a running review; after that the bot's posted review on the
 * commit is what marks it reviewed.
 */
const REVIEW_CLAIM_TTL_MS = 2 * 60 * 60 * 1000;

/** Marks one commit of one PR as under review, so a pre-merge pass does not repeat it. */
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
      const reviewed = reviews.some(
        (review) => review.commitId === commit && isBotLogin(review.login, env.GITHUB_BOT_USERNAME)
      );
      return reviewed ? "commit_already_reviewed" : null;
    },
    claim: () => store.put(key, "1", { ttlMs: REVIEW_CLAIM_TTL_MS }),
    release: () => store.delete(key),
  };
}
