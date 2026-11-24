import { beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

describe("GitHub review footer setting", () => {
  beforeEach(cleanD1Tables);

  const globalEndpoint = "https://test.local/integration-settings/github";
  const repoEndpoint = `${globalEndpoint}/repos/acme/widgets`;
  const resolvedEndpoint = `${globalEndpoint}/resolved/acme/widgets`;

  function put(url: string, settings: unknown) {
    return serviceFetch(url, { method: "PUT", body: JSON.stringify({ settings }) });
  }

  async function resolvedReviewFooter(): Promise<boolean> {
    const res = await serviceFetch(resolvedEndpoint, { service: "github-bot" });
    expect(res.status).toBe(200);
    return (await res.json<{ config: { reviewFooter: boolean } }>()).config.reviewFooter;
  }

  it("resolves reviewFooter: off by default, inherited, and overridable per repository", async () => {
    expect(await resolvedReviewFooter()).toBe(false);
    expect((await put(globalEndpoint, { defaults: { reviewFooter: true } })).status).toBe(200);
    expect(await resolvedReviewFooter()).toBe(true);
    expect((await put(repoEndpoint, { reviewFooter: false })).status).toBe(200);
    expect(await resolvedReviewFooter()).toBe(false);
  });

  it("stores reviewFooter as written and reads it back", async () => {
    expect((await put(repoEndpoint, { reviewFooter: true })).status).toBe(200);
    const res = await serviceFetch(repoEndpoint);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ settings: { reviewFooter: true } });
    expect(await resolvedReviewFooter()).toBe(true);
  });

  it("rejects a reviewFooter that is not a boolean", async () => {
    expect((await put(repoEndpoint, { reviewFooter: "yes" })).status).toBe(400);
    expect(await resolvedReviewFooter()).toBe(false);
  });
});
