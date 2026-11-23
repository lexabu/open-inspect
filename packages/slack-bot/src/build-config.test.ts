import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("worker build", () => {
  it("resolves packages for the Workers runtime, not the browser", () => {
    // Preventive: esbuild's browser platform otherwise picks DOM-only package
    // variants, which Cloudflare rejects at startup (this broke the github-bot when
    // it began bundling the shared Markdown parser).
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url).href), "utf8")
    );
    expect(pkg.scripts.build).toContain("--conditions=workerd,module");
  });
});
