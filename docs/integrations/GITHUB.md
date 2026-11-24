# GitHub Integration

Open-Inspect's GitHub integration lets your team start agent work from pull requests. The GitHub Bot
can automatically review new PRs and respond when you mention it in PR comments or inline review
threads.

This guide is for people using the GitHub integration day to day. If you are installing the GitHub
App or deploying the bot worker, start with
[Create GitHub App](../GETTING_STARTED.md#step-3-create-github-app) and
[Complete GitHub Bot Setup](../GETTING_STARTED.md#github-bot-optional).

---

## Quick Start

1. Make sure the GitHub App is installed on the repository.
2. To get an automatic review, open a non-draft PR in a repository where auto-review is enabled.
3. To ask for analysis or a reply, mention the bot in a PR comment:
   ```text
   @my-app[bot] can you explain why the checkout test is failing?
   ```
4. For line-specific discussion, mention the bot in an inline PR review comment.
5. Watch for the eyes reaction, which means the bot accepted the request.
6. Open the Open-Inspect web app to watch the full session.

---

## Supported Workflows

| Workflow                  | How it works                                                               |
| ------------------------- | -------------------------------------------------------------------------- |
| Auto-review new PRs       | Review non-draft PRs when they are opened, if auto-review is enabled       |
| Respond to PR comments    | Mention the bot in a PR conversation comment                               |
| Respond to review threads | Mention the bot in an inline review comment                                |
| Post back to GitHub       | Submit a PR review, reply to a review thread, or post a PR summary comment |
| Customize behavior        | Set repository scope, trigger users, models, and custom instructions       |

Open-Inspect does not use GitHub slash commands today, and it does not support requesting the GitHub
App bot through the PR reviewer picker. Use auto-review or `@mention` comments instead.

---

## Automatic PR Reviews

**Auto-review new PRs** is the deprecated, workspace-owned review-on-open path. It still works and
does not use mention team routing. For team-owned event-driven reviews, use a GitHub Event
automation owned by the intended team instead. Deprecation does not disable the existing setting.

### When It Runs

When **Auto-review new PRs** is enabled, Open-Inspect starts a review session for newly opened,
non-draft PRs in enabled repositories. The agent inspects the PR diff and posts a GitHub review.

### When It Skips

Auto-review is skipped when:

- The PR is a draft
- The PR was opened by the GitHub App bot itself without its login explicitly allowed as a trigger
- The repository is outside the configured GitHub Bot scope
- The PR opener is not allowed to trigger the bot
- Auto-review is disabled globally or for that repository

Converting a draft PR to ready for review does not start the same auto-review path, unless the
[AI Review check](#ai-review-check) is on. Otherwise, if you need a follow-up after a draft becomes
ready, mention the bot in a PR comment.

### What It Posts

The agent can submit a general review comment, approve the PR, request changes, or add inline review
comments when useful.

An explicitly allowed App bot can trigger review of its own PR, but that self-review can only
comment, not approve or request changes. Allowing the login only passes the bot's trigger gate: the
request still acts as the App's bot account, which cannot sign in on the web, so Open-Inspect admits
it only if that account is already known to the workspace or unsafe allow-all is in effect (see
[Bot enrollment](../AUTH.md#bot-enrollment)). Pull requests that an automation run's own prompt
opens are authored by the App (see [Commit Signing](#commit-signing)), so auto-review skips them by
default, and any review the bot submits on them can only comment.

---

## AI Review Check

With the `mergeGate` setting on, the App posts a check run named `AI Review` on each pull request's
head commit. It passes when the platform's reviewers approve exactly that commit. The setting is
`"off"` (the default), `"shadow"` or `"required"`, set through the integration settings API,
globally or per repository.

| Event                                       | What the check does                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| PR opened, or marked ready for review       | A review starts and the check is in progress.                                                                |
| Every reviewer session has finished         | Success if all approve; otherwise not approved, or unfinished if a session failed or gave no verdict.        |
| New commits                                 | No review runs. The check asks for one: "Re-run the AI review before merging", with a **Review now** button. |
| Base-branch update, PR's own diff unchanged | The last verdict carries forward to the new head.                                                            |
| Base branch changed, or PR reopened         | The verdict is dropped and the check asks for a review.                                                      |
| **Re-run**, **Re-run all**, **Review now**  | Reviews the head commit for whoever clicked, if they may trigger the bot. Draft PRs are skipped.             |

In `shadow` mode a missing or unfavourable verdict concludes `neutral`, which never blocks a merge.
In `required` mode it concludes `failure`, or `action_required` when no review covers the head, so
the check can be made a required status check.

### How a verdict is reached

The GitHub bot decides who may ask for a review. Everything after that happens in the control plane:

- **One attempt per head.** A review is an attempt: one session per configured reviewer, for one
  head commit of one pull request. Starting one is a single database write that refuses a second
  attempt on the same head, so repeated clicks and repeated deliveries start one review. A review of
  a newer head, an override of the same commit, a base change or a reopening replaces a running
  attempt, which can then decide nothing.
- **Reviewer sessions nobody can steer.** Each session is held by the platform: it is private, has
  no owner and no team, and is not listed. Nobody, the pull request's author included, can read its
  prompt or events, send it a message, use its sandbox, add collaborators or change its visibility.
  A workspace Owner can read it, and that read is audited.
- **The verdict comes from the session, not from GitHub.** A reviewer still submits its GitHub
  review for people to read, and ends its last message with a small JSON verdict (`approve` or
  `request_changes`, with a one-line summary). The verdict must carry a value the control plane put
  in that session's prompt and nowhere else, so a verdict block the session merely quotes, from the
  pull request for example, is not its verdict. When the session finishes, the control plane reads
  the text the turn ended with from the session's own events; a turn that ended on tool activity has
  no verdict. Review bodies on GitHub are never parsed: editing, dismissing or copying a review
  changes nothing about the check.
- **All reviewers must approve.** The attempt concludes when every session has finished. A session
  that fails, runs past 90 minutes, or ends without a well-formed verdict makes the attempt
  unfinished: `failure` when required, `neutral` in shadow, with **Re-run** to try again.
- **An approval passes only the pull request that was reviewed.** Whenever the check is written, the
  pull request must still have the reviewed head and base branch. If the base branch moved on, the
  diff must hash the same as the one reviewed. And the pull request must be the only open one on
  that head commit: a check run belongs to a commit, so a pass would show on every pull request that
  shares it. If GitHub cannot confirm any of this, the check asks for a review instead of passing.

### One check run per head, written from the database

Each head commit of a pull request has one `AI Review` check run, and every state the head goes
through is written to that run: a re-run sets it back to in progress, and a verdict, a carried
verdict, an override or a request for a review each update it. A second run is created on a head
only when GitHub will not take a change to the first (the run is gone, or the update is refused);
the new run then becomes the head's run.

No event writes a check directly. A review starting, a session's verdict, an override, a new head, a
base change, a reopening and the 90-minute limit each record a fact in the database first. A single
reconciler then reads what the database says about the head, works out the one state that implies,
and writes it:

- What a head's check rests on is one thing at a time: a review of that commit, a verdict carried
  from an earlier review, an override, or nothing (with the reason it needs a review). A newer fact
  replaces the older one in the same database write, so the order in which events arrive cannot
  leave two answers standing.
- A base change or a reopening is recorded before GitHub is asked anything. Whatever was reviewed or
  still running before it can no longer pass, whether or not the check could be updated.
- One reconciler at a time writes a head, under a short lease in the database, and it re-reads the
  facts after writing: a fact that arrived meanwhile is written next. Writing the same state twice
  is skipped.
- If GitHub cannot be read or written, the facts are kept and the head is marked as behind. A pass
  that runs every minute writes it once GitHub is back. After three hours it stops trying; the
  head's next event (a re-run, a push, an override) writes the check again.

### Carry-forward

A new head keeps the last review verdict when the pull request's diff against the same base branch
is the one that was reviewed: same files, same hunks and context, same binary files and file modes.
Only the positions of hunks and the blob ids of text files are ignored, since a base-branch update
moves them. A diff in which one file has two hunks that read the same is never carried forward,
because without positions they cannot be told apart.

This is deliberate: "Update branch", or any push that leaves the pull request's own changes as they
were reviewed, reuses the approval instead of costing a new review. The reviewers approved those
changes; they did not review what arrived from the base branch, which was reviewed in its own pull
requests.

### Override

Someone with write access who is not the pull request's author can pass the head's check with a PR
comment on a line of its own that names the head commit (seven or more characters) and gives a
reason. Both are recorded on the check:

```text
@my-app override 3f9c2ab reviewer misread the migration; verified by hand
```

The override applies only if the commit it names is still the head; otherwise the bot replies with
the current head. A comment that mentions the bot and "override" in any other form is an ordinary
request to the bot. An override covers that one commit: it is never carried forward, so the next
push asks for a review again. A new review of the same commit replaces the override.

### Permissions

The check needs the App permission **Checks: Read and write**. GitHub sends an App with that
permission the **Check run** and **Check suite** events for its own checks, including **Re-run** and
**Review now**, without a separate event subscription.

Check runs are written by the control plane, with a token minted for that purpose alone: it can
write checks and read pull requests on the one repository, and nothing else. Tokens issued to
sandboxes and sessions are limited to reading checks and commit statuses, so no session, a reviewer
session included, can post or change a merge-gate result.

### What the check does not prove

The reviewers are AI models reading code that the pull request's author wrote. Text in the pull
request can try to talk a reviewer into approving, and no AI gate can rule that out. The check shows
that the platform's reviewers, unsteered by any person, reported "approve" for exactly this diff. It
is one signal next to the required human approval, not a replacement for it.

### Rollout

- **Required mode needs "Require branches to be up to date before merging" on the target branch.**
  The check is tied to the head commit. When the target branch advances and the head does not,
  GitHub sends no event for the pull request and the check on its head stays as it was; it is the
  up-to-date rule that forces the head to be updated, which the gate then sees as a new head.
  Without that rule, a pull request could merge on a pass reached against an older target.
- Before switching a repository from `shadow` to `required`, re-run the check on its open pull
  requests. A check concluded in shadow mode is `neutral`, which GitHub accepts for a required
  check; it only becomes `failure` or `action_required` when it is concluded again.
- Reviewer sessions review the pull request's repository alone; a default environment with further
  repositories is not used for them.
- The earlier `reviewOnApproval` setting is gone. Stored settings that still hold it are read as if
  it were absent, for one release; migration `0098` removes it. Before rolling back to a version
  without `mergeGate`, remove `mergeGate` from the stored GitHub settings: that version rejects
  settings it does not know.

---

## `@Mention` Actions

### PR Conversation Comments

Mention the GitHub App bot in a PR conversation comment to ask for analysis, a follow-up answer, or
a GitHub reply:

```text
@my-app[bot] can you explain why this retry path is failing?
```

Open-Inspect strips the bot mention before sending the request to the agent. The rest of the comment
becomes the prompt.

### Model and Reasoning Overrides

Start the request with `!model` or `!reasoning` to override the configured model or reasoning effort
for the session that comment starts:

```text
@my-app[bot] !model openai/gpt-5.6-sol !reasoning high investigate the flaky test
```

The flags use the same syntax as Slack: each accepts a space or colon before its value (such as
`!model:anthropic/claude-sonnet-4-6` or `!reasoning:max`), and any flags must appear together at the
start of the request, right after the bot mention. Flags later in the comment are treated as part of
the request. Models must be enabled under **Settings > Models**, and the reasoning value must be
supported by the selected model. A model flag without `!reasoning` keeps the configured reasoning
effort when the new model supports it, and otherwise uses the model's default.

If a flag is invalid, the bot replies with a PR comment explaining why and does not start a session.
Flags work in PR conversation comments and inline review threads. Auto-reviews and review requests
always use the configured model.

If the configured **Agent harness** cannot run the resolved model, the bot replies on the PR and
creates no session; it does not switch to OpenCode. Retry a mention with a compatible `!model`,
update the default model, or change the GitHub integration harness.

### Inline Review Threads

When you mention the bot in a PR review thread, Open-Inspect includes the file path and diff context
from that thread. The agent can reply directly to the review thread and can also post a summary
comment on the PR.

### Current Branch Behavior

Comment-triggered sessions currently start from the repository default branch, not the PR head
branch. Use them for responses and review-thread discussion rather than asking the agent to push
commits to the existing PR branch.

Each accepted GitHub webhook starts a new Open-Inspect session. GitHub comments do not continue an
existing session the way Slack thread replies do. The agent still reads the current PR conversation
when it needs context.

Comment-triggered actions only run on pull requests. Mentions on ordinary GitHub issues are ignored.
Comments from the bot itself are also ignored so the bot does not respond to its own output.

### Team Routing for Mentions

Before creating a mention session, the bot asks the control plane for ownership using the numeric
GitHub repository ID and PR number. Routing follows this order:

1. If the PR is linked to an existing Open-Inspect session, use that session's owning team (or
   workspace ownership). This is only a routing hint: it neither resumes nor grants access to that
   session, including a private one.
2. Otherwise, resolve the sender's linked GitHub identity and current teams with a repository or
   installation grant covering the triggering repository. Exactly one eligible team wins.
3. If multiple teams qualify, use the sender's most recent session on that repository in a still
   eligible team. If none resolves the ambiguity, use workspace ownership. Missing identity or no
   eligible team also falls back to workspace ownership.

A route lookup failure stops the request rather than guessing workspace ownership. GitHub trigger
gates still run, and session creation separately checks membership, team state, and repository
grants. A configured default environment is used only when ownership is compatible, it includes the
trigger repository, and the sender passes its repository checks; otherwise the target falls back to
the triggering repository. Workspace fallback can still be refused if the workspace requires team
ownership for new sessions.

The runtime default for `TEAMS_ENFORCEMENT` remains `shadow`, not `on`; routing a session to a team
does not imply full team-read isolation in that mode.

---

## What You See

### Acknowledgment

When a GitHub request is accepted, the bot adds an eyes reaction. That reaction is best-effort; if
GitHub rejects the reaction, the session can still start.

### GitHub Output

For auto-review workflows, the agent posts the review result back to the PR. Depending on what it
finds, that may be a general review comment, an approval, a request for changes, or inline review
comments.

For `@mention` workflows, the agent posts a PR comment summarizing its response or answering the
question. If the request came from an inline review thread, the agent may also reply in that thread.

GitHub does not receive the same managed completion message that Slack receives. After the initial
eyes reaction, GitHub-facing output is written by the agent from inside the session. Use the
Open-Inspect web app to watch live progress, inspect logs, or see artifacts.

---

## Settings

Open the web app and go to **Settings > Integrations > GitHub** to configure the GitHub Bot.

### Defaults and Scope

| Setting                  | What it controls                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------- |
| Default model            | Model used for GitHub-started sessions when a repository does not override it         |
| Default reasoning effort | Reasoning depth used with the selected default model                                  |
| Agent harness            | Harness that runs GitHub-started sessions (OpenCode default, or Claude Agent)         |
| Auto-review new PRs      | Whether new non-draft PRs should be reviewed automatically                            |
| Repository Scope         | Whether the bot responds in all accessible repositories or only selected repositories |
| Allowed Trigger Users    | Who can trigger the bot from GitHub                                                   |

If no GitHub Bot settings are configured, Open-Inspect uses permissive defaults: all repositories
available to the GitHub App are in scope, auto-review is enabled, and users with write, maintain, or
admin access to the repository can trigger the bot.

If repository scope is set to **Selected repositories** and no repositories are selected, direct
GitHub Bot workflows are disabled. If **Only specific users** is selected and the user list is
empty, no one can trigger direct bot workflows for that scope.

These settings do not gate GitHub event automations. Automations are matched separately by their
repository, event type, enabled state, and trigger conditions. A pull request that an automation
run's own prompt opens is authored by the GitHub App, so its PR Opened event carries the App bot
login (for example `my-app[bot]`) as actor, not the automation's executor; an **Actor** condition
that names the executor no longer matches that event.

Event automations match the numeric GitHub repository ID, not just `owner/name`, and retain the
automation's saved owning team rather than using the mention sender's team. A team-owned automation
needs a current grant covering that repository at admission and launch. Losing the grant prevents a
run; restoring it allows a later event to run, not a replay of previously skipped events. Repository
renames retain identity through the numeric ID, while run targets use the event's current owner and
name. These checks are independent of the deprecated workspace auto-review setting.

### Upgrading to Repository-ID Routing

Upgrade the GitHub bot and control plane together. The control plane rejects event envelopes without
a numeric repository ID, so an older bot's events are not routed. Automations saved before
repository IDs were recorded no longer match events by name; open each one, reselect its
repositories, and save to resolve their IDs.

### Models and Instructions

| Setting                     | What it controls                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------- |
| Model and reasoning effort  | Model and reasoning depth for GitHub-started sessions, when configured             |
| Agent harness               | Harness for GitHub-started sessions; incompatible models are refused               |
| Code Review Instructions    | Extra guidance appended to PR review prompts                                       |
| Comment Action Instructions | Extra guidance appended to `@mention` action prompts                               |
| Repository Overrides        | Per-repository overrides for model, harness, reasoning, instructions, and behavior |

Repository overrides take priority over global defaults for the repository they apply to. Omitted
harness and model fields inherit individually from the global settings. If neither level sets a
harness, it is OpenCode; if neither sets a model, sessions use the deployment default model. A
[`!model` or `!reasoning` flag](#model-and-reasoning-overrides) at the start of a mention overrides
the corresponding model or effort setting for that one session, not the harness.

Explicitly choosing a restricted harness such as **Claude Agent** requires a compatible default
model at the same settings level (global or repository), not an inherited model. The settings form
and control plane reject a missing model or an incompatible pair at that level. **Use system
default** is not offered when explicitly choosing Claude Agent. Save validation does not check the
merged global/repository pair: a model-only repository override can inherit an incompatible global
harness, in which case the bot refuses the launch.

### Commit Signing

Open-Inspect can sign normal agent-created commits with one deployment-wide OpenSSH Ed25519 key. The
identities remain deliberately separate:

| Git/GitHub role      | Identity                                                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commit author        | The trusted prompting GitHub user, when available; otherwise Open-Inspect                                                                                      |
| Committer and signer | The dedicated Open-Inspect signing account                                                                                                                     |
| Branch pusher        | The existing GitHub App                                                                                                                                        |
| Pull request author  | The GitHub App for an automation run's own prompts (not sessions its agent spawns); otherwise the prompting user's OAuth identity when available, else the App |

This makes the signature an attestation by the Open-Inspect deployment, not a cryptographic claim
that the attributed user personally signed the commit. GitHub repository rules remain the
server-side enforcement boundary for rejecting unsigned commits.

To configure signing, open **Settings > Integrations > GitHub > Commit signing**:

1. Create or recover a dedicated GitHub account for the signing identity. It does not need
   repository access because the GitHub App continues to push branches.
2. Generate an unencrypted OpenSSH Ed25519 key and add its public key to that account as a **signing
   key**.
3. Enter the fixed committer name/email and private key in the write-only form. The committer email
   must belong to the dedicated account.
4. Save, then exercise a normal commit and a history rewrite in a non-critical repository before
   requiring signed commits.

The private key is encrypted in the control-plane database. The settings page reads back only the
derived public key, fingerprint, fixed identity, and last update time; it never repopulates the
private-key field. Sandboxes receive only the public key. For each commit, a stateless Git signer
derives its fingerprint from that public key and sends the bounded unsigned commit buffer to the
authenticated control-plane signing endpoint. The control plane decrypts the active key in
request-local memory and returns a complete `git`-namespace SSH signature. The private key is never
delivered to a sandbox file, environment, process, or provider snapshot.

The unsigned commit buffer contains Git headers, author/committer identities, and the commit
message. It does not contain file contents or diffs. Open-Inspect does not interpret, retain, or log
the buffer and does not maintain a signature ledger.

For rotation, register the replacement public key on GitHub before replacing the private key in
Open-Inspect, then remove the old public key after existing signing requests drain. A request that
already resolved the old key may complete; later requests for that fingerprint fail and retry after
the next prompt refresh with the new public key. Disabling deletes the active database ciphertext.
Requests that resolve configuration afterward fail closed, and running sandboxes remove Git signing
configuration on their next prompt refresh.

Important limitations:

- GitHub vigilant mode shows attributed commits as **Partially verified** because the author and
  committer are intentionally different.
- GitHub-created merge or squash commits follow the repository's merge-signing behavior; the
  signature on the branch commit does not automatically carry onto a newly created merge commit.
- Commit creation and history rewrites require the control plane to be available. Rewriting multiple
  commits performs one signing round trip per recreated commit, with no unsigned fallback.
- Any process in a live sandbox that can use its session token can ask the control plane to sign an
  arbitrary bounded commit buffer. Remote signing prevents reusable-key extraction; it does not make
  the sandbox trustworthy or add commit-policy enforcement.
- Sessions already running when signing support is deployed must be recreated so they start the
  updated shared runtime. Provider images and snapshots do not need a preinstalled signer wrapper;
  the checked-in launcher is installed with the runtime's other standalone commands during startup.

---

## Admin and Safety Notes

### Access Boundaries

- Repository access is deployment-scoped through the configured GitHub App installation. To restrict
  what Open-Inspect can access, install the GitHub App only on intended repositories and use
  **Repository Scope** for an additional bot-level filter.
- The same GitHub App is used for OAuth and repository access. GitHub App credentials and webhook
  secrets stay server-side.
- By default, trigger access is checked against GitHub repository permission and requires write,
  maintain, or admin access. If you configure **Only specific users**, that list becomes the trigger
  gate for the configured scope.

### Bot Behavior

- Auto-review skips draft PRs. An explicitly allowed App bot can trigger a comment-only self-review.
  Manual `@mention` triggers still pass the repository and user gates, then team routing and
  creation checks.
- The bot ignores bot-authored comments, ordinary issue comments, and comments that do not mention
  the bot.
- If the bot cannot load its GitHub integration settings, it fails closed and does not start direct
  bot sessions.
- Review and `@mention` sessions never include personal memories; the control plane decides this
  from the calling service. An Autofix turn is not the session owner's prompt, so the agent cannot
  read or save the owner's personal memories during it, and the session stops searching them
  afterwards.

### Prompt Safety

- Initial prompts mark selected GitHub fields as untrusted. Code-review prompts wrap PR title,
  author, branches, and description; comment-triggered prompts wrap the triggering comment.
- Review-thread file and diff context, plus GitHub context later read by the agent, are not
  separately transformed by the bot.
- Webhooks are verified before Open-Inspect acts on them. Duplicate webhook deliveries are
  deduplicated so GitHub retries do not normally create duplicate direct bot sessions.

---

## Troubleshooting

### The bot does not respond to a PR

Check that the GitHub App is installed on the repository and that the GitHub Bot worker is enabled.
Then confirm the webhook URL, webhook secret, subscribed events, and `github_bot_username` in
[Complete GitHub Bot Setup](../GETTING_STARTED.md#github-bot-optional).

Also check **Settings > Integrations > GitHub**. For direct GitHub Bot workflows, the repository may
be outside the selected repository scope, or the triggering user may be outside the allowed user
list.

### Auto-review did not run

The deprecated workspace auto-review only runs for newly opened, non-draft PRs. It is skipped for
draft PRs, disabled repositories, and users who are not allowed to trigger the bot. An App-authored
PR needs the App bot login explicitly allowed, and its bot account must already be known to
Open-Inspect unless unsafe allow-all is in effect; its self-review can only comment.

If a PR was converted from draft to ready for review, mention the bot in a PR comment instead.

### A mention did not start a session

Mentions must be in a pull request conversation comment or PR review thread. Mentions on ordinary
GitHub issues are ignored. Use the App's handle, with or without `[bot]`: `@my-app` and
`@my-app[bot]` both work. GitHub does not autocomplete Apps, so type the handle in full.

### I see an eyes reaction but no follow-up

The eyes reaction acknowledges the request; it is posted before Open-Inspect admits the request and
creates a session. GitHub completion output is posted by the agent, not by a managed bot callback.
The session may still be running, or the agent may have failed after it started. Open the
Open-Inspect web app to inspect the session.

If no session exists, check that the person who triggered the bot (the commenter, review requester,
or PR opener) is already known to Open-Inspect. The bot cannot create an account from a GitHub
profile, so unless unsafe allow-all is in effect, the control plane refuses requests from someone
who has never signed in on the web with GitHub; the refusal is logged and nothing is posted to the
PR. Sign in once on the web, then mention the bot again. See
[Bot enrollment](../AUTH.md#bot-enrollment).

### The wrong model or instructions were used

Check **Settings > Integrations > GitHub**. Repository overrides take priority over global defaults.
Changes apply to new GitHub-triggered sessions. A `!model` or `!reasoning` flag at the start of the
mention overrides both for that session.

### The bot is active in too many repositories

Limit the GitHub App installation to the repositories Open-Inspect should access. You can also set
**Repository Scope** to **Selected repositories** in the GitHub integration settings.
