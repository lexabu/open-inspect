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

/** What a session did with memory, counted from its own tool calls. */
export interface MemoryActivity {
  /** "Hindsight memory" when a Hindsight server took part, otherwise the built-in "Memory". */
  label: "Hindsight memory" | "Memory";
  searched: boolean;
  /** Facts returned to the agent: Hindsight recall results plus built-in memory reads. */
  factsUsed: number;
  /** Facts saved as active (Hindsight retain, or a built-in write that took effect). */
  updated: number;
  /** Built-in writes that await approval. */
  proposed: number;
  /** Memory calls that ended in an error. */
  failed: number;
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

export function memoryPhrase(memory: MemoryActivity): string {
  const parts = [
    ...(memory.searched ? ["searched"] : []),
    ...(memory.factsUsed > 0 ? [`${plural(memory.factsUsed, "fact")} used`] : []),
    ...(memory.updated > 0 ? ["updated"] : []),
    ...(memory.proposed > 0 ? [`${plural(memory.proposed, "fact")} proposed`] : []),
  ];
  if (parts.length > 0) return `${memory.label}: ${parts.join(", ")}`;
  return `${memory.label}: ${memory.failed > 0 ? "unavailable" : "not used"}`;
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
    ...(facts.memory ? [memoryPhrase(facts.memory)] : []),
    `${bedrock ? "Bedrock cost" : "Cost"}: ${formatCost(facts.totalCostUsd)}`,
  ].join(" · ");
}

/** An earlier footer: the marker, its line, and the blank lines before it. */
const EXISTING_FOOTER = new RegExp(`\\s*${REVIEW_FOOTER_MARKER}[^\\n]*(?:\\n[^\\n]*)?`, "g");

/**
 * The body with `line` as its footer, replacing any earlier footer. The footer goes last,
 * except before a trailing advisory-approval marker, which stays the body's last line.
 */
export function applyFooter(body: string, line: string): string {
  let text = body.replace(EXISTING_FOOTER, "").trimEnd();
  const advisory = text.endsWith(ADVISORY_APPROVE_MARKER);
  if (advisory) text = text.slice(0, -ADVISORY_APPROVE_MARKER.length).trimEnd();
  const footer = `${REVIEW_FOOTER_MARKER}\n${line}${advisory ? `\n${ADVISORY_APPROVE_MARKER}` : ""}`;
  return text ? `${text}\n\n${footer}` : footer;
}
