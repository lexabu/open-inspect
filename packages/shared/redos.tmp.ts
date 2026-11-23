import { containsBotMention } from "./src/github-mention";
const cases: Record<string, string> = {
  spaces: " ".repeat(60_000) + "x @nativepath-ai",
  tabsMix: " \t".repeat(30_000) + "x @nativepath-ai",
  bullets: "- ".repeat(30_000) + "x @nativepath-ai",
  quotes: "> ".repeat(30_000) + "x @nativepath-ai",
};
for (const [k, v] of Object.entries(cases)) {
  const t = performance.now();
  containsBotMention(v, "nativepath-ai[bot]");
  console.log(k, v.length, (performance.now() - t).toFixed(0) + "ms");
}
