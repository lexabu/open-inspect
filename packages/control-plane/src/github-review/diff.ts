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
 * Without line numbers a hunk is located only by its text. Null is returned when that
 * is ambiguous within the diff itself: one file has two hunks that read the same, so
 * swapping or moving them would not show. Such a diff is never carried forward.
 *
 * Residual: a hunk whose context also occurs elsewhere in the file, outside the diff,
 * can move there without changing the result. Seeing that needs the file's contents,
 * which the diff does not carry.
 */
export function normalizeDiff(diff: string): string | null {
  const files: string[][] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ") || files.length === 0) files.push([]);
    files[files.length - 1].push(line);
  }
  const normalized: string[] = [];
  for (const lines of files) {
    // Content lines start with a space, `+`, `-` or `\`, so only headers match below.
    if (!lines.some((line) => line.startsWith("@@"))) {
      normalized.push(...lines);
      continue;
    }
    const kept = lines
      .filter((line) => !line.startsWith("index "))
      .map((line) => line.replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/, "@@"));
    const hunks = kept.join("\n").split("\n@@").slice(1);
    if (new Set(hunks).size !== hunks.length) return null;
    normalized.push(...kept);
  }
  return normalized.join("\n");
}

/** SHA-256 of a normalised diff; null for a diff whose hunks cannot be told apart. */
export async function hashDiff(diff: string): Promise<string | null> {
  const normalized = normalizeDiff(diff);
  if (normalized === null) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
