/**
 * The GitHub the review footer sees: one repository's pull request reviews and
 * conversation comments, read and edited through a token that can do nothing else.
 */
import { encodeRepositoryPathSegments } from "@open-inspect/shared/types/repositories";
import { z } from "zod";
import { fetchWithTimeout, mintReviewFooterToken, type GitHubAppConfig } from "../auth/github-app";
import type { SessionPost } from "./session-activity";

const postSchema = z.object({
  user: z.object({ login: z.string() }).nullable(),
  body: z.string().nullable(),
});

export interface PostContent {
  author: string | null;
  body: string;
}

/** A call's result: done, refused for good (no retry helps), or failed and worth retrying. */
export type FooterCall<T> =
  | { outcome: "ok"; value: T }
  | { outcome: "refused"; status: number }
  | { outcome: "failed"; reason: string };

export interface FooterGitHub {
  readPost(post: SessionPost): Promise<FooterCall<PostContent>>;
  writePost(post: SessionPost, body: string): Promise<FooterCall<null>>;
}

/** Answers about the post itself (gone, not ours to edit), which a retry cannot change. */
const REFUSED = new Set([401, 403, 404, 410, 422]);

/** Reviews are edited with PUT on the review; conversation comments with PATCH. */
function postEndpoint(post: SessionPost): { path: string; editMethod: "PUT" | "PATCH" } {
  return post.kind === "review"
    ? { path: `/pulls/${post.pullNumber}/reviews/${post.id}`, editMethod: "PUT" }
    : { path: `/issues/comments/${post.id}`, editMethod: "PATCH" };
}

export function createFooterGitHub(
  config: GitHubAppConfig,
  repository: { owner: string; name: string; id: number },
  userAgent: string
): FooterGitHub {
  const repoUrl = `https://api.github.com/repos/${encodeRepositoryPathSegments({
    repoOwner: repository.owner,
    repoName: repository.name,
  })}`;
  let token: Promise<string> | undefined;
  const request = async (
    method: "GET" | "PUT" | "PATCH",
    path: string,
    body?: unknown
  ): Promise<FooterCall<Response>> => {
    try {
      token ??= mintReviewFooterToken(config, userAgent, repository.id);
      const response = await fetchWithTimeout(`${repoUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${await token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": userAgent,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.ok) return { outcome: "ok", value: response };
      if (REFUSED.has(response.status)) return { outcome: "refused", status: response.status };
      return { outcome: "failed", reason: `HTTP ${response.status}` };
    } catch (error) {
      // A token that failed to mint is minted again on the next attempt.
      token = undefined;
      return { outcome: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
  };

  return {
    async readPost(post) {
      const result = await request("GET", postEndpoint(post).path);
      if (result.outcome !== "ok") return result;
      const parsed = postSchema.safeParse(await result.value.json().catch(() => null));
      if (!parsed.success) return { outcome: "failed", reason: "unreadable post" };
      return {
        outcome: "ok",
        value: { author: parsed.data.user?.login ?? null, body: parsed.data.body ?? "" },
      };
    },

    async writePost(post, body) {
      const { path, editMethod } = postEndpoint(post);
      const result = await request(editMethod, path, { body });
      return result.outcome === "ok" ? { outcome: "ok", value: null } : result;
    },
  };
}
