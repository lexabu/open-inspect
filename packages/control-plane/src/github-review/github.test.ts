import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GitHubApp from "../auth/github-app";

vi.mock("../auth/github-app", async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubApp>()),
  mintReviewGateToken: vi.fn(async () => "gate-token"),
}));

import { mintReviewGateToken } from "../auth/github-app";
import { createGateGitHub, type LivePull } from "./github";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const CONFIG = { appId: "1", privateKey: "key", installationId: "2" };
const REPO = "https://api.github.com/repos/acme/widgets";
const pull: LivePull = {
  number: 42,
  open: true,
  draft: false,
  author: "alice",
  headSha: HEAD,
  headLabel: "acme:feature/cache",
  baseRef: "main",
  baseSha: BASE,
};

let fetchMock: ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">>;
const github = () => createGateGitHub(CONFIG, { owner: "acme", name: "widgets", id: 99 }, "Acme");
const requests = () =>
  fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    method: init?.method,
    headers: new Headers(init?.headers),
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  }));
/** Answers each request by the first URL fragment it contains. */
function respond(routes: Record<string, () => Response>) {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    const match = Object.keys(routes).find((fragment) => url.includes(fragment));
    return match ? routes[match]() : new Response("Not Found", { status: 404 });
  });
}
const headPull = (number: number, state = "open", sha = HEAD) => ({
  number,
  state,
  head: { sha },
});

beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, "fetch");
});
afterEach(() => vi.restoreAllMocks());

describe("the gate's GitHub client", () => {
  it("uses one review-gate token for the repository, minted once", async () => {
    respond({ "/pulls/42": () => Response.json({}) });
    const client = github();

    await client.getPull(42);
    await client.getPull(42);

    expect(mintReviewGateToken).toHaveBeenCalledTimes(1);
    expect(mintReviewGateToken).toHaveBeenCalledWith(CONFIG, "Acme", 99);
    expect(requests()[0].headers.get("Authorization")).toBe("Bearer gate-token");
  });

  it("fails loudly when its token cannot be minted, rather than calling GitHub unreadable", async () => {
    vi.mocked(mintReviewGateToken).mockRejectedValueOnce(
      new Error("Failed to get installation token: 422 checks permission not granted")
    );

    await expect(github().getPull(42)).rejects.toThrow("422 checks permission not granted");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads a pull request as it is now, and null when it cannot", async () => {
    respond({
      "/pulls/42": () =>
        Response.json({
          number: 42,
          state: "open",
          draft: false,
          user: { login: "alice" },
          head: { ref: "feature/cache", sha: HEAD, label: "acme:feature/cache" },
          base: { ref: "main", sha: BASE },
        }),
    });
    expect(await github().getPull(42)).toEqual(pull);

    respond({});
    expect(await github().getPull(42)).toBeNull();
    fetchMock.mockRejectedValue(new Error("network"));
    expect(await github().getPull(42)).toBeNull();
  });

  it("hashes the three-dot diff, and gives null for one GitHub will not produce", async () => {
    respond({ "/compare/": () => new Response("diff --git a/x b/x\n+one\n") });
    expect(await github().hashPullDiff(BASE, HEAD)).toMatch(/^[0-9a-f]{64}$/);
    expect(requests()[0]).toMatchObject({ url: `${REPO}/compare/${BASE}...${HEAD}` });
    expect(requests()[0].headers.get("Accept")).toBe("application/vnd.github.diff");

    respond({ "/compare/": () => new Response("too large", { status: 406 }) });
    expect(await github().hashPullDiff(BASE, HEAD)).toBeNull();
  });

  it("creates and updates the AI Review check run", async () => {
    respond({ "/check-runs": () => Response.json({ id: 31 }, { status: 201 }) });
    const client = github();

    const id = await client.createCheck(
      { headSha: HEAD, externalId: "open-inspect:pr=42", startedAt: "2026-11-23T10:00:00.000Z" },
      {
        status: "completed",
        conclusion: "action_required",
        output: { title: "Re-run the AI review before merging", summary: "No review." },
        reviewAction: true,
      }
    );
    const updated = await client.updateCheck(31, {
      status: "completed",
      conclusion: "success",
      output: { title: "Approved", summary: "ok" },
      reviewAction: false,
    });

    expect(id).toBe(31);
    expect(updated).toBe(true);
    const [created, patched] = requests();
    expect(created).toMatchObject({ url: `${REPO}/check-runs`, method: "POST" });
    expect(created.body).toEqual({
      name: "AI Review",
      head_sha: HEAD,
      started_at: "2026-11-23T10:00:00.000Z",
      external_id: "open-inspect:pr=42",
      status: "completed",
      conclusion: "action_required",
      output: { title: "Re-run the AI review before merging", summary: "No review." },
      actions: [
        {
          label: "Review now",
          description: "Run the AI review on this commit",
          identifier: "review",
        },
      ],
    });
    expect(patched).toMatchObject({ url: `${REPO}/check-runs/31`, method: "PATCH" });
    expect(patched.body).toMatchObject({ conclusion: "success", actions: [] });
  });

  it("reports a refused check write", async () => {
    respond({ "/check-runs": () => new Response("Forbidden", { status: 403 }) });
    const state = { status: "in_progress" as const, output: { title: "t", summary: "s" } };

    expect(
      await github().createCheck({ headSha: HEAD, externalId: "x", startedAt: "now" }, state)
    ).toBeNull();
    expect(await github().updateCheck(31, state)).toBe(false);
  });
});

describe("sharedHeadReason", () => {
  it("passes a pull request that is the only open one on its head commit", async () => {
    respond({
      [`/commits/${HEAD}/pulls`]: () =>
        Response.json([headPull(42), headPull(58, "closed"), headPull(59, "open", "f".repeat(40))]),
    });

    expect(await github().sharedHeadReason(pull)).toBeNull();
    expect(requests()).toHaveLength(1);
  });

  it("names the other open pull requests on the commit", async () => {
    respond({ [`/commits/${HEAD}/pulls`]: () => Response.json([headPull(42), headPull(57)]) });

    expect(await github().sharedHeadReason(pull)).toContain("#57");
  });

  it("cross-checks the head branch when GitHub lists no pull request for the commit", async () => {
    respond({
      [`/commits/${HEAD}/pulls`]: () => Response.json([]),
      "/pulls?": () => Response.json([headPull(42)]),
    });

    expect(await github().sharedHeadReason(pull)).toBeNull();
    expect(requests()[1].url).toBe(
      `${REPO}/pulls?state=open&head=acme%3Afeature%2Fcache&per_page=100`
    );
  });

  it.each([
    ["both lookups are empty", () => Response.json([]), () => Response.json([])],
    [
      "the commit lookup fails",
      () => new Response("nope", { status: 500 }),
      () => Response.json([]),
    ],
    [
      "the branch lookup fails",
      () => Response.json([]),
      () => new Response("nope", { status: 500 }),
    ],
    [
      "the listing may be incomplete",
      () => Response.json(Array.from({ length: 100 }, (_, index) => headPull(index + 1))),
      () => Response.json([]),
    ],
    [
      "the listing names only other pull requests",
      () => Response.json([headPull(57)]),
      () => Response.json([]),
    ],
  ])("fails closed when %s", async (_name, byCommit, byBranch) => {
    respond({ [`/commits/${HEAD}/pulls`]: byCommit, "/pulls?": byBranch });

    expect(await github().sharedHeadReason(pull)).toContain("Could not confirm");
  });
});
