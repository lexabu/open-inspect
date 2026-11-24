import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GitHubApp from "../auth/github-app";

vi.mock("../auth/github-app", async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubApp>()),
  mintReviewFooterToken: vi.fn(async () => "footer-token"),
}));

import { mintReviewFooterToken } from "../auth/github-app";
import { createFooterGitHub } from "./github";

const CONFIG = { appId: "1", privateKey: "key", installationId: "2" };
const REPO = "https://api.github.com/repos/acme/widgets";
const review = { kind: "review", pullNumber: 7, id: 111 } as const;
const comment = { kind: "comment", pullNumber: 7, id: 222 } as const;

let fetchMock: ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">>;
const github = () => createFooterGitHub(CONFIG, { owner: "acme", name: "widgets", id: 99 }, "Acme");
const requests = () =>
  fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    method: init?.method,
    authorization: new Headers(init?.headers).get("Authorization"),
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  }));

beforeEach(() => {
  vi.mocked(mintReviewFooterToken).mockClear();
  fetchMock = vi.spyOn(globalThis, "fetch");
});
afterEach(() => vi.restoreAllMocks());

describe("the review footer's GitHub client", () => {
  it("reads and edits a review on the review endpoint, with PUT", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ user: { login: "bot[bot]" }, body: "LGTM" })
    );
    const client = github();

    expect(await client.readPost(review)).toEqual({
      outcome: "ok",
      value: { author: "bot[bot]", body: "LGTM" },
    });
    expect(await client.writePost(review, "LGTM\n\nfooter")).toEqual({
      outcome: "ok",
      value: null,
    });

    expect(requests()).toEqual([
      {
        url: `${REPO}/pulls/7/reviews/111`,
        method: "GET",
        authorization: "Bearer footer-token",
        body: undefined,
      },
      {
        url: `${REPO}/pulls/7/reviews/111`,
        method: "PUT",
        authorization: "Bearer footer-token",
        body: { body: "LGTM\n\nfooter" },
      },
    ]);
    expect(mintReviewFooterToken).toHaveBeenCalledTimes(1);
    expect(mintReviewFooterToken).toHaveBeenCalledWith(CONFIG, "Acme", 99);
  });

  it("reads and edits a conversation comment on the issue comment endpoint, with PATCH", async () => {
    fetchMock.mockImplementation(async () => Response.json({ user: null, body: null }));
    const client = github();

    expect(await client.readPost(comment)).toEqual({
      outcome: "ok",
      value: { author: null, body: "" },
    });
    await client.writePost(comment, "Done");

    expect(requests().map(({ url, method }) => [method, url])).toEqual([
      ["GET", `${REPO}/issues/comments/222`],
      ["PATCH", `${REPO}/issues/comments/222`],
    ]);
  });

  it.each([403, 404, 422])("calls a %s refused, which no retry changes", async (status) => {
    fetchMock.mockResolvedValue(new Response("no", { status }));
    expect(await github().writePost(review, "x")).toEqual({ outcome: "refused", status });
  });

  it("calls a server error, a network error or an unreadable post a failure worth retrying", async () => {
    const client = github();
    fetchMock.mockResolvedValueOnce(new Response("busy", { status: 502 }));
    expect(await client.readPost(review)).toEqual({ outcome: "failed", reason: "HTTP 502" });
    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await client.readPost(review)).toEqual({ outcome: "failed", reason: "socket hang up" });
    fetchMock.mockResolvedValueOnce(Response.json({ nope: true }));
    expect(await client.readPost(review)).toEqual({ outcome: "failed", reason: "unreadable post" });
  });

  it("mints its token again after a failed mint", async () => {
    vi.mocked(mintReviewFooterToken).mockRejectedValueOnce(new Error("mint failed"));
    fetchMock.mockImplementation(async () => Response.json({ user: null, body: "b" }));
    const client = github();

    expect(await client.readPost(review)).toEqual({ outcome: "failed", reason: "mint failed" });
    expect(await client.readPost(review)).toMatchObject({ outcome: "ok" });
    expect(mintReviewFooterToken).toHaveBeenCalledTimes(2);
  });
});
