import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("github-bot worker build", () => {
  it("resolves packages for the Workers runtime, not the browser", () => {
    // Without the workerd condition, esbuild's browser platform picks DOM-only
    // variants (decode-named-character-reference's index.dom.js touches
    // `document`), and Cloudflare rejects the upload at startup.
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts.build).toContain("--conditions=workerd,module");
  });
});
