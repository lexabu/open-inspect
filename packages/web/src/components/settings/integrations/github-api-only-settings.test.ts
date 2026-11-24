import { describe, expect, it } from "vitest";
import { apiOnlyGitHubSettings } from "./github-api-only-settings";

describe("apiOnlyGitHubSettings", () => {
  it("carries reviewFooter into a save unchanged, on or off", () => {
    expect(apiOnlyGitHubSettings({ reviewFooter: true }).reviewFooter).toBe(true);
    expect(apiOnlyGitHubSettings({ reviewFooter: false }).reviewFooter).toBe(false);
  });

  it("leaves an unset reviewFooter out, so the save does not write it", () => {
    const carried = apiOnlyGitHubSettings({ reviewTip: true });
    expect(carried.reviewFooter).toBeUndefined();
    expect(JSON.parse(JSON.stringify(carried))).toEqual({ reviewTip: true });
    expect(apiOnlyGitHubSettings(undefined).reviewFooter).toBeUndefined();
  });
});
