# Plan: cloud-first personal agents, a VM per user

## Context

An open-source alternative to Grok Bot, Duet, Dots and Muse, offered both self-hosted and as a managed service.

- Each user gets one cloud computer (an EC2 instance) shared by all their bots.
- Bots run long tasks, browse and click, run user-defined schedules, and are reachable from web, Slack, Discord and later an app.
- The managed default sends model calls to [Sarvam Token Factory](https://docs.sarvam.ai/api/token-factory) (OpenAI-compatible, `https://api.sarvam.ai/v2`). The user never handles an API key. Users who want to can bring their own key, and later their own subscription.
- Tools connect through [Composio](https://docs.composio.dev/docs/authentication) OAuth, and keys never sit on the VM.
- A non-technical user signs up in one click and it works.

### Decisions already made

- **Engine protocol: ACP**, so no vendor lock-in. **Default engine: OpenCode.**
- **Cloud: AWS** (credits), one EC2 instance per user, stopped when idle.
- **Scheduler lives in our daemon**, not in any engine, so swapping an engine never loses schedules.
- **Control plane database and login: Supabase** (Postgres, Google sign-in, and row-level security). Tables the browser reads directly (bots, thread index, schedules, usage shown to the user) get row-level security policies. Server-only tables (VM records, usage ledger, stored keys) have row-level security on with no policies, so only our backend can touch them. Our backend services (relay, LLM proxy, broker, provisioner) use the service key, which bypasses row-level security, so they check access in code. Migrations are plain SQL files, and policy tests prove one user can't read another's rows. Trade-off accepted: moving off Supabase later costs more, and self-hosting means running Supabase's open-source stack.
- **Web app:** Next.js with Tailwind and shadcn/ui; chat built from AI Elements-style components rendering our own event stream. No code carries over from any earlier project. Supabase is set up in Task 4.0, because nothing before the cloud phase needs accounts.
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
                        browser (Chromium + CDP), live-view stream
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

**Schedules.** Jobs live in the daemon's SQLite with [croner](https://github.com/Hexagon/croner) for timing. Each firing sends the prompt into the bot's thread. A raw crontab entry is not used because we need catch-up, run receipts and thread routing. Design references: Hermes's [cron internals](https://github.com/NousResearch/hermes-agent/blob/HEAD/cron/AGENTS.md) (catch-up windows, at-most-once dispatch) and OpenMausBot's [routine docs](https://github.com/milind-soni/OpenMausBot/blob/HEAD/docs/routine-schedules.md). A stopped VM can't fire jobs, so the control plane creates a one-time [EventBridge Scheduler](https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-targets-universal.html) entry that starts the instance a minute early.

## Requirements map

| #        | Requirement                                            | Where it lands                      |
| -------- | ------------------------------------------------------ | ----------------------------------- |
| 1        | Multiple bots, one computer                            | Phase 2                             |
| 2        | See what the agent computer is doing                   | Tasks 3.4, 7.2                      |
| 3        | Long-running tasks                                     | Task 2.7                            |
| 4        | Connect tools by asking                                | Phase 6                             |
| 5        | User-defined schedules                                 | Tasks 2.3 to 2.6, 4.6               |
| 6, 9, 15 | Bring your own engine/key/subscription; Sarvam default | Tasks 1.3, 5.1, 5.5, 9.3            |
| 7, 8, 17 | Cloud first on AWS; local optional                     | Phase 4; Task 9.4                   |
| 10       | Many channels, same bot                                | thread model in 0.3; Tasks 9.1, 9.2 |
| 11       | Key security                                           | Tasks 4.2, 5.1, 6.1                 |
| 12       | Browser control                                        | Phase 7                             |
| 13       | Notifications                                          | Task 8.1                            |
| 14       | Voice via Sarvam                                       | Task 9.5                            |
| 16       | Usage limits, weekly resets                            | Phase 5                             |

## How we work

- **One task at a time.** Each task is small enough for one pull request. It ends with a "done when" check that runs, and I don't start the next task until that check passes.
- **Every task leaves a short explainer** (a page under `docs/`) saying what was built and why, and I walk you through it before we move on, so you understand each piece.
- Each task adds its own tests. A bug found later gets a regression test first, then the fix.

## Phase 0: foundations (no cloud)

- **0.1 Repo and tooling.** Monorepo (web app, daemon, shared types), lint, typecheck, test runner, CI. _Done when:_ CI is green on a trivial test.
- **0.2 Web app skeleton.** Next.js app (App Router) with Tailwind and shadcn/ui, and a health route. No accounts yet: Phases 1 to 3 run against a local daemon for one user. No web container in this phase: nothing deploys the Next app yet, and the relay container in task 4.3 is a different service. _Done when:_ the app builds in CI, the smoke test starts it directly, and `/` and `/api/health` return 200.
- **0.3 Shared vocabulary.** Deferred to Phase 1. The words live in `GLOSSARY.md`, and the thread/channel split is recorded in `docs/adr/0001-thread-per-channel.md`. Schemas for bot, thread, message, and session update are copied from a recorded OpenCode session when a task first stores one, so this phase does not invent a schema that session would replace.

## Phase 1: the engine on your laptop (learn ACP and OpenCode, no cloud)

- **1.1 ACP hello.** A script using the TypeScript SDK that starts `opencode acp`, runs `initialize`, `session/new`, `session/prompt` and prints the streamed updates. _Done when:_ it prints a real reply and a tool call, and a recorded session is saved as a test fixture.
- **1.2 Engine interface.** A narrow interface (`startTurn`, `events`, `cancel`, `resume`, `answerApproval`) with an OpenCode adapter over ACP and a fake engine for tests. _Done when:_ the same contract tests pass against both.
- **1.3 Sarvam through OpenCode.** Configure a custom OpenAI-compatible provider ([OpenCode providers](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/providers.mdx)) pointing at [Sarvam](https://docs.sarvam.ai/api/token-factory). _Done when:_ a turn with tool calls works, and we've recorded which Sarvam models handle tool calling reliably. This is also our first look at whether the managed default model is good enough.
- **1.4 Approvals.** Map `session/request_permission` to our approval type ([OpenCode permissions](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/permissions.mdx)). _Done when:_ a tool call blocks until answered and a denial stops the action (tested).
- **1.5 Cancel and resume.** `session/cancel`, and `session/load` if OpenCode supports it. _Done when:_ a turn cancels cleanly and a thread continues after the engine process restarts.
- **1.6 Thread store.** SQLite transcript built from the event stream plus each thread's resume state, since the engine's own history can't be relied on. _Done when:_ restarting the daemon restores a thread exactly.

## Phase 2: the daemon, bots and schedules (still local)

- **2.1 Daemon API.** Local API to create a bot and thread, send a message and stream events. _Done when:_ an integration test drives a full turn through it.
- **2.2 Multiple bots.** A folder per bot, per-bot instructions and memory file, several bots at once. _Done when:_ two bots keep separate files and context (tested).
- **2.3 Schedule maths.** Job model, cron with timezone, next-run computation, as pure functions. _Done when:_ unit tests pass, including daylight-saving changes and invalid input.
- **2.4 Scheduler runtime.** Tick loop, fire a job by sending its prompt into the bot's thread, record a receipt, never fire twice for one occurrence. _Done when:_ a fake-clock test shows exactly-once firing.
- **2.5 Catch-up.** After downtime, run a missed occurrence once if it is within a window, otherwise skip and record it. _Done when:_ fake-clock tests cover restart, long outage and paused jobs.
- **2.6 Agent-managed schedules.** The daemon hosts a small tool server (MCP) with create, list, pause and delete schedule, passed to the engine in `session/new` ([OpenCode MCP](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/mcp-servers.mdx)). _Done when:_ saying "every day at 9, do X" creates the job. If OpenCode's ACP mode doesn't pass tool servers through, we find that out here.
- **2.7 Long tasks and reconnect.** A turn keeps running with no client connected, and a client that reconnects replays missed events. _Done when:_ a multi-minute turn survives a client disconnect (tested).

## Phase 3: web chat against the local daemon

- **3.1 Chat.** Send a message and stream the reply, using chat components in the style of [AI Elements](https://elements.ai-sdk.dev) (conversation, message, prompt input, tool call) and a streaming-markdown renderer, fed by our own event types over a websocket to the daemon. _Done when:_ an end-to-end browser test passes.
- **3.2 Bots, threads and schedules in the UI.** List and switch bots and threads, view, pause and resume schedules. _Done when:_ a scheduled result appears in the right thread.
- **3.3 Approval cards.** Allow or deny from the UI. _Done when:_ denying in the UI stops the tool call (tested end to end).
- **3.4 Activity view.** Live tool calls, file changes and command output. _Done when:_ a running turn shows each step as it happens.

## Phase 4: one VM in the cloud

- **4.0 Accounts.** The first moment we need to know who a user is. Supabase project (local through its CLI for development, hosted for staging), Google sign-in through its Next.js server-side session helpers, migrations as SQL files, and a first row-level security policy. _Done when:_ sign in and out work, an unauthenticated request is rejected, and a test proves a second user can't read the first user's row.
- **4.1 AWS foundation.** Separate account for user VMs, network, roles, budget alarms, all as code. _Done when:_ a test budget alarm fires and the stack can be torn down and rebuilt.
- **4.2 Base image.** Hardened machine image with daemon and OpenCode, IMDSv2 required, no instance role, no inbound ports, built by a pipeline. First confirm every tool in the image has a Linux ARM build (OpenCode does; check Chromium and anything else we add), otherwise build the image for x86. _Done when:_ a launched instance reports ready and a script confirms the safety settings.
- **4.3 Relay.** A small websocket service on [ECS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/Welcome.html) behind an Application Load Balancer, in the control-plane account. The daemon dials out and the web client connects; events and approvals route through, authenticated with short-lived tokens. One instance at first; adding more later needs a shared message bus between instances. It can't be serverless-function hosting, because it holds long-lived connections. We skip API Gateway WebSockets because its connections are capped at 2 hours with a 10-minute idle timeout and 128 KB messages ([quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-execution-service-websocket-limits-table.html)), which suits live-view frames poorly. _Done when:_ the web chat from Phase 3 works against the cloud VM, and a dropped connection reconnects without losing events.
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

## Phase 7: browser and live view

- **7.1 Browser tools.** Chromium on the VM exposed to the engine as tools. _Done when:_ a bot completes a click-through task.
- **7.2 Live view.** Stream the browser to the web UI using [CDP screencast](https://chromedevtools.github.io/devtools-protocol/). _Done when:_ you can watch a task as it happens.
- **7.3 Takeover.** You can take control to sign in or solve a captcha, then hand back. _Done when:_ a login flow completes with the user typing credentials directly.
- **7.4 Full desktop (decide later).** Only if the browser view isn't enough; compare Amazon DCV and noVNC-style options.
- **7.5 Image input check.** Confirm which Sarvam models can read screenshots. _Done when:_ the browser task passes on a chosen model.

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
- **Contract tests** for the engine interface, run against the fake engine and real OpenCode.
- **Integration tests** for the daemon with a real OpenCode process.
- **End-to-end on a real EC2 instance** at the end of Phases 4, 5, 6 and 7: sign up, chat, create a schedule, stop the VM, confirm the wake and the result, confirm an approval blocks, confirm the usage counter moves and the limit fires.
- **A standing model-fit set** of three real tasks (a daily tracking job, an email summary, a browser click-through), re-run whenever the default model changes.
- **Safety checks** (Tasks 4.2 and 8.3) are repeatable scripts, not one-off reviews.
