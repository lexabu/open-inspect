/**
 * What a turn did on GitHub and with memory, read from its own tool calls: the session's
 * record of what it ran and what came back, which no one else can write. Each call is
 * reduced to a fact as it is read (a post receipt, a memory outcome), and its output is
 * not kept.
 */
import { MEMORY_TOOL_NAMES } from "@open-inspect/shared/memory-tools";
import {
  memorySearchResponseSchema,
  sandboxMemoryReadResultSchema,
  sandboxMemoryWriteResultSchema,
} from "@open-inspect/shared/types/memories";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { MemoryActivity, MemorySourceActivity, PostKind } from "./render";

export type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;

/** A pull request review or conversation comment the turn created. */
export interface SessionPost {
  kind: PostKind;
  pullNumber: number;
  id: number;
}

/** The pull request a session was started for, on its repository. */
export interface PullRequestTarget {
  owner: string;
  name: string;
  number: number;
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The command text without here-document bodies, with line continuations joined. */
function commandLine(command: string): string {
  const lines: string[] = [];
  const pendingBodies: string[] = [];
  for (const line of command.split("\n")) {
    if (pendingBodies.length > 0) {
      if (line.trim() === pendingBodies[0]) pendingBodies.shift();
      continue;
    }
    lines.push(line);
    for (const match of line.matchAll(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1/g)) {
      pendingBodies.push(match[2]);
    }
  }
  return lines.join("\n").replace(/\\\n/g, " ");
}

/**
 * The words of a shell command that runs exactly one simple command, or null for anything
 * else: chains, pipes, background jobs, subshells and command substitutions, any of which
 * can print another command's output next to this one's. Quotes and escapes are honoured.
 */
export function singleCommandWords(command: string): string[] | null {
  // Trailing whitespace, such as the newline after a here-document's delimiter, runs nothing.
  const text = commandLine(command).trimEnd();
  const words: string[] = [];
  let word: string | null = null;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (char === "`" || (char === "$" && text[i + 1] === "(")) return null;
    if (char === "\\" && i + 1 < text.length) {
      i += 1;
      word = (word ?? "") + text[i];
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      word ??= "";
    } else if (char === " " || char === "\t") {
      if (word !== null) words.push(word);
      word = null;
    } else {
      // `&` inside a redirection (`2>&1`) is part of it; anywhere else it ends the command.
      const redirect = char === "&" && (text[i - 1] === ">" || text[i - 1] === "<");
      if (";|&()\n".includes(char) && !redirect) return null;
      word = (word ?? "") + char;
    }
  }
  if (quote !== null) return null;
  if (word !== null) words.push(word);
  return words;
}

/** A redirection word (`<<JSON`, `2>&1`, `>`), with its target when written apart. */
const REDIRECTION = /^(?:\d*|&)(?:<<-?|<<<|<>|>>|>\||<&|>&|<|>)(.*)$/;

/** The words that are arguments: redirections and their targets are the shell's, not the command's. */
function commandArguments(words: string[]): string[] {
  const args: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const redirection = REDIRECTION.exec(words[i]);
    if (!redirection) args.push(words[i]);
    else if (redirection[1] === "") i += 1;
  }
  return args;
}

/** `gh api` flags that take a value. */
const GH_API_VALUE_FLAGS = new Set([
  "-X",
  "--method",
  "-f",
  "--raw-field",
  "-F",
  "--field",
  "-H",
  "--header",
  "--input",
  "-q",
  "--jq",
  "-t",
  "--template",
  "--hostname",
  "--cache",
  "-p",
  "--preview",
]);
const GH_API_BODY_FLAGS = new Set(["-f", "--raw-field", "-F", "--field", "--input"]);
/** `gh api` flags that print something other than the response: no longer a receipt. */
const GH_API_OUTPUT_FLAGS = new Set(["-q", "--jq", "-t", "--template"]);

/** The method and endpoint of a `gh api` call, from the words after `gh api`. */
function ghApiRequest(args: string[]): { method: string; endpoint: string } | null {
  let method: string | null = null;
  let hasBody = false;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    if (/^-X./.test(arg)) {
      method = arg.slice(2);
    } else if (GH_API_OUTPUT_FLAGS.has(flag)) {
      return null;
    } else if (GH_API_VALUE_FLAGS.has(flag)) {
      const value = equals === -1 ? args[++i] : arg.slice(equals + 1);
      if (value === undefined) return null;
      if (flag === "-X" || flag === "--method") method = value;
      if (GH_API_BODY_FLAGS.has(flag)) hasBody = true;
    } else if (!arg.startsWith("-")) {
      positionals.push(arg);
    }
  }
  if (positionals.length !== 1) return null;
  // Without a method gh sends GET, or POST once it has a body to send.
  const resolved = method ?? (hasBody ? "POST" : "GET");
  return { method: resolved.toUpperCase(), endpoint: positionals[0] };
}

/** The post kind a REST creation endpoint on the target pull request makes, or null. */
function creationEndpointKind(endpoint: string, target: PullRequestTarget): PostKind | null {
  const [repos, owner, name, collection, number, items, ...rest] = endpoint
    .replace(/^\//, "")
    .split("/");
  if (repos !== "repos" || rest.length > 0 || number !== String(target.number)) return null;
  const ownerMatches = owner === "{owner}" || owner?.toLowerCase() === target.owner.toLowerCase();
  const nameMatches = name === "{repo}" || name?.toLowerCase() === target.name.toLowerCase();
  if (!ownerMatches || !nameMatches) return null;
  if (collection === "pulls" && items === "reviews") return "review";
  if (collection === "issues" && items === "comments") return "comment";
  return null;
}

/** `gh pr comment` flags that change an existing comment or open an editor instead. */
const GH_PR_COMMENT_NOT_CREATING = new Set([
  "--edit-last",
  "--delete-last",
  "--create-if-none",
  "--web",
  "-w",
  "--editor",
  "-e",
]);

/**
 * The post a tool call created on the target pull request, from its creation receipt, or
 * null. Only two receipts count, each from a call that runs one command and nothing else:
 * - `gh api` POST to `repos/{o}/{r}/pulls/{n}/reviews` or `repos/{o}/{r}/issues/{n}/comments`,
 *   whose whole output is one JSON object, the created post, with its `html_url`;
 * - `gh pr comment` posting a new comment, whose whole output is that comment's URL.
 * GraphQL is never read: its responses cannot be told apart from reads of other posts.
 */
function postReceipt(call: ToolCallEvent, target: PullRequestTarget): SessionPost | null {
  const command = call.args.command;
  if (call.status !== "completed" || typeof command !== "string" || !call.output) return null;
  const shellWords = singleCommandWords(command);
  const words = shellWords && commandArguments(shellWords);
  if (!words || words[0] !== "gh") return null;
  const output = call.output.trim();
  let expected: PostKind | null = null;
  let url: unknown;
  if (words[1] === "pr" && words[2] === "comment") {
    const flags = words.slice(3).map((word) => word.split("=", 1)[0]);
    if (flags.some((flag) => GH_PR_COMMENT_NOT_CREATING.has(flag))) return null;
    expected = "comment";
    url = output;
  } else if (words[1] === "api") {
    const request = ghApiRequest(words.slice(2));
    if (request?.method !== "POST") return null;
    expected = creationEndpointKind(request.endpoint, target);
    const created = parseJson(output);
    url = isRecord(created) ? created.html_url : undefined;
  }
  if (expected === null || typeof url !== "string") return null;
  const match = new RegExp(
    `^https://github\\.com/${escapeRegExp(target.owner)}/${escapeRegExp(target.name)}/pull/${target.number}#(pullrequestreview|issuecomment)-(\\d+)$`,
    "i"
  ).exec(url);
  if (!match) return null;
  const kind: PostKind = match[1].toLowerCase() === "pullrequestreview" ? "review" : "comment";
  return kind === expected ? { kind, pullNumber: target.number, id: Number(match[2]) } : null;
}

/** One memory call's outcome, validated against what the tool returns on success. */
type MemoryOutcome =
  "searched" | "matched" | "fact_recalled" | "updated" | "proposed" | "failed" | "no_fact";

const BUILT_IN_MEMORY_TOOLS: ReadonlySet<string> = new Set(MEMORY_TOOL_NAMES);

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

/** Hindsight answers a failure with an `error` field; a recall's facts are its `results`. */
function hindsightOutcomes(tool: string, output: string): MemoryOutcome[] {
  const response = parseJson(output);
  if (isRecord(response) && response.error !== undefined && response.error !== null) {
    return ["failed"];
  }
  // An empty answer is not a saved fact or a reflection.
  if ((tool === "retain" || tool === "reflect") && output.trim() === "") return ["failed"];
  if (tool === "retain") return ["updated"];
  // A reflection answers in prose, not facts: it searched, but used none that can be counted.
  if (tool === "reflect") return ["searched"];
  if (!isRecord(response) || !Array.isArray(response.results)) return ["failed"];
  return ["searched", ...response.results.map((): MemoryOutcome => "fact_recalled")];
}

function builtInOutcomes(tool: string, output: string): MemoryOutcome[] {
  const response = parseJson(output);
  if (tool === "memory_search") {
    const search = memorySearchResponseSchema.safeParse(response);
    if (!search.success) return ["failed"];
    return ["searched", ...search.data.results.map((): MemoryOutcome => "matched")];
  }
  return [builtInOutcome(tool, response)];
}

function builtInOutcome(tool: string, response: unknown): MemoryOutcome {
  if (tool === "memory_read") {
    const read = sandboxMemoryReadResultSchema.safeParse(response);
    if (!read.success) return "failed";
    // An archived fact comes back as a notice without its body: nothing to use.
    return read.data.status === "active" ? "fact_recalled" : "no_fact";
  }
  const write = sandboxMemoryWriteResultSchema.safeParse(response);
  if (!write.success) return "failed";
  return write.data.status === "active" ? "updated" : "proposed";
}

function emptySource(): MemorySourceActivity {
  return { searched: false, factsRecalled: 0, matched: 0, updated: 0, proposed: 0, failed: 0 };
}

function record(activity: MemorySourceActivity, outcome: MemoryOutcome): void {
  if (outcome === "searched") activity.searched = true;
  else if (outcome === "matched") activity.matched += 1;
  else if (outcome === "fact_recalled") activity.factsRecalled += 1;
  else if (outcome === "updated") activity.updated += 1;
  else if (outcome === "proposed") activity.proposed += 1;
  else if (outcome === "failed") activity.failed += 1;
}

/** Facts gathered from one turn's tool calls, added one call at a time. */
export class TurnActivity {
  private readonly receipts = new Map<string, SessionPost>();
  private readonly hindsight = emptySource();
  private readonly builtIn = emptySource();
  private builtInCalls = 0;
  private readonly hindsightTool: (tool: string) => string | undefined;

  /** `hindsightServers` names the Hindsight MCP servers configured for the session. */
  constructor(
    private readonly target: PullRequestTarget,
    private readonly hindsightServers: string[]
  ) {
    this.hindsightTool = hindsightToolMatcher(hindsightServers);
  }

  add(call: ToolCallEvent): void {
    const post = postReceipt(call, this.target);
    if (post) this.receipts.set(`${post.kind}:${post.id}`, post);

    const hindsightTool = this.hindsightTool(call.tool);
    const builtIn = BUILT_IN_MEMORY_TOOLS.has(call.tool);
    if (builtIn) this.builtInCalls += 1;
    // A call still running when the turn ended has no outcome to count.
    if (call.status === "running") return;
    const output = call.status === "completed" ? (call.output ?? "") : null;
    if (builtIn) {
      const outcomes = output === null ? ["failed" as const] : builtInOutcomes(call.tool, output);
      for (const outcome of outcomes) record(this.builtIn, outcome);
    } else if (hindsightTool !== undefined) {
      const outcomes =
        output === null ? ["failed" as const] : hindsightOutcomes(hindsightTool, output);
      for (const outcome of outcomes) record(this.hindsight, outcome);
    }
  }

  posts(): SessionPost[] {
    return [...this.receipts.values()];
  }

  /**
   * Memory per source: Hindsight whenever a Hindsight server is configured (idle or not),
   * built-in memory only when the turn called it; null when neither applies.
   */
  memory(): MemoryActivity | null {
    const hindsight = this.hindsightServers.length > 0 ? { ...this.hindsight } : null;
    const builtIn = this.builtInCalls > 0 ? { ...this.builtIn } : null;
    return hindsight || builtIn ? { hindsight, builtIn } : null;
  }
}
