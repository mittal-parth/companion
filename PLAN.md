# Plan: cloud-first personal agents, a VM per user (new product, new repo)

This replaces the earlier eve + Vercel plan. That plan is dropped.

## Context

The goal is an open-source alternative to Grok Bot, Duet, Dots and Muse, built in the open and also offered as a managed service.

- Each user gets one cloud computer (an EC2 instance) shared by all their bots.
- Bots run long tasks, browse and click, run user-defined schedules, and are reachable from web, Slack, Discord and later an app.
- The managed default sends model calls to Sarvam Token Factory. The user doesn't handle any API key. Users who want to can bring their own key, or later their own subscription.
- Tools connect through Composio OAuth, and keys never sit on the VM.
- A non-technical user signs up in one click and it works.

Research that shaped this:
- eve can't host Claude Code or Codex as its loop, and its sessions don't fit a long-lived computer.
- OpenMausBot and Hermes are the closest references. They run the agent next to the machine it controls, with a scheduler in the same daemon.
- A **harness** is the part that runs one agent turn: the model-and-tool loop, tool execution and permission prompts, context assembly and compaction, session history with resume and cancel, and normalised streaming events. Schedules, channels, multi-user auth, metering, notifications and VM lifecycle are **not** part of a harness; they are product layers around it. That is why the scheduler lives in our daemon and every engine looks the same to it (`send(prompt)` into a thread).
- OpenClaw is ruled out. Hermes is a full product (its own gateway, cron, memory, channels), so it can at most be one optional engine behind ACP, not the foundation.
- The open harnesses worth testing as the default engine are **OpenCode** (MIT, `opencode serve` HTTP + SDK, ACP, allow/ask/deny permissions, MCP, custom OpenAI-compatible `baseURL`, and an experimental per-session scheduler) and **Pi** (MIT, minimal, SDK + RPC, custom OpenAI-compatible providers, no scheduler of its own). Goose (Apache-2.0, Rust, has a cron scheduler and an ACP server) is a third option.
- The Vercel **AI SDK** (Apache-2.0) has two relevant layers. `ToolLoopAgent` is only a loop: no persistence, memory, approvals or scheduling. **`HarnessAgent`** (experimental) is a single interface over Claude Code, Codex, Cursor, Pi, OpenCode, Cline, Copilot and others, with a generic ACP adapter; it normalises streams, sessions with resume, approvals, skills and custom tools, and its streams feed `useChat`/ai-elements directly. Its only sandbox adapters today are Vercel and just-bash, so running it on our EC2 VMs needs a custom sandbox adapter or host-process mode.
- Sarvam Token Factory is OpenAI-compatible (`https://api.sarvam.ai/v2`) but its docs show no per-key budgets or usage API. **We meter at our own proxy.**

## Requirements map

| # | Requirement | Covered by | Phase |
|---|---|---|---|
| 1 | Multiple bots, one computer | one VM, a folder per bot, one OS user | 2 |
| 2 | See what the agent computer is doing | event stream + terminal/file view, then browser screencast | 1 / 4 |
| 3 | Long-running tasks | daemon owns turns; VM never stops mid-turn | 1 |
| 4 | Connect favourite tools by asking | Composio OAuth via the broker | 3 |
| 5 | User-defined schedules | scheduler in the VM daemon + EC2 wake | 2 |
| 6, 9, 15 | Bring your own harness/key/subscription, Sarvam default | engine drivers; the LLM proxy | 1 / later |
| 7, 8, 17 | Cloud first on AWS; local optional | same daemon runs on a laptop or VPS | 1 / later |
| 10 | Many channels, same bot | channel adapters mapped to bot threads | 1 (data model) / later |
| 11 | Key security | keys only in the control plane; short-lived scoped VM tokens | 1 |
| 12 | Browser control | Chromium + CDP on the VM | 4 |
| 13 | Notifications | web push on turn done / approval needed | 2 |
| 14 | Voice via Sarvam | channel adapter | later |
| 16 | Usage limits, weekly resets | proxy token meter + VM-hour meter | 5 |

## Architecture

```
Clients: web (PWA), Slack, Discord, app later
        │
Control plane (web app + API + Postgres): auth, bots, threads, usage plans,
   push notifications, VM lifecycle, credential broker (Composio), LLM proxy
        │
Relay: always-on websocket service; each VM dials OUT to it (no inbound ports)
   + EventBridge Scheduler → Lambda → EC2 start (wake only)
        │
User's EC2 VM (hardened AMI):
   daemon: scheduler (SQLite), thread store, approvals, engine driver,
           browser (Chromium + CDP), live-view stream
   /bots/<id>/  (files, memory)   +   /shared
   engine (swappable, behind one interface): default chosen in Phase 0 → our LLM proxy
          (Sarvam / user key); Claude Code / Codex / Cursor via the user's own login later
```

**Trust boundary.** Because every bot shares the user's logins, the VM is the security boundary and bots are not (the same stance as Grok Bot). The MVP uses one OS user with a folder per bot.

**Key custody and metering.**
- Sarvam and Composio keys live only in the control plane.
- The VM gets a short-lived token for the LLM proxy. The proxy counts tokens per user per week and returns 429 at the limit.
- Composio calls go through the broker with `user_id` fixed, since a project key could otherwise act for any user.
- Users on their own subscription bypass the proxy; only VM time is metered for them.

**Subscription logins on managed VMs.** Unresolved. Default: managed users bring an API key, and subscription logins work in self-hosted mode only, until Anthropic's and OpenAI's current terms for third-party-hosted subscription CLIs are checked.

**What to keep from this repo.** Start a new repo. Port the Supabase auth approach, the web chat UI components (`apps/web/components/ai-elements`, shadcn) and the Discord gateway-relay pattern from `daemon/`. Drop eve, the Vercel Drive idea and the Supabase schedule dispatcher. Leave the uncommitted chats work here as it is.

## Harness layer: what we build and what we borrow

**We build (the daemon, identical for every engine):** bot and thread store (it keeps its own transcript from the engine's event stream, and each thread's resume state, because no AI SDK adapter exposes history), the scheduler (SQLite job table, `croner`, catch-up window, run receipts; each firing sends the prompt into the bot's thread), the approval broker, channel adapters, usage reporting, the browser and live view.

**We borrow:** one engine behind a narrow interface (`startTurn`, `stream events`, `cancel`, `resume`, `answerApproval`). Two ways to supply that interface:

- **A. AI SDK `HarnessAgent`.** Ready-made adapters for most engines and AI SDK stream shapes the web UI already understands. Costs: it is experimental, and it needs a custom adapter for our VM.
- **B. ACP directly** (the route OpenMausBot takes). An open protocol, so no dependence on an experimental package, but we write the normalisation ourselves.

Two limits to check in spike 1 before choosing A:
- **Where the engine runs.** AI SDK adapters split into *host process* (Pi, Cline, fx), which can run inside our daemon on the VM, and *sandbox bridge* (Claude Code, Codex, OpenCode), which the docs say need a "real network sandbox". Only Vercel and just-bash sandbox adapters ship today. If a bridge adapter can't target the VM it runs on, the pairing becomes Pi through `HarnessAgent` and OpenCode driven directly through `opencode serve` and its SDK.
- **Approvals are not uniform.** Built-in tool approval is missing for the Codex, Cursor, Copilot and Grok Build adapters. For those engines the daemon has to gate tools itself, or requirement 13 (block until approved) can't be met. "Swappable" therefore means "swappable with different approval guarantees".

Default: try A first; fall back to B if the adapter can't run on the VM or breaks between releases. Keep our own interface in between either way, so the choice stays reversible. Schedules stay in the daemon rather than in any engine's own scheduler, so swapping an engine never loses them. A raw crontab entry is not used: the daemon needs catch-up, receipts and thread routing, which crontab lacks.

## Phase 0: spikes (go / no-go before building anything else)

1. **Pick the default engine and the interface.** Candidates: OpenCode, Pi, Goose; via AI SDK `HarnessAgent` and via ACP. Each runs headless on EC2 against the Sarvam proxy. **Pass:** a chat turn, a daemon-fired scheduled run and an approval that blocks a tool call until the user decides, all working, with usage reported to the proxy. Also record: custom `baseURL` for Sarvam works, image input works for the browser task, and the engine can be given a non-coding system prompt for everyday tasks. Read how qm wires Pi first.
2. **Model quality gates the managed default.** Run three real tasks through the engine, the proxy and Sarvam: a daily tracking job, a Gmail summary via Composio, and a browser click-through. Browser control needs image input, which Sarvam lists only for GLM-5.3 Flash and Gemma 4. **If these fail, the subsidy plan changes, so nothing downstream is committed before this.**
3. **VM lifecycle numbers.** Measure instance-start to daemon-ready for plain stop vs hibernate. Check that Chromium + a virtual desktop + several bots fit in 4 GB. Check that bring-your-own CLIs ship linux-arm64 before committing to Graviton.
4. **Relay choice:** our own websocket service versus a managed broker VMs dial out to (API Gateway WebSocket or IoT Core). Prefer whichever means fewer always-on services.
5. **Terms check:** Anthropic and OpenAI rules for running consumer-subscription CLIs on machines we host.

## Phases

1. **One VM, one bot.** Control plane skeleton, EC2 provisioner, daemon with the chosen engine, relay, web chat, persistent files, an LLM proxy that records usage. Baseline safety from day one: no instance role, IMDSv2 required, user VMs in a separate AWS account. Data model with threads separate from channels, so req. 10 needs no migration later.
2. **Many bots and schedules.** Multiple bots on one VM, the daemon scheduler (SQLite, catch-up window, run receipts, results posted into the bot's thread), EventBridge wake, web push. Idle stop only when no turn is running, nobody is watching live, and no schedule is due within N minutes. Design the "waking your computer" state for the 30–60 s cold start.
3. **Connections and approvals.** Composio broker, approval cards that block until the user decides, an audit log.
4. **Browser and live view.** Chromium with CDP, a screencast stream, user takeover for logins and captchas.
5. **Limits and onboarding.** Weekly-reset plans for tokens and VM hours, one-click signup, egress controls. **All of this before any outside user.**

Later: Slack and Discord, bring-your-own harness via ACP, self-host provisioner and local mode, voice via Sarvam, mobile app.

## Verification

- Phase 0 is itself the verification, with the pass criteria above, recorded in a short results note per spike.
- Each phase ends with an end-to-end run on a real EC2 instance: sign up, chat, create a schedule, stop the VM, confirm the wake and the scheduled result in the thread, confirm an approval pauses the action, confirm the usage counter moves and the 429 fires at the limit.
- Evals from the start (extending the habit in AGENTS.md): the three Phase 0 tasks become a standing regression set run against each model option.

