import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCheckRun,
  findCheckRun,
  getCompareDiff,
  updateCheckRun,
  type GitHubRepoClient,
} from "../src/github-checks";
import { getPullRequest, listPullRequestReviews } from "../src/github-auth";

const client: GitHubRepoClient = {
  token: "tok",
  userAgent: "Acme Bot",
  repoUrl: "https://api.github.com/repos/acme/widgets",
};
const SHA = "a".repeat(40);
const originalFetch = globalThis.fetch;

function lastRequest() {
  const [url, init] = vi.mocked(globalThis.fetch).mock.calls.at(-1) ?? [];
  const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
  return { url: String(url), init, body };
}

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createCheckRun", () => {
  it("creates the AI Review check in progress on a commit", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ id: 31 }, { status: 201 }));

    const id = await createCheckRun(client, SHA, "2026-11-23T10:00:00.000Z", {
      status: "in_progress",
      output: { title: "AI review in progress", summary: "Reviewing." },
    });

    expect(id).toBe(31);
    const { url, init, body } = lastRequest();
    expect(url).toBe("https://api.github.com/repos/acme/widgets/check-runs");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer tok",
        Accept: "application/vnd.github+json",
        "User-Agent": "Acme Bot",
      },
    });
    expect(body).toEqual({
      name: "AI Review",
      head_sha: SHA,
      started_at: "2026-11-23T10:00:00.000Z",
      status: "in_progress",
      output: { title: "AI review in progress", summary: "Reviewing." },
    });
  });

  it("offers the Review now button on a check that asks for a review", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ id: 32 }, { status: 201 }));

    await createCheckRun(client, SHA, "2026-11-23T10:00:00.000Z", {
      status: "completed",
      conclusion: "action_required",
      output: { title: "Re-run the AI review before merging", summary: "No review." },
      reviewAction: true,
    });

    expect(lastRequest().body).toMatchObject({
      status: "completed",
      conclusion: "action_required",
      actions: [
        {
          label: "Review now",
          description: "Run the AI review on this commit",
          identifier: "review",
        },
      ],
    });
  });

  it.each([
    ["GitHub refuses", () => Promise.resolve(new Response("Forbidden", { status: 403 }))],
    ["the response is malformed", () => Promise.resolve(Response.json({}))],
    ["the request fails", () => Promise.reject(new Error("network"))],
  ])("returns null when %s", async (_name, respond) => {
    vi.mocked(globalThis.fetch).mockImplementation(respond);

    expect(
      await createCheckRun(client, SHA, "2026-11-23T10:00:00.000Z", {
        status: "in_progress",
        output: { title: "t", summary: "s" },
      })
    ).toBeNull();
  });
});

describe("updateCheckRun", () => {
  it("concludes a check run and clears its buttons", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ id: 31 }));

    const ok = await updateCheckRun(client, 31, {
      status: "completed",
      conclusion: "success",
      output: { title: "Approved", summary: "- AI review: approve" },
      reviewAction: false,
    });

    expect(ok).toBe(true);
    const { url, init, body } = lastRequest();
    expect(url).toBe("https://api.github.com/repos/acme/widgets/check-runs/31");
    expect(init?.method).toBe("PATCH");
    expect(body).toEqual({
      status: "completed",
      conclusion: "success",
      output: { title: "Approved", summary: "- AI review: approve" },
      actions: [],
    });
  });

  it("reports a refused update", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("Forbidden", { status: 403 }));

    expect(
      await updateCheckRun(client, 31, {
        status: "in_progress",
        output: { title: "t", summary: "s" },
      })
    ).toBe(false);
  });
});

describe("findCheckRun", () => {
  it("returns the App's newest AI Review run on the commit", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      Response.json({
        total_count: 2,
        check_runs: [
          { id: 5, status: "completed", started_at: "2026-11-23T09:00:00Z" },
          { id: 9, status: "in_progress", started_at: "2026-11-23T10:00:00Z" },
        ],
      })
    );

    expect(await findCheckRun(client, "12345", SHA)).toEqual({
      run: { id: 9, status: "in_progress", startedAt: "2026-11-23T10:00:00Z" },
    });
    expect(lastRequest().url).toBe(
      `https://api.github.com/repos/acme/widgets/commits/${SHA}/check-runs?check_name=AI+Review&app_id=12345&filter=latest`
    );
  });

  it("tells a commit with no run from an unreadable one", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      Response.json({ total_count: 0, check_runs: [] })
    );
    expect(await findCheckRun(client, "12345", SHA)).toEqual({ run: null });

    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("Forbidden", { status: 403 }));
    expect(await findCheckRun(client, "12345", SHA)).toBeNull();
  });
});

describe("getCompareDiff", () => {
  it("asks GitHub for the three-dot diff as text", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("diff --git a/x b/x\n"));

    expect(await getCompareDiff(client, "b".repeat(40), SHA)).toBe("diff --git a/x b/x\n");
    const { url, init } = lastRequest();
    expect(url).toBe(
      `https://api.github.com/repos/acme/widgets/compare/${"b".repeat(40)}...${SHA}`
    );
    expect(init?.headers).toMatchObject({ Accept: "application/vnd.github.diff" });
  });

  it("returns null for a diff GitHub will not produce", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("too large", { status: 406 }));

    expect(await getCompareDiff(client, "b".repeat(40), SHA)).toBeNull();
  });
});

describe("listPullRequestReviews", () => {
  it("returns submitted reviews with their verdict text and skips pending ones", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      Response.json([
        {
          user: { login: "test-bot[bot]" },
          commit_id: SHA,
          state: "COMMENTED",
          body: null,
          html_url: "https://github.test/review/1",
          submitted_at: "2026-11-23T10:05:00Z",
        },
        {
          user: { login: "carol" },
          commit_id: SHA,
          state: "PENDING",
          body: "draft",
          html_url: "https://github.test/review/2",
        },
      ])
    );

    expect(await listPullRequestReviews("tok", "https://api.test/pulls/42/reviews")).toEqual([
      {
        login: "test-bot[bot]",
        commitId: SHA,
        state: "COMMENTED",
        body: "",
        url: "https://github.test/review/1",
        submittedAt: "2026-11-23T10:05:00Z",
      },
    ]);
  });
});

describe("getPullRequest", () => {
  it("returns the live pull request, or null when unreadable", async () => {
    const pull = {
      number: 42,
      state: "open",
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
