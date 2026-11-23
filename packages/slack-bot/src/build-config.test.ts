import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("worker build", () => {
  it("resolves packages for the Workers runtime, not the browser", () => {
    // esbuild's browser platform otherwise picks DOM-only package variants (the
    // Markdown parser's decode-named-character-reference touches `document`), and
    // Cloudflare rejects the upload at startup. See the github-bot build.
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url).pathname, "utf8")
    );
    expect(pkg.scripts.build).toContain("--conditions=workerd,module");
  });
});
