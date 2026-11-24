import { z } from "zod";

const githubUserSchema = z.object({
  login: z.string(),
});

const githubSenderSchema = githubUserSchema.extend({
  id: z.number(),
  avatar_url: z.string(),
  // "User", "Bot" or "Organization".
  type: z.string().optional(),
});

const repositorySchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  owner: githubUserSchema,
  name: z.string(),
  private: z.boolean(),
});

const webhookSummaryRepositorySchema = z.object({
  owner: githubUserSchema,
  name: z.string(),
});

const webhookNumberedObjectSchema = z.object({
  number: z.number().optional(),
});

// SHA-1 repositories use 40 hex characters, SHA-256 repositories 64.
const commitShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

const pullRequestSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  user: githubUserSchema,
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string() }),
});

/** A PR a review runs on: its head and base commits pin what is checked out and diffed. */
const reviewedPullRequestSchema = pullRequestSchema.extend({
  head: z.object({ ref: z.string(), sha: commitShaSchema }),
  base: z.object({ ref: z.string(), sha: commitShaSchema }),
});

/** A PR that became reviewable: opened, or moved out of draft. */
export const pullRequestOpenedPayloadSchema = z.object({
  action: z.enum(["opened", "ready_for_review"]),
  pull_request: reviewedPullRequestSchema.extend({ draft: z.boolean() }),
  repository: repositorySchema,
  sender: githubSenderSchema,
});

export const reviewRequestedPayloadSchema = z.object({
  action: z.literal("review_requested"),
  pull_request: reviewedPullRequestSchema,
  requested_reviewer: githubUserSchema.nullable().optional(),
  repository: repositorySchema,
  sender: githubSenderSchema,
});

/** A PR whose diff may have changed: a new head, or (`edited`) a new base branch. */
export const pullRequestChangedPayloadSchema = z.object({
  action: z.enum(["synchronize", "edited"]),
  pull_request: reviewedPullRequestSchema.extend({ draft: z.boolean(), state: z.string() }),
  repository: repositorySchema,
  sender: githubSenderSchema,
});

export const reviewSubmittedPayloadSchema = z.object({
  action: z.literal("submitted"),
  review: z.object({
    commit_id: commitShaSchema,
    user: githubUserSchema,
  }),
  pull_request: reviewedPullRequestSchema,
  repository: repositorySchema,
  sender: githubSenderSchema,
});

/** The Re-run button (`rerequested`) or a check's own button (`requested_action`). */
export const checkRunPayloadSchema = z.object({
  action: z.enum(["rerequested", "requested_action"]),
  check_run: z.object({
    name: z.string(),
    head_sha: commitShaSchema,
    app: z.object({ id: z.number() }),
    // Empty for a commit that is on no open pull request of this repository.
    pull_requests: z.array(z.object({ number: z.number() })),
  }),
  requested_action: z.object({ identifier: z.string() }).optional(),
  repository: repositorySchema,
  sender: githubSenderSchema,
});

export const issueCommentPayloadSchema = z.object({
  action: z.literal("created"),
  issue: z.object({
    number: z.number(),
    title: z.string(),
    pull_request: z.object({ url: z.string() }).optional(),
  }),
  comment: z.object({
    id: z.number(),
    body: z.string(),
    user: githubUserSchema,
  }),
  repository: repositorySchema,
  sender: githubSenderSchema,
});

export const reviewCommentPayloadSchema = z.object({
  action: z.literal("created"),
  pull_request: pullRequestSchema.omit({ body: true, user: true }),
  comment: z.object({
    id: z.number(),
    // Set on a reply: the thread's top-level comment, the only id GitHub's replies endpoint accepts.
    in_reply_to_id: z.number().nullish(),
    body: z.string(),
    path: z.string(),
    diff_hunk: z.string(),
    user: githubUserSchema,
  }),
  repository: repositorySchema,
  sender: githubSenderSchema,
});

export const webhookSummaryPayloadSchema = z
  .object({
    action: z.unknown().optional(),
    repository: webhookSummaryRepositorySchema.nullable().optional(),
    sender: githubUserSchema.nullable().optional(),
    pull_request: webhookNumberedObjectSchema.nullable().optional(),
    issue: webhookNumberedObjectSchema.nullable().optional(),
  })
  .passthrough();

export const requestedReviewerPayloadSchema = z
  .object({
    requested_reviewer: githubUserSchema.nullable().optional(),
  })
  .passthrough();

export const baseChangePayloadSchema = z
  .object({
    changes: z.object({ base: z.unknown().optional() }).passthrough().optional(),
  })
  .passthrough();

export const reviewAuthorPayloadSchema = z
  .object({
    review: z.object({ user: githubUserSchema.nullable().optional() }).nullable().optional(),
  })
  .passthrough();

export const webhookActionPayloadSchema = z
  .object({
    action: z.unknown().optional(),
  })
  .passthrough();

export type PullRequestOpenedPayload = z.infer<typeof pullRequestOpenedPayloadSchema>;
export type ReviewRequestedPayload = z.infer<typeof reviewRequestedPayloadSchema>;
export type PullRequestChangedPayload = z.infer<typeof pullRequestChangedPayloadSchema>;
export type ReviewSubmittedPayload = z.infer<typeof reviewSubmittedPayloadSchema>;
export type CheckRunPayload = z.infer<typeof checkRunPayloadSchema>;
export type IssueCommentPayload = z.infer<typeof issueCommentPayloadSchema>;
export type ReviewCommentPayload = z.infer<typeof reviewCommentPayloadSchema>;
export type WebhookSummaryPayload = z.infer<typeof webhookSummaryPayloadSchema>;
