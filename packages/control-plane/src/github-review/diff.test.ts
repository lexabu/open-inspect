import { describe, expect, it } from "vitest";
import { hashDiff, normalizeDiff } from "./diff";

const TEXT_DIFF = [
  "diff --git a/src/cache.ts b/src/cache.ts",
  "index 1111111..2222222 100644",
  "--- a/src/cache.ts",
  "+++ b/src/cache.ts",
  "@@ -10,3 +10,4 @@ export function read() {",
  " const key = id;",
  "+const ttl = 60;",
  " return store.get(key);",
].join("\n");

const BINARY = (from: string, to: string) =>
  [
    "diff --git a/logo.png b/logo.png",
    `index ${from}..${to} 100644`,
    "Binary files a/logo.png and b/logo.png differ",
  ].join("\n");

describe("normalizeDiff", () => {
  it("drops only blob ids and hunk line numbers from a text file", () => {
    expect(normalizeDiff(TEXT_DIFF)).toBe(
      [
        "diff --git a/src/cache.ts b/src/cache.ts",
        "--- a/src/cache.ts",
        "+++ b/src/cache.ts",
        "@@ export function read() {",
        " const key = id;",
        "+const ttl = 60;",
        " return store.get(key);",
      ].join("\n")
    );
  });

  it("gives a base-only update the hash of the diff that was reviewed", async () => {
    // The base touched the file above the hunk: new blob ids, shifted line numbers.
    const afterUpdate = TEXT_DIFF.replace(
      "index 1111111..2222222",
      "index 3333333..4444444"
    ).replace("@@ -10,3 +10,4 @@", "@@ -48,3 +48,4 @@");
    expect(await hashDiff(afterUpdate)).toBe(await hashDiff(TEXT_DIFF));
    expect(await hashDiff(TEXT_DIFF)).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashDiff(TEXT_DIFF.replace("ttl = 60", "ttl = 0"))).not.toBe(
      await hashDiff(TEXT_DIFF)
    );
  });

  it("keeps content lines that only look like headers", () => {
    const diff = `${TEXT_DIFF}\n-index me\n+@@ -1 +1 @@ kept`;
    expect(normalizeDiff(diff)).toContain("-index me\n+@@ -1 +1 @@ kept");
  });

  it("tells a replaced binary file from the one that was reviewed", () => {
    expect(normalizeDiff(BINARY("aaaaaaa", "bbbbbbb"))).not.toBe(
      normalizeDiff(BINARY("aaaaaaa", "ccccccc"))
    );
    expect(normalizeDiff(BINARY("aaaaaaa", "bbbbbbb"))).toContain("index aaaaaaa..bbbbbbb");
  });

  it("keeps a binary file's identity next to a text file whose blob ids are dropped", () => {
    const both = (binaryTo: string, textIndex: string) =>
      normalizeDiff(
        `${BINARY("aaaaaaa", binaryTo)}\n${TEXT_DIFF.replace("index 1111111..2222222", textIndex)}`
      );
    expect(both("bbbbbbb", "index 1111111..2222222")).toBe(
      both("bbbbbbb", "index 5555555..6666666")
    );
    expect(both("bbbbbbb", "index 1111111..2222222")).not.toBe(
      both("ccccccc", "index 1111111..2222222")
    );
  });

  it("keeps mode changes", () => {
    const mode = (to: string) =>
      ["diff --git a/run.sh b/run.sh", "old mode 100644", `new mode ${to}`].join("\n");
    expect(normalizeDiff(mode("100755"))).toBe(mode("100755"));
    const withHunk = (to: string) =>
      `${mode(to)}\nindex 1111111..2222222\n--- a/run.sh\n+++ b/run.sh\n@@ -1 +1 @@\n-a\n+b`;
    expect(normalizeDiff(withHunk("100755"))).not.toBe(normalizeDiff(withHunk("100644")));
  });

  it("tells the same hunk in two files apart", () => {
    const inFile = (path: string) => TEXT_DIFF.replaceAll("src/cache.ts", path);
    expect(normalizeDiff(inFile("src/a.ts"))).not.toBe(normalizeDiff(inFile("src/b.ts")));
  });

  it("tells hunks apart by their context text and their order", () => {
    expect(normalizeDiff(TEXT_DIFF)).not.toBe(
      normalizeDiff(TEXT_DIFF.replace("export function read()", "export function write()"))
    );
    const second = "@@ -30,2 +31,3 @@ export function write() {\n line\n+added";
    const header = TEXT_DIFF.split("\n").slice(0, 4).join("\n");
    const hunk = TEXT_DIFF.split("\n").slice(4).join("\n");
    expect(normalizeDiff(`${header}\n${hunk}\n${second}`)).not.toBe(
      normalizeDiff(`${header}\n${second}\n${hunk}`)
    );
  });

  it("refuses a diff in which one file has two hunks that read the same", async () => {
    // The same edit in two copies of a block: without line numbers, moving one of them
    // elsewhere in the file would not show.
    const hunk = TEXT_DIFF.split("\n").slice(4).join("\n");
    const repeated = `${TEXT_DIFF}\n${hunk.replace("@@ -10,3 +10,4 @@", "@@ -80,3 +81,4 @@")}`;
    expect(normalizeDiff(repeated)).toBeNull();
    expect(await hashDiff(repeated)).toBeNull();

    // The same hunk text in two different files is not ambiguous.
    const otherFile = TEXT_DIFF.replaceAll("src/cache.ts", "src/other.ts");
    expect(normalizeDiff(`${TEXT_DIFF}\n${otherFile}`)).not.toBeNull();
  });
});
