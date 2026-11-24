import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPullRequest } from "../src/github-auth";
import { findSuiteReviewRun } from "../src/github-checks";

const client = {
  token: "tok",
  userAgent: "Acme Bot",
  repoUrl: "https://api.github.com/repos/acme/widgets",
};
const SHA = "a".repeat(40);
const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("findSuiteReviewRun", () => {
  it("returns the external id of the suite's newest AI Review run", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      Response.json({
        total_count: 2,
        check_runs: [
          { id: 5, external_id: "open-inspect:pr=41" },
          { id: 9, external_id: "open-inspect:pr=42" },
        ],
      })
    );

    expect(await findSuiteReviewRun(client, 900)).toEqual({ externalId: "open-inspect:pr=42" });
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toBe(
      "https://api.github.com/repos/acme/widgets/check-suites/900/check-runs?check_name=AI+Review&filter=latest"
    );
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer tok",
      "User-Agent": "Acme Bot",
    });
  });

  it("tells a suite with no AI Review run from an unreadable one", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      Response.json({ total_count: 0, check_runs: [] })
    );
    expect(await findSuiteReviewRun(client, 900)).toEqual({ externalId: null });

    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("Forbidden", { status: 403 }));
    expect(await findSuiteReviewRun(client, 900)).toBeNull();

    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("network"));
    expect(await findSuiteReviewRun(client, 900)).toBeNull();
  });
});

describe("getPullRequest", () => {
  it("returns the live pull request, or null when unreadable", async () => {
    const pull = {
      number: 42,
      state: "open",
      draft: false,
      title: "Add caching",
      body: null,
      user: { login: "alice" },
      head: { ref: "feature/cache", sha: SHA },
      base: { ref: "main", sha: "b".repeat(40) },
    };
    vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ ...pull, merged: false }));
    expect(await getPullRequest("tok", "https://api.test/pulls/42")).toEqual(pull);

    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("Not Found", { status: 404 }));
    expect(await getPullRequest("tok", "https://api.test/pulls/42")).toBeNull();
  });
});
