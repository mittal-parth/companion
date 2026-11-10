# Phase 2.7

A turn belongs to the daemon. The client that started it is only watching.

`POST /bots/:id/messages` still streams the turn while that connection stays open. Closing it — a dropped request now, and later a closed web app, Slack, Discord, or phone — stops the stream and leaves the turn running. Each session update is stored before it is written out, so a dead socket cannot lose it or fail the turn. A second message to that bot is still `409` until the turn ends. Catching up is not another POST.

`GET /bots/:id` is the same transcript read as before. It now also says what the turn is doing:

- `idle` — no turn has run
- `running` — the daemon is in a turn, with whatever updates have been stored
- `finished` — the stop reason, including `cancelled` when a quiet turn was stopped
- `failed` — the error

There is no wall-clock cap. A turn can run for hours while it is working. Working means a session update arrived, or a tool call has started and has not finished, so a long command stays alive through a quiet stretch. Three minutes with neither, and the daemon cancels the turn.

The turn's running or finished state lives in the daemon process. The updates live in SQLite. A restart of the daemon is out of scope: that stops the process, and the turn with it.

```bash
pnpm exec vitest run apps/daemon/src/api.test.ts apps/daemon/src/engine.test.ts
```

One test drops the HTTP client in the middle of a turn, checks the `409`, then reads the bot and finds the updates that arrived after the drop. The other moves the clock forward hours: updates and an open tool call keep the turn alive, and silence cancels it.
