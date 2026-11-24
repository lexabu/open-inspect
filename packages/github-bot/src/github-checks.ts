import { AI_REVIEW_CHECK_NAME } from "@open-inspect/shared/types/github-review-gate";
import { z } from "zod";
import { GITHUB_API_REQUEST_TIMEOUT_MS } from "./github-auth";

const suiteCheckRunsSchema = z.object({
  check_runs: z.array(z.object({ id: z.number(), external_id: z.string().nullable() })),
});

/**
 * The external id of the newest AI Review run in a check suite (`externalId: null` when
 * the suite has no such run or it carries none), or null when GitHub cannot be read.
 */
export async function findSuiteReviewRun(
  client: { token: string; userAgent: string; repoUrl: string },
  checkSuiteId: number
): Promise<{ externalId: string | null } | null> {
  const query = new URLSearchParams({ check_name: AI_REVIEW_CHECK_NAME, filter: "latest" });
  try {
    const response = await fetch(
      `${client.repoUrl}/check-suites/${checkSuiteId}/check-runs?${query}`,
      {
        headers: {
          Authorization: `Bearer ${client.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": client.userAgent,
        },
        signal: AbortSignal.timeout(GITHUB_API_REQUEST_TIMEOUT_MS),
      }
    );
    if (!response.ok) return null;
    const parsed = suiteCheckRunsSchema.safeParse(await response.json());
    if (!parsed.success) return null;
    // Ids grow with creation time, so the highest id is the newest run.
    const newest = parsed.data.check_runs.reduce<{ id: number; external_id: string | null } | null>(
      (latest, run) => (latest === null || run.id > latest.id ? run : latest),
      null
    );
    return { externalId: newest?.external_id ?? null };
  } catch {
    return null;
  }
}
