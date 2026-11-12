# Phase 3.6

A tool call that needs a decision shows Allow and Deny on that step, and only while it is waiting. The rest of the tool calls stay out of the thread, during the turn and after it. OpenCode's text still shows. The streaming status row under the bot's latest reply stays as it is: the bot's picture, three dots, and a rotating line.

OpenCode asks with `session/request_permission`. The daemon holds that request and sends it on the same turn stream. Allow picks a one-time option and the tool call continues. Deny picks a rejection, the tool call fails, and its result is not shown. A reload while the question is open shows the same step again.

The browser still never talks to the daemon. Allow and Deny go to the Next.js route, and that route calls the daemon.

```bash
pnpm test
pnpm e2e
```

`POST /bots/:id/approvals` accepts `{ "toolCallId", "decision" }`. `decision` is `allow` or `deny`. Nothing waiting for that step is a 404.

## What the browser test covers

The scripted daemon asks before reading a vault. The step shows Allow and Deny while the status row is still under the reply. Deny ends the tool call, and that step leaves the thread. The vault's word is not on the page, earlier tool calls stay hidden, and the status row leaves when the turn does.
