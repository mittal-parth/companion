# Phase 2.4

The daemon stores a schedule and sends its prompt into that bot's one conversation when the slot arrives. The schedule maths names the slot. Croner only waits for that instant. A cron, an interval, and a one-time schedule all wait the same way.

A schedule is created on the running daemon. There is no HTTP route yet. The later tool and the UI call this same function. An id is filled in when the caller leaves it out. The bot must already exist.

The prompt is what the engine receives. The transcript stores the engine's updates, the same way a person's message does. Nothing is written to say that a schedule started.

The receipt is the occurrence whose turn came back. Every stop reason counts, including a denial, a token limit, a refusal, and a normal answer. A thrown prompt writes no receipt. A crash writes no receipt either. Task 2.5 is the restart that sends an unfinished slot once when the miss is still inside its window. While this process stays up, a throw is not tried again.

A schedule that comes due during a turn waits, then sends that same prompt. Slots that pass during the wait are left unfinished for task 2.5. The next wait is the next slot that is still in the future.

Two behaviors are deferred:

- A person cannot yet send a message while a turn is running. The second message is still refused. The aim, as in Grok Bot, is to accept that message, acknowledge it, and let the other work continue.
- A slot that arrives while a turn is running is not queued beside it. The slot that already fired waits. Later slots that pass are left for catch-up.

The check uses the real clock and a scripted engine. One schedule is a couple of seconds out. The cron and the interval wait for a real minute.

```bash
pnpm exec vitest run apps/daemon/src/scheduler.test.ts
```
