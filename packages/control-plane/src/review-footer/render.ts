/**
 * The one footer line a GitHub-triggered session's post ends with, built from platform
 * data the agent cannot know when it posts: the model, the memory it actually used, and
 * the session's final cost.
 */
import { ADVISORY_APPROVE_MARKER } from "@open-inspect/shared/github-review-verdict";
import { getModelDisplayName } from "@open-inspect/shared/models";
import { isOpenCodeBedrockModel } from "../sandbox/bedrock-env";

/** Marks the footer, so a re-run replaces it instead of adding a second one. */
export const REVIEW_FOOTER_MARKER = "<!-- open-inspect:footer -->";

/** What one memory source did in a turn, counted from its tool calls' validated results. */
export interface MemorySourceActivity {
  searched: boolean;
  /** Facts returned to the agent: Hindsight recall results, or built-in reads of a fact. */
  factsUsed: number;
  /** Facts saved as active (Hindsight retain, or a built-in write that took effect). */
  updated: number;
  /** Built-in writes that await approval. */
  proposed: number;
  /** Calls that failed or returned something other than a result. */
  failed: number;
}

/** Memory per source; a source is null when it does not apply to the session. */
export interface MemoryActivity {
  /** Set whenever a Hindsight server is configured, called or not. */
  hindsight: MemorySourceActivity | null;
  /** Set when the turn called a built-in memory tool. */
  builtIn: MemorySourceActivity | null;
}

export type PostKind = "review" | "comment";

export interface FooterFacts {
  kind: PostKind;
  modelId: string;
  totalCostUsd: number;
  /** Null when the session had no memory configured: the phrase is left out. */
  memory: MemoryActivity | null;
}

const BEDROCK_NAME_SUFFIX = " (Bedrock)";
const CENT = 0.01;

function formatCost(usd: number): string {
  if (usd > 0 && usd < CENT / 2) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function sourcePhrase(label: string, activity: MemorySourceActivity): string {
  const parts = [
    ...(activity.searched && activity.factsUsed === 0 ? ["searched, nothing relevant"] : []),
    ...(activity.searched && activity.factsUsed > 0 ? ["searched"] : []),
    ...(activity.factsUsed > 0 ? [`${plural(activity.factsUsed, "fact")} used`] : []),
    ...(activity.updated > 0 ? ["updated"] : []),
    ...(activity.proposed > 0 ? [`${plural(activity.proposed, "fact")} proposed`] : []),
  ];
  if (parts.length > 0) return `${label}: ${parts.join(", ")}`;
  return `${label}: ${activity.failed > 0 ? "unavailable" : "not used"}`;
}

/** One phrase per memory source that applies, Hindsight first. */
export function memoryPhrases(memory: MemoryActivity): string[] {
  return [
    ...(memory.hindsight ? [sourcePhrase("Hindsight memory", memory.hindsight)] : []),
    ...(memory.builtIn ? [sourcePhrase("built-in memory", memory.builtIn)] : []),
  ];
}

export function renderFooterLine(facts: FooterFacts): string {
  const bedrock = isOpenCodeBedrockModel(facts.modelId);
  const name = getModelDisplayName(facts.modelId);
  const model =
    bedrock && name.endsWith(BEDROCK_NAME_SUFFIX)
      ? name.slice(0, -BEDROCK_NAME_SUFFIX.length)
      : name;
  return [
    `${facts.kind === "review" ? "Findings" : "Reply"} via ${model}`,
    ...(facts.memory ? memoryPhrases(facts.memory) : []),
    `${bedrock ? "Bedrock cost" : "Cost"}: ${formatCost(facts.totalCostUsd)}`,
  ].join(" · ");
}

const FOOTER_LINE = /^(?:Findings|Reply) via /;
const FENCE = /^\s*(?:```|~~~)/;

/** Whether the lines end with the marker line and one footer line, outside any code fence. */
function endsWithFooterBlock(lines: string[]): boolean {
  const count = lines.length;
  if (count < 2 || lines[count - 2].trimEnd() !== REVIEW_FOOTER_MARKER) return false;
  if (!FOOTER_LINE.test(lines[count - 1])) return false;
  return lines.slice(0, -2).filter((text) => FENCE.test(text)).length % 2 === 0;
}

/**
 * The body with `line` as its footer. A trailing advisory-approval marker line is split off
 * first and kept last. Only a complete footer block at the very end (the marker line, then
 * one footer line) is replaced; a marker anywhere else, in code or a quote, is body text.
 */
export function applyFooter(body: string, line: string): string {
  const lines = body.trimEnd().split("\n");
  const advisory = lines.at(-1)?.trim() === ADVISORY_APPROVE_MARKER;
  if (advisory) lines.pop();
  while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
  if (endsWithFooterBlock(lines)) lines.splice(-2);
  const text = lines.join("\n").trimEnd();
  const footer = [REVIEW_FOOTER_MARKER, line, ...(advisory ? [ADVISORY_APPROVE_MARKER] : [])];
  return text ? `${text}\n\n${footer.join("\n")}` : footer.join("\n");
}
