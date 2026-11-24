import { TurnActivity, type PullRequestTarget, type ToolCallEvent } from "./session-activity";

/** The pull request the test session was started for. */
export const TARGET: PullRequestTarget = { owner: "Acme", name: "widgets", number: 7 };
export const REVIEW_URL = "https://github.com/acme/widgets/pull/7#pullrequestreview-111";
export const COMMENT_URL = "https://github.com/acme/widgets/pull/7#issuecomment-222";
/** Another reviewer's review on the same pull request. */
export const SIBLING_REVIEW_URL = "https://github.com/acme/widgets/pull/7#pullrequestreview-333";

let sequence = 0;
export function call(
  tool: string,
  args: Record<string, unknown>,
  output: string,
  status = "completed"
): ToolCallEvent {
  sequence += 1;
  return {
    type: "tool_call",
    messageId: "msg-1",
    callId: `call-${sequence}`,
    tool,
    args,
    output,
    status,
    sandboxId: "sb",
    timestamp: 1,
  };
}

export const bash = (command: string, output: string, status?: string) =>
  call("bash", { command }, output, status);

/** What `gh api` prints for a created review: the review, its body echoed back. */
export const createdReview = (id: number, body = "LGTM", pull = 7) =>
  JSON.stringify({
    id,
    user: { login: "nativepath-ai[bot]", html_url: "https://github.com/apps/nativepath-ai" },
    body,
    state: "COMMENTED",
    html_url: `https://github.com/acme/widgets/pull/${pull}#pullrequestreview-${id}`,
    _links: {
      html: { href: `https://github.com/acme/widgets/pull/${pull}#pullrequestreview-${id}` },
    },
  });

export const createdComment = (id: number, pull = 7) =>
  JSON.stringify({
    url: `https://api.github.com/repos/acme/widgets/issues/comments/${id}`,
    html_url: `https://github.com/acme/widgets/pull/${pull}#issuecomment-${id}`,
    id,
    body: "Done",
  });

/** The posts a turn made of these tool calls created, for the test session. */
export function postsOf(calls: ToolCallEvent[], hindsightServers: string[] = []) {
  const activity = new TurnActivity(TARGET, hindsightServers);
  calls.forEach((toolCall) => activity.add(toolCall));
  return activity.posts();
}

/** The memory a turn made of these tool calls used. */
export function memoryOf(calls: ToolCallEvent[], hindsightServers: string[] = []) {
  const activity = new TurnActivity(TARGET, hindsightServers);
  calls.forEach((toolCall) => activity.add(toolCall));
  return activity.memory();
}
