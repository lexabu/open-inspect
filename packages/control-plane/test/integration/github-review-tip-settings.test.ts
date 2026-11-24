import { beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

describe("GitHub review command tip setting", () => {
  beforeEach(cleanD1Tables);

  const globalEndpoint = "https://test.local/integration-settings/github";
  const repoEndpoint = `${globalEndpoint}/repos/acme/widgets`;
  const resolvedEndpoint = `${globalEndpoint}/resolved/acme/widgets`;

  function put(url: string, settings: unknown) {
    return serviceFetch(url, { method: "PUT", body: JSON.stringify({ settings }) });
  }

  async function resolvedReviewTip(): Promise<boolean> {
    const res = await serviceFetch(resolvedEndpoint, { service: "github-bot" });
    expect(res.status).toBe(200);
    return (await res.json<{ config: { reviewTip: boolean } }>()).config.reviewTip;
  }

  it("resolves reviewTip: off by default, inherited, and overridable per repository", async () => {
    expect(await resolvedReviewTip()).toBe(false);
    expect((await put(globalEndpoint, { defaults: { reviewTip: true } })).status).toBe(200);
    expect(await resolvedReviewTip()).toBe(true);
    expect((await put(repoEndpoint, { reviewTip: false })).status).toBe(200);
    expect(await resolvedReviewTip()).toBe(false);
  });

  it("stores reviewTip as written and reads it back", async () => {
    expect((await put(repoEndpoint, { reviewTip: true })).status).toBe(200);
    const res = await serviceFetch(repoEndpoint);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ settings: { reviewTip: true } });
    expect(await resolvedReviewTip()).toBe(true);
  });

  it("rejects a reviewTip that is not a boolean", async () => {
    expect((await put(repoEndpoint, { reviewTip: "yes" })).status).toBe(400);
    expect(await resolvedReviewTip()).toBe(false);
  });
});
