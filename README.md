# Companion

> **Work in progress.** Companion is under active development and not yet usable. Expect missing pieces and changing designs. The full roadmap is in [PLAN.md](./PLAN.md).

An open-source alternative to Grok Bot, Duet, Dots and Muse, offered both self-hosted and as a managed service.

## What we are trying to achieve

- Each user gets one cloud computer (an EC2 instance) shared by all their bots.
- Bots run long tasks, browse and click, run user-defined schedules, and are reachable from web, Slack, Discord and later an app.
- The managed default model is `glm5.3` on [Sarvam Token Factory](https://docs.sarvam.ai/api/token-factory). The user never handles an API key. Users who want to can bring their own key, and later their own subscription.
- Tools connect through [Composio](https://docs.composio.dev/docs/authentication) OAuth, and keys never sit on the VM.
- A non-technical user signs up in one click and it works.

## How it fits together

```
Clients: web (PWA), Slack, Discord, app later
        │
Control plane (web app + API + Postgres): auth, bots, threads, usage plans,
   push notifications, VM lifecycle, credential broker (Composio), LLM proxy
        │
Relay: always-on websocket service (ECS Fargate behind a load balancer);
   each VM dials OUT to it (no inbound ports)
   + EventBridge Scheduler → EC2 start (wake only)
        │
User's EC2 VM (hardened image):
   daemon (ACP client): bot + thread store (SQLite), scheduler, approval broker,
                        browser (Chromium + CDP), live-view stream
   /bots/<id>/  (files, memory)   +   /shared
   engine: OpenCode over ACP → our LLM proxy (Sarvam / user key)
```

## Technical details

- **Engine protocol: ACP.** The daemon is an [Agent Client Protocol](https://agentclientprotocol.com/protocol/overview) client and speaks to the engine over stdio, so there is no vendor lock-in. The default engine is OpenCode (`opencode acp`). Claude, Codex and others can plug in through the same adapter. See the [ACP registry](https://github.com/agentclientprotocol/registry) and the [TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk).
- **Approvals.** ACP's `session/request_permission` becomes our approval card and push notification.
- **Scheduler lives in our daemon**, not in any engine, so swapping an engine never loses schedules. Jobs sit in SQLite with [croner](https://github.com/Hexagon/croner) for timing, with catch-up and run receipts. A stopped VM is woken by a one-time [EventBridge Scheduler](https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-targets-universal.html) entry.
- **Cloud: AWS**, one EC2 instance per user, stopped when idle. User VMs live in a separate AWS account from the control plane.
- **Control plane:** Supabase (Postgres, Google sign-in, row-level security) and a Next.js web app with Tailwind and shadcn/ui.
- **Trust boundary.** The VM is the security boundary, and bots are not. All bots share the user's logins.
- **Key custody and metering.** Sarvam and Composio keys live only in the control plane. The VM gets a short-lived token for our LLM proxy, which meters tokens per user per week. Composio calls go through our broker with the user ID fixed.
- **VM safety baseline.** No instance role, [IMDSv2 required](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-options.html), no inbound ports.
- **Browser and live view.** Chromium on the VM, streamed to the web UI with [CDP screencast](https://chromedevtools.github.io/devtools-protocol/).

## Repository layout

- `apps/` runnable apps (web app, daemon)
- `packages/` shared packages
- `docs/` explainers and decision records
- [`GLOSSARY.md`](./GLOSSARY.md) shared vocabulary

## Plan

The design, decisions, phase-by-phase tasks and verification approach are in [PLAN.md](./PLAN.md).
