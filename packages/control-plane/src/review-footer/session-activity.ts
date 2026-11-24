/**
 * What a session did on GitHub and with memory, read from its own tool calls: the
 * session's record of what it ran and what came back, which no one else can write.
 */
import { MEMORY_TOOL_NAMES, type MemoryToolName } from "@open-inspect/shared/memory-tools";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { MemoryActivity, PostKind } from "./render";

export type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;

/** A pull request review or conversation comment the session created. */
export interface SessionPost {
  kind: PostKind;
  pullNumber: number;
  id: number;
}

const GH_PR_COMMENT = /\bgh\s+pr\s+comment\b/;
const GH_API = /\bgh\s+api\b/;
const METHOD = /(?:^|\s)(?:-X|--method)(?:\s+|=)['"]?([A-Za-z]+)/;
/** `gh api` sends a request body, and so defaults to POST, when given any of these. */
const FIELD_FLAG = /(?:^|\s)(?:-f|-F|--field|--raw-field|--input)(?:\s|=)/;

/** Whether a shell command creates a GitHub post: a write through `gh api`, or `gh pr comment`. */
function createsPost(command: string): boolean {
  if (GH_PR_COMMENT.test(command)) return true;
  if (!GH_API.test(command)) return false;
  const method = METHOD.exec(command)?.[1]?.toUpperCase();
  return method === undefined ? FIELD_FLAG.test(command) : method === "POST";
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Bash-like tool calls that finished, with their command and output. */
function completedCommands(toolCalls: ToolCallEvent[]): { command: string; output: string }[] {
  return toolCalls.flatMap((call) => {
    const command = call.args.command;
    return call.status === "completed" && typeof command === "string" && call.output
      ? [{ command, output: call.output }]
      : [];
  });
}

/**
 * The reviews and conversation comments the session created on `repository`'s pull
 * requests. Each comes from a creating command's own response: the created object's
 * `html_url` when the output is that object, otherwise an output line that is exactly a
 * post URL (`gh pr comment`, or `--jq .html_url`). Links inside a body are never read,
 * so another reviewer's post that this session merely cites is not taken for its own.
 * Inline review comments are not included.
 */
export function findSessionPosts(
  toolCalls: ToolCallEvent[],
  repository: { owner: string; name: string }
): SessionPost[] {
  const postUrl = new RegExp(
    `^https://github\\.com/${escapeRegExp(repository.owner)}/${escapeRegExp(repository.name)}/pull/(\\d+)#(pullrequestreview|issuecomment)-(\\d+)$`,
    "i"
  );
  const posts = new Map<string, SessionPost>();
  for (const { command, output } of completedCommands(toolCalls)) {
    if (!createsPost(command)) continue;
    const response = parseJson(output.trim());
    const urls =
      isRecord(response) && typeof response.html_url === "string"
        ? [response.html_url]
        : output.split("\n").map((line) => line.trim());
    for (const url of urls) {
      const match = postUrl.exec(url);
      if (!match) continue;
      const post: SessionPost = {
        kind: match[2].toLowerCase() === "pullrequestreview" ? "review" : "comment",
        pullNumber: Number(match[1]),
        id: Number(match[3]),
      };
      posts.set(`${post.kind}:${post.id}`, post);
    }
  }
  return [...posts.values()];
}

const BUILT_IN_MEMORY_TOOLS: ReadonlySet<string> = new Set(MEMORY_TOOL_NAMES);
const PROPOSED_WRITE = /"status"\s*:\s*"proposed"/;

function isBuiltInMemoryTool(tool: string): tool is MemoryToolName {
  return BUILT_IN_MEMORY_TOOLS.has(tool);
}

/**
 * The Hindsight tool a call made, as each harness names a server's tools
 * (`mcp__<server>__recall` for Claude and Codex, `<server>_recall` for OpenCode).
 */
function hindsightToolMatcher(servers: string[]): (tool: string) => string | undefined {
  if (servers.length === 0) return () => undefined;
  const names = servers.map(escapeRegExp).join("|");
  const pattern = new RegExp(`^(?:mcp__(?:${names})__|(?:${names})_)(recall|reflect|retain)$`);
  return (tool) => pattern.exec(tool)?.[1];
}

/** How many facts a Hindsight recall returned; 0 when its output is not the usual shape. */
function recalledFacts(output: string | undefined): number {
  const response = output === undefined ? undefined : parseJson(output);
  return isRecord(response) && Array.isArray(response.results) ? response.results.length : 0;
}

/**
 * The session's memory activity, or null when it had no memory to use: no Hindsight
 * server configured for it and no built-in memory tool called.
 */
export function countMemoryActivity(
  toolCalls: ToolCallEvent[],
  hindsightServers: string[]
): MemoryActivity | null {
  const hindsightTool = hindsightToolMatcher(hindsightServers);
  let builtInUsed = false;
  const activity = { searched: false, factsUsed: 0, updated: 0, proposed: 0, failed: 0 };
  for (const call of toolCalls) {
    const hindsight = hindsightTool(call.tool);
    const builtIn = isBuiltInMemoryTool(call.tool);
    if (builtIn) builtInUsed = true;
    if (hindsight === undefined && !builtIn) continue;
    if (call.status === "error") activity.failed += 1;
    if (call.status !== "completed") continue;
    if (hindsight === "retain") activity.updated += 1;
    else if (hindsight !== undefined) {
      activity.searched = true;
      activity.factsUsed += recalledFacts(call.output);
    } else if (call.tool === "memory_search") activity.searched = true;
    else if (call.tool === "memory_read") activity.factsUsed += 1;
    else if (PROPOSED_WRITE.test(call.output ?? "")) activity.proposed += 1;
    else activity.updated += 1;
  }
  if (hindsightServers.length > 0) return { label: "Hindsight memory", ...activity };
  return builtInUsed ? { label: "Memory", ...activity } : null;
}
