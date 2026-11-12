# Plan: cloud-first personal agents, a VM per user

## Context

An open-source alternative to Grok Bot, Duet, Dots and Muse, offered both self-hosted and as a managed service.

- Each user gets one cloud computer (an EC2 instance) shared by all their bots.
- Bots run long tasks, browse and click, run user-defined schedules, and are reachable from web, Slack, Discord and later an app.
- The managed default model is `glm5.3` on [Sarvam Token Factory](https://docs.sarvam.ai/api/token-factory) (OpenAI-compatible, `https://api.sarvam.ai/v2`). The user never handles an API key. Users who want to can bring their own key, and later their own subscription.
- Tools connect through [Composio](https://docs.composio.dev/docs/authentication) OAuth, and keys never sit on the VM.
- A non-technical user signs up in one click and it works.

### Decisions already made

- **Engine protocol: ACP**, so no vendor lock-in. **Default engine: OpenCode.** ACP's own methods are the interface (`session/prompt`, `session/update`, `session/cancel`, `session/load`, `session/request_permission`). A second method set would only rename them.
- **Managed default model: `glm5.3`, served by Sarvam.** Other providers can serve GLM too. Sarvam is the one this service calls. The engine stays OpenCode when the model changes.
- **Cloud: AWS** (credits), one EC2 instance per user, stopped when idle.
- **Scheduler lives in our daemon**, not in any engine, so swapping an engine never loses schedules.
- **Control plane database and login: Supabase** (Postgres, Google sign-in, and row-level security). Tables the browser reads directly (bots, thread index, schedules, usage shown to the user) get row-level security policies. Server-only tables (VM records, usage ledger, stored keys) have row-level security on with no policies, so only our backend can touch them. Our backend services (relay, LLM proxy, broker, provisioner) use the service key, which bypasses row-level security, so they check access in code. Migrations are plain SQL files, and policy tests prove one user can't read another's rows. Trade-off accepted: moving off Supabase later costs more, and self-hosting means running Supabase's open-source stack.
- **Web app:** Next.js with Tailwind and shadcn/ui; chat built from AI Elements-style components rendering our own event stream. No code carries over from any earlier project. Supabase is set up in Task 4.0, because nothing before the cloud phase needs accounts.
- **Web conversation.** One bot is one long conversation. The UI has no thread list and no search. Creating a bot asks for a name and a picture, and there is no description field. Tool calls and file changes stay out of the thread. The computer screen comes later.
- Defaults I assumed (change any time): TypeScript throughout, the web app and API hosted on AWS to use credits (any host would work, since only the relay needs long-lived connections), a Node daemon on the VM, Graviton (ARM) instances for lower cost (Task 4.2 confirms every tool we ship has an ARM build, otherwise we switch to x86), infrastructure as code for all AWS resources.

### What a harness is, and what it isn't

A **harness** runs one agent turn: the model-and-tool loop, tool execution and permission prompts, context assembly and compaction, session history with resume and cancel, and streamed events. **Not** part of a harness: schedules, channels, multi-user auth, metering, notifications, VM lifecycle. Those are the product we build around it.

### ACP in one page

The [Agent Client Protocol](https://agentclientprotocol.com/protocol/overview) ([spec repo](https://github.com/agentclientprotocol/agent-client-protocol), Apache-2.0) is an open JSON-RPC 2.0 protocol between a **client** (what editors like Zed are today) and an **agent** (a coding agent run as a subprocess, talking over stdio). In our system the **daemon is the client** and OpenCode is the agent.

1. `initialize`: both sides announce their capabilities (for example whether the agent can reload old sessions).
2. `session/new` (or `session/load` to resume): choose a working directory and hand the agent tool servers (MCP).
3. `session/prompt`: send a user message. The agent streams `session/update` notifications back (text chunks, tool calls and their results, plans).
4. When the agent wants to do something sensitive it calls `session/request_permission`. The client answers allow or reject. **This is our approval card and our push notification.**
5. The turn ends when `session/prompt` returns a stop reason. `session/cancel` interrupts a turn.

Why it helps us: one adapter in the daemon speaks to every ACP engine, including OpenCode, the [Claude](https://github.com/agentclientprotocol/claude-agent-acp) and [Codex](https://github.com/agentclientprotocol/codex-acp) adapters, and others listed in the [ACP registry](https://github.com/agentclientprotocol/registry). There is an official [TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) (`@agentclientprotocol/sdk`). OpenCode runs as `opencode acp` ([docs](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/acp.mdx)). OpenMausBot is a working example of the same approach (it drives many engines through ACP).

Limits to keep in mind: each agent decides _when_ to ask permission and which optional features it supports, so "swappable" means "swappable with possibly different guarantees". Tasks 1.1 to 1.5 check this for OpenCode specifically.

## Architecture

```
Clients: web (PWA), Slack, Discord, app later
        │
Control plane (web app + API + Postgres): auth, bots, threads, usage plans,
   push notifications, VM lifecycle, credential broker (Composio), LLM proxy
        │
Relay: always-on websocket service (small container on ECS Fargate behind a load balancer,
   in the control-plane AWS account); each VM dials OUT to it (no inbound ports)
   + EventBridge Scheduler → EC2 start (wake only)
        │
User's EC2 VM (hardened image):
   daemon (ACP client): bot + thread store (SQLite), scheduler, approval broker,
                        CLI tools for the agent (schedule, web search)
   desktop: virtual display + window manager, headed Chrome, browser and desktop
            CLIs the agent calls from its shell; live-view stream added later
   /bots/<id>/  (files, memory)   +   /shared
   engine: OpenCode over ACP → our LLM proxy (Sarvam / user key)
```

**Trust boundary.** Every bot shares the user's logins, so the VM is the security boundary and bots are not (the same stance as Grok Bot). Bots get separate folders, not separate OS users.

**Key custody and metering.**

- Sarvam and Composio keys live only in the control plane.
- The VM gets a short-lived token for the LLM proxy. The proxy counts tokens per user per week and returns 429 at the limit. Sarvam's docs show no per-key budgets or usage API, so the metering is ours.
- Composio calls go through our broker with the user ID fixed ([users and sessions](https://docs.composio.dev/tool-router/users-and-sessions)), because a project key could otherwise act for any user.
- Users on their own subscription bypass the proxy; only VM time is metered for them.

**VM safety baseline.** No instance role, IMDSv2 required ([docs](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-options.html)), no inbound ports, user VMs in a separate AWS account from the control plane.

**Schedules.** Jobs live in the daemon's SQLite with [croner](https://github.com/Hexagon/croner) for timing. Each firing sends the prompt into the bot's thread. Schedules are never edited by hand in the UI. The user views them and turns them on or off there; creating and changing them happens in chat, where the bot runs a `schedule` CLI (Task 2.6) to update its own jobs. A raw crontab entry is not used because we need catch-up, run receipts and thread routing. Design references: Hermes's [cron internals](https://github.com/NousResearch/hermes-agent/blob/HEAD/cron/AGENTS.md) (catch-up windows, at-most-once dispatch) and OpenMausBot's [routine docs](https://github.com/milind-soni/OpenMausBot/blob/HEAD/docs/routine-schedules.md). A stopped VM can't fire jobs, so the control plane creates a one-time [EventBridge Scheduler](https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-targets-universal.html) entry that starts the instance a minute early.

## Requirements map

| #        | Requirement                                            | Where it lands                      |
| -------- | ------------------------------------------------------ | ----------------------------------- |
| 1        | Multiple bots, one computer                            | Phase 2                             |
| 2        | See what the agent computer is doing                   | Task 7.1                            |
| 3        | Long-running tasks                                     | Task 2.7                            |
| 4        | Connect tools by asking                                | Phase 6                             |
| 5        | User-defined schedules (edited via chat only)          | Tasks 2.3 to 2.6, 3.4, 4.6          |
| 6, 9, 15 | Bring your own engine/key/subscription; Sarvam default | Tasks 1.3, 5.1, 5.5, 9.3            |
| 7, 8, 17 | Cloud first on AWS; local optional                     | Phase 4; Task 9.4                   |
| 10       | Many channels, same bot                                | thread model in 0.3; Tasks 9.1, 9.2 |
| 11       | Key security                                           | Tasks 4.2, 5.1, 6.1                 |
| 12       | Web search, browser and desktop control                | Tasks 2.8 to 2.10; Phase 7          |
| 13       | Notifications                                          | Task 8.1                            |
| 14       | Voice via Sarvam                                       | Task 9.5                            |
| 16       | Usage limits, weekly resets                            | Phase 5                             |

## How we work

- **One task at a time.** Each task is small enough for one pull request. It ends with a "done when" check that runs, and I don't start the next task until that check passes.
- **Every task leaves a short explainer** (a page under `docs/`) saying what was built and why, and I walk you through it before we move on, so you understand each piece.
- Each task adds its own tests. A bug found later gets a regression test first, then the fix.

## Phase 0: foundations (no cloud)

- **0.1 Repo and tooling.** Monorepo (web app, daemon, shared types), lint, typecheck, test runner, CI. [381d6113ceded56b93d6a3ab098cad5d38e3c1cb](https://github.com/mittal-parth/companion/commit/381d6113ceded56b93d6a3ab098cad5d38e3c1cb). _Done when:_ CI is green on a trivial test.
- **0.2 Web app skeleton.** Next.js app (App Router) with Tailwind and shadcn/ui, and a health route. No accounts yet: Phases 1 to 3 run against a local daemon for one user. No web container in this phase: nothing deploys the Next app yet, and the relay container in task 4.3 is a different service. [381d6113ceded56b93d6a3ab098cad5d38e3c1cb](https://github.com/mittal-parth/companion/commit/381d6113ceded56b93d6a3ab098cad5d38e3c1cb). _Done when:_ the app builds in CI, the smoke test starts it directly, and `/` and `/api/health` return 200.
- **0.3 Shared vocabulary.** Deferred to Phase 1. The words live in `GLOSSARY.md`, and the thread/channel split is recorded in `docs/adr/0001-thread-per-channel.md`. Schemas for bot, thread, message, and session update are copied from a recorded OpenCode session when a task first stores one, so this phase does not invent a schema that session would replace. [381d6113ceded56b93d6a3ab098cad5d38e3c1cb](https://github.com/mittal-parth/companion/commit/381d6113ceded56b93d6a3ab098cad5d38e3c1cb).

## Phase 1: the engine on your laptop (learn ACP and OpenCode, no cloud)

- **1.1 ACP hello.** A script using the TypeScript SDK that starts `opencode acp`, runs `initialize`, `session/new`, `session/prompt` and prints the streamed updates. [3a62ff5f50afe0b7db9f2e8eb950e6581f6817b0](https://github.com/mittal-parth/companion/commit/3a62ff5f50afe0b7db9f2e8eb950e6581f6817b0). _Done when:_ it prints a real reply and a tool call, and a recorded session is saved as a test fixture.
- **1.2 Engine interface.** Dropped. ACP is already the interface, and task 1.1 recorded OpenCode's `session/update` shape. A fake agent, when a later test needs one, can speak ACP in-process through the SDK. [751cfa154f179bf1d60e435aa886a41d1a5faad9](https://github.com/mittal-parth/companion/commit/751cfa154f179bf1d60e435aa886a41d1a5faad9).
- **1.3 Sarvam through OpenCode.** Point OpenCode at Sarvam for one turn on `glm5.3`. The provider config is written into that run's temp workspace, and the key is read from `SARVAM_API_KEY`. [751cfa154f179bf1d60e435aa886a41d1a5faad9](https://github.com/mittal-parth/companion/commit/751cfa154f179bf1d60e435aa886a41d1a5faad9). _Done when:_ the turn includes a completed tool call. The new session fields from that run (`agent_thought_chunk`, the effort option, `thoughtTokens`) are folded into the hello fixture. No separate script is kept.
- **1.4 Approvals.** Map `session/request_permission` to an approval the user allows or denies. The engine waits until that answer. A denial fails the tool call. [751cfa154f179bf1d60e435aa886a41d1a5faad9](https://github.com/mittal-parth/companion/commit/751cfa154f179bf1d60e435aa886a41d1a5faad9). _Done when:_ a test shows the tool stays blocked until answered, and a denial fails it. OpenCode's real question and the failed update are in the hello fixture.
- **1.5 Cancel and resume.** `session/cancel` stops a turn. `session/load` continues that session after the engine process is replaced. [751cfa154f179bf1d60e435aa886a41d1a5faad9](https://github.com/mittal-parth/companion/commit/751cfa154f179bf1d60e435aa886a41d1a5faad9). _Done when:_ a test shows cancel stops a waiting turn, and a new connection loads the same session and prompts again. OpenCode did both: cancel stops with `cancelled`, and load then accepts another prompt.
- **1.6 Thread store.** The daemon's SQLite lists each thread, keeps the session updates that form its transcript, and records the engine, session id, and working directory a restart uses to `session/load`. A bot's engine is the default for new threads. A thread keeps the engine it started with. OpenCode's own database stays the engine's session memory. [#1](https://github.com/mittal-parth/companion/pull/1). _Done when:_ restarting the daemon restores a thread exactly.

## Phase 2: the daemon, bots, schedules and computer use (still local)

- **2.1 Daemon API.** Local API to create a bot and thread, send a message and stream events. [#2](https://github.com/mittal-parth/companion/pull/2). The turn runs on Sarvam `glm5.3`. [#3](https://github.com/mittal-parth/companion/pull/3). `docs/phase-2-1.md` explains how a message reaches OpenCode. [#4](https://github.com/mittal-parth/companion/pull/4). _Done when:_ an integration test drives a full turn through it.
- **2.2 Multiple bots.** A folder per bot, per-bot instructions and memory file, several bots at once. [#6](https://github.com/mittal-parth/companion/pull/6). _Done when:_ two bots keep separate files and context (tested).
- **2.3 Schedule maths.** Job model, cron with timezone, next-run computation, as pure functions. [#7](https://github.com/mittal-parth/companion/pull/7). _Done when:_ unit tests pass, including daylight-saving changes and invalid input.
- **2.4 Scheduler runtime.** Arm the next occurrence, fire it by sending its prompt into the bot's thread, record a receipt when the turn comes back, never fire twice for one occurrence. [#9](https://github.com/mittal-parth/companion/pull/9). _Done when:_ a live-clock test shows exactly-once firing, and a restart does not fire that occurrence again.
- **2.5 Catch-up.** After downtime, run a missed occurrence once if it is within a window, otherwise skip and record it. [#10](https://github.com/mittal-parth/companion/pull/10). _Done when:_ fake-clock tests cover restart, long outage and paused jobs.
- **2.6 Agent-managed schedules (CLI).** A `schedule` CLI, built by us and shipped with the daemon, with `create`, `list`, `pause`, `resume` and `delete`. It talks to the daemon's local API, and the daemon fills in which bot and thread called it, so the agent can't touch another bot's jobs. The bot learns about it from its instructions file, and the permission rules allow it without a prompt. We use a CLI rather than an MCP tool server because it needs no tool-server pass-through from the engine, costs no tool-schema tokens per turn, and is easy to test by hand. The same daemon API backs the UI's enable/disable switch (Task 3.4). [#11](https://github.com/mittal-parth/companion/pull/11). _Done when:_ saying "every day at 9, do X" makes the bot run the CLI and the job exists, and the CLI's own tests cover bad input and cross-bot access.
- **2.7 Long tasks and reconnect.** A turn keeps running with no client connected, and a client that reconnects replays missed events. [#13](https://github.com/mittal-parth/companion/pull/13). _Done when:_ a multi-minute turn survives a client disconnect (tested).
- **2.8 Web search.** The bot can search the web and read results without a UI. OpenCode's built-in web search is what the daemon uses. [#12](https://github.com/mittal-parth/companion/pull/12). A paid provider would be a `web-search` CLI, called the same way as the schedule CLI, so the provider is swappable. Candidates, all priced per 1,000 searches as of today: [Parallel](https://docs.parallel.ai) ($1 to $5), [Brave](https://brave.com/search/api/) ($5, own index), [Exa](https://exa.ai) ($4 to $7, semantic), [Tavily](https://www.tavily.com) (about $8, search plus extract). Locally the key comes from an environment variable. In the cloud the call goes through the control plane so no key sits on the VM, the same pattern as Task 5.1. Reading a full page is done by the browser (Task 2.9). _Done when:_ the bot answers a question that needs current information and cites the pages, and the provider choice is recorded in an ADR after trying two on the same five queries.
- **2.9a Browser.** The VM runs one headed Chrome with one persistent profile on a virtual display (Xvfb and Openbox). Every bot drives its own window of it through a `browser` command that wraps [agent-browser](https://github.com/vercel-labs/agent-browser), so logins are shared and bots working at once do not touch each other's pages. Raw Chrome and the underlying CLIs are denied. agent-browser was chosen over [Playwright CLI](https://playwright.dev/agent-cli/introduction) by running three tasks on both (ADR 0002). [#15](https://github.com/mittal-parth/companion/pull/15). _Done when:_ a bot completes a multi-step task on a local site (open a result, fill a form, recover from a validation error), two bots do so at the same time, and a login survives a restart. See `docs/phase-2-9.md`.
- **2.9b Desktop.** A bot drives an application that is not a web page through a `desktop` command that wraps [agent-desktop](https://github.com/vercel-labs/agent-desktop), on the same virtual display as Chrome. One lock covers the whole desktop, and every action stays on a window that bot opened. The bot may launch `mousepad` and `galculator`, and it can read and write the shared clipboard. A screenshot is read by the vision subagent from Task 2.10. agent-desktop was chosen over `xdotool` plus screenshots by running two tasks on both (ADR 0003). [#18](https://github.com/mittal-parth/companion/pull/18). _Done when:_ a bot completes one task in a non-browser app, and two bots using the desktop at once do not collide. See `docs/phase-2-9.md`.
- **2.10 Image input.** `glm5.3` is text-only, so a pasted image never goes to it. The daemon saves the file in the bot's folder and a read-only subagent on `glm5.3-flash` answers the parent's question about it. A model that can already read images, such as Claude or Codex later, does not get that subagent. Pages are still driven from accessibility snapshots (Task 2.9); the subagent is for pixels. [#14](https://github.com/mittal-parth/companion/pull/14). _Done when:_ a live turn quotes a code that exists only in a pasted PNG, and a test shows the parent prompt contains no image bytes.

## Phase 3: web chat against the local daemon

- **3.1 Chat and streaming.** Send a message and stream the reply. The browser talks to Next.js route handlers over server-sent events, and those handlers talk to the daemon. The daemon still sends ACP session updates. One converter turns them into AI SDK messages, which [AI Elements](https://elements.ai-sdk.dev) (conversation, message, prompt input, reasoning) and Streamdown render. An image can go with the text. Reloading while a turn is still running continues that reply instead of starting it over. [#16](https://github.com/mittal-parth/companion/pull/16). The person's messages are dark and sit on the right. The bot's messages are gray and sit on the left. A thought stays beside the bubble. [#23](https://github.com/mittal-parth/companion/pull/23). While a turn is still being written, a status row sits under the bot's latest message: the bot's avatar, three dots, and a short line that rotates. Text that arrives stays in the bubble. Tool calls stay out of the thread, during the turn and after it. [#26](https://github.com/mittal-parth/companion/pull/26). _Done when:_ an end-to-end browser test passes. See `docs/phase-3-1.md`.
- **3.1a Theme.** Light, dark, and the system setting, from a control in the chat header. [#22](https://github.com/mittal-parth/companion/pull/22).
- **3.2 Sidebar.** A sidebar lists every bot. Creating one asks for a name and waits until the opening turn has finished, then shows that greeting. A row can be renamed. [#21](https://github.com/mittal-parth/companion/pull/21). There is no description field. Each bot is one long conversation: the UI has no thread list and no search, and no way to start a second conversation inside a bot. A refresh of the home page opens the first bot. With no bots, the page is the create screen. _Done when:_ two bots show separate transcripts, creating a bot opens its greeting, and a browser test covers the switch.
- **3.2a Edit and delete.** A right-click on a row edits or deletes that bot. Edit renames it in the row: Enter or leaving the field saves, and Escape keeps the old name. Delete asks, then removes the bot and its conversation. The next bot opens, or the one above it when the deleted row was last, and the last bot shows the create screen. [#24](https://github.com/mittal-parth/companion/pull/24). _Done when:_ renaming and deleting behave as above.
- **3.2b Last chat line.** Under each bot name is the latest line of that chat, one row, truncated when it is long. It updates while that chat is open. Other rows keep their own line. There is no timestamp. [#27](https://github.com/mittal-parth/companion/pull/27). _Done when:_ the line under the open bot changes when that chat does, and the other rows stay.
- **3.2c Bot address.** Each bot is reachable at `/bots/<id>`. Opening that address shows that bot, and reloading it stays on that bot. [#32](https://github.com/mittal-parth/companion/pull/32). _Done when:_ a browser test opens two bots by address and a reload keeps the one in the address. See `docs/phase-3-2c.md`.
- **3.3 Bot avatars.** Each bot picks a preset shape and color from [open-bot-avatar](https://github.com/DominikScholz/open-bot-avatar), on create and again from the row. The shapes are mounted live. Generate and upload stay out. The chosen picture shows in the sidebar and the header, including after a reload. [#25](https://github.com/mittal-parth/companion/pull/25). _Done when:_ the chosen avatar shows in the sidebar and the header, and it survives a reload.
- **3.4 Schedules panel.** The open bot's name and avatar sit in the center of the chat header, beside the theme control. Choosing them opens a column on the right, closed by default. The column shows that bot's avatar, name, and schedules. Each row has an enable switch, the next run, and the last receipt. There is no create form, no cron field, and no computer preview. Changing a schedule is done by asking the bot in chat, and the bot updates it through the CLI (Task 2.6). [#28](https://github.com/mittal-parth/companion/pull/28). _Done when:_ a scheduled result appears in that bot's conversation, toggling a schedule stops and resumes it, and the UI has no way to change its time or prompt.
- **3.5 Computer screen.** Tool calls and file changes stay out of the thread, so this phase does not draw steps, command output, or file diffs. Watching the desktop comes later (Task 7.1).
- **3.6 Approval cards.** While a turn is still running, a tool call that needs a decision shows Allow and Deny on that step. The streaming status row stays under the reply. Other tool calls stay out of the thread, while the turn streams and after it finishes. OpenCode's text still shows. After Allow or Deny, that step leaves. Deny stops the tool call, so its result is not shown. Stacked on [#26](https://github.com/mittal-parth/companion/pull/26). [#29](https://github.com/mittal-parth/companion/pull/29). _Done when:_ denying in the UI stops the tool call (tested end to end). See `docs/phase-3-6.md`.

## Phase 4: one VM in the cloud

- **4.0 Accounts.** The first moment we need to know who a user is. Hosted Supabase, Google sign-in through its Next.js server-side session helpers, migrations as SQL files, and a first row-level security policy. _Done when:_ sign in and out work, an unauthenticated request is rejected, and a test proves a second user can't read the first user's row.
- **4.1 AWS foundation.** Separate account for user VMs, network, roles, budget alarms, all as code. _Done when:_ a test budget alarm fires and the stack can be torn down and rebuilt.
- **4.2 Base image.** Hardened machine image with daemon and OpenCode, IMDSv2 required, no instance role, no inbound ports, built by a pipeline. First confirm every tool in the image has a Linux ARM build (OpenCode does; check Chrome, the desktop stack and anything else we add), otherwise build the image for x86. _Done when:_ a launched instance reports ready and a script confirms the safety settings.
- **4.3 Relay.** A small websocket service on [ECS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/Welcome.html) behind an Application Load Balancer, in the control-plane account. Phase 3 reaches a local daemon with server-sent events. The websocket belongs here: the daemon dials out and the web client connects; events and approvals route through, authenticated with short-lived tokens. One instance at first; adding more later needs a shared message bus between instances. It can't be serverless-function hosting, because it holds long-lived connections. We skip API Gateway WebSockets because its connections are capped at 2 hours with a 10-minute idle timeout and 128 KB messages ([quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-execution-service-websocket-limits-table.html)), which suits live-view frames poorly. _Done when:_ the web chat from Phase 3 works against the cloud VM, and a dropped connection reconnects without losing events.
- **4.4 Provisioning.** Create a VM on signup, record it, delete it on request. _Done when:_ a new user gets a working VM without manual steps.
- **4.5 Lifecycle.** Stop when idle (no running turn, nobody watching, no job due soon); start on message with a "waking your computer" state. Measure cold start for plain stop against [hibernation](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/hibernating-prerequisites.html) (which must be enabled at launch) and check memory use with several bots. _Done when:_ an idle VM stops and a message wakes it, with measured times recorded.
- **4.6 Wake for schedules.** EventBridge one-time wake entries kept in sync with the daemon's next-run times. _Done when:_ a stopped VM wakes before a job and the job runs.
- **4.7 Backups.** Disk snapshots and a restore test. _Done when:_ a restored VM has the bot's files and threads.

## Phase 5: keys, models and metering

- **5.1 LLM proxy.** OpenAI-compatible endpoint in the control plane forwarding to Sarvam; the VM gets a short-lived scoped token only. _Done when:_ a scan of the VM finds no Sarvam key and turns still work.
- **5.2 Usage records.** Tokens in and out per user and model. _Done when:_ totals match the provider's own numbers on a test run.
- **5.3 Plans and weekly reset.** Warn at 80%, return 429 at 100%, meter shown in the UI. _Done when:_ a test user hitting the cap is stopped and resets on schedule.
- **5.4 VM-hours.** Meter running time and enforce a cap. _Done when:_ a capped user's VM is stopped and the UI says why.
- **5.5 Bring your own key.** Stored encrypted in the control plane, forwarded by the proxy, not metered for AI use. _Done when:_ a turn runs on a user key with no key on the VM.

## Phase 6: connections through Composio

- **6.1 Broker.** The control plane serves tools per user (user ID fixed); the VM gets a short-lived token. _Done when:_ a bot lists a user's connected tools and the VM holds no OAuth tokens.
- **6.2 Connect flow.** The agent asks, the user gets a connect link, authorizes, and the turn continues. _Done when:_ "summarise my email" works from a cold start.
- **6.3 Approval policy.** Actions that change things (send, post, delete) always ask by default. _Done when:_ a send blocks until approved.
- **6.4 Audit log.** Every tool call, approval and result recorded per user. _Done when:_ a run is fully reconstructable from the log.

## Phase 7: live view and takeover

Browser and desktop control already work from Task 2.9. This phase only lets the user watch and step in.

- **7.1 Live view.** Stream the whole desktop to the web UI, not just the browser. This is the computer screen: the thread stays the conversation (Task 3.5). Compare Amazon DCV, noVNC-style VNC and an Xpra/WebRTC option, and check the stream passes through the relay (Task 4.3). _Done when:_ you can watch a task as it happens.
- **7.2 Takeover.** You can take control to sign in or solve a captcha, then hand back. _Done when:_ a login flow completes with the user typing credentials directly.

## Phase 8: notifications and onboarding

- **8.1 Web push.** Turn finished, approval needed, run failed. _Done when:_ a notification arrives with the tab closed.
- **8.2 One-click onboarding.** Signup, VM provisioning, a default bot, a prompt to connect tools. _Done when:_ a first-time user with no technical knowledge is chatting within minutes.
- **8.3 Safety review before any outside user.** Outbound traffic logging and limits, abuse and cost controls, secrets scan, verification of the separate-account and instance-metadata settings. _Done when:_ a written checklist passes.

## Phase 9: later

- **9.1 Slack.** **9.2 Discord.** Adapters mapped to threads.
- **9.3 More engines and subscriptions.** Claude, Codex, Cursor and others through ACP. First check Anthropic's and OpenAI's current terms for running consumer-subscription tools on machines we host; until then, subscription logins are self-hosted only.
- **9.4 Self-hosted and local mode.** Same daemon on a laptop or VPS, with the limits clearly stated (sleeps, no wake-up, weaker isolation).
- **9.5 Voice** through Sarvam. **9.6 Mobile app.**

## Verification, across the whole project

- Per task: its "done when" check, run in CI where it can be.
- **Unit tests** for pure logic (schedule maths, metering) using a fake clock.
- **A recorded session** for the OpenCode hello turn, including the thought chunk, effort option, and `thoughtTokens` seen on the Sarvam `glm5.3` turn. Tests read that file and do not start the engine.
- **Integration tests** for the daemon with a real OpenCode process.
- **End-to-end on a real EC2 instance** at the end of Phases 4, 5, 6 and 7: sign up, chat, create a schedule, stop the VM, confirm the wake and the result, confirm an approval blocks, confirm the usage counter moves and the limit fires.
- **A standing model-fit set** of three real tasks (a daily tracking job, an email summary, a browser click-through that starts with a web search), re-run whenever the default model changes.
- **Safety checks** (Tasks 4.2 and 8.3) are repeatable scripts, not one-off reviews.
