import { getCompareDiff, type GitHubRepoClient } from "./github-checks";

/**
 * A pull request's own diff without what a base-branch update alone changes, so that
 * "Update branch" on an unchanged pull request hashes the same.
 *
 * For a file with text hunks, the `index` line (the blob ids, which move whenever the
 * base touches the file) and the hunk line numbers are dropped; the hunk's context text,
 * its order and every content line stay. A file without hunks (a binary file, a mode
 * change, a rename) is identified by its `index` and mode lines alone, so those stay.
 * File headers stay throughout, so the same hunk in two files never collides.
 *
 * Residual: two diffs hash the same when they differ only in where, within one file, an
 * identical hunk with identical context lines and the same hunk heading applies, for
 * example the same edit moved between two copies of a repeated block in one function.
 */
export function normalizeDiff(diff: string): string {
  const files: string[][] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ") || files.length === 0) files.push([]);
    files[files.length - 1].push(line);
  }
  return files
    .flatMap((lines) => {
      // Content lines start with a space, `+`, `-` or `\`, so only headers match below.
      if (!lines.some((line) => line.startsWith("@@"))) return lines;
      return lines
        .filter((line) => !line.startsWith("index "))
        .map((line) => line.replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/, "@@"));
    })
    .join("\n");
}

/** SHA-256 of the normalised `base...head` diff, or null when GitHub cannot produce the diff. */
export async function hashPullRequestDiff(
  client: GitHubRepoClient,
  baseSha: string,
  headSha: string
): Promise<string | null> {
  const diff = await getCompareDiff(client, baseSha, headSha);
  if (diff === null) return null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalizeDiff(diff))
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
