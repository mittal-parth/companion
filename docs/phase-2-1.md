# Phase 2.1

Handover: this task is not done. The next agent has a key. The check that is still open is a full turn through the local API.

## Still open

`apps/daemon/src/api.live.test.ts` starts the daemon and OpenCode, writes a word into the bot's `note.txt`, and sends "read that file and reply with only the word." It passes when the streamed reply contains that word, a tool call is in the updates, and the stop reason is `end_turn`. It is skipped unless `COMPANION_LIVE=1`, so CI does not call OpenCode.

The last run did not pass. OpenCode 1.19.5 (`opencode-ai@1.19.5`) opened a real session on `opencode/big-pickle`, streamed `available_commands_update`, then logged `AI_APICallError: Free usage limit reached` and left the prompt open. The daemon treats that log line as a failed turn, so the stream ends with an error event. There was no reply and no tool call. The same refusal came back for `opencode/glm-5.3-flash-free` and `opencode/deepseek-v4.1-flash-free`. No API key was in the environment.

A key does not apply to `opencode/big-pickle`. That id is OpenCode's free tier. Point OpenCode at a provider the key belongs to, then run:

```bash
COMPANION_LIVE=1 pnpm exec vitest run apps/daemon/src/api.live.test.ts
```

`opencode` must be on `PATH`, or set `OPENCODE_BIN`. Phase 1.3 used OpenCode 2.2.6. This run used 1.19.5. Check which binary the key run starts.

Phase 1.3 already ran Sarvam `glm5.3` through OpenCode. Use that shape. The provider id is `sarvam`, the package is `@opencode/ai/providers/openai-compatible`, and the base URL is `https://api.sarvam.ai/v2`. The model reference is `sarvam/glm5.3`. The key stays in `SARVAM_API_KEY`. The config named that variable twice: as OpenCode's provider credential, and as the `api-subscription-key` header. The key was not written into the file. That file was not kept. `opencodeModelConfig` in `apps/daemon/src/engine.ts` only writes `{ "$schema", "model" }` with `opencode/big-pickle`. The child process copies `process.env`, so `SARVAM_API_KEY` would reach OpenCode once the config names it. Write the Sarvam provider block before `session/new`. `selectModel` throws if the ACP model list does not include the requested id. A free session only offered `opencode/...` models, so the provider block has to be in place before that list is read.

Permissions stay auto-allowed through `approvalResponse(..., "allow")`. Do not add an approve or deny route. A bot is one conversation. Do not add a thread route.

## What is in place

The daemon listens on `127.0.0.1` with no auth. `POST /bots` takes `name` and an optional `engine` (`opencode` by default). It creates one folder, `bots/<id>` next to the database, and one thread row. That row is the conversation: the folder, the session id, and the updates. `GET /bots` lists bots. `GET /bots/:id` returns the bot and its updates. `POST /bots/:id/messages` takes `{ "text" }` and streams server-sent events: `update` with one ACP session update, then `done` with the stop reason. An error after the stream has started is an `error` event. A second message for a bot that is already in a turn is `409`.

One OpenCode process stays up. The first prompt calls `session/new` and stores the session id. A later prompt on that process reuses it. A session id with no open session in this process is `session/load`. The scripted tests in `apps/daemon/src/api.test.ts` cover create, the stream, the stored updates, the busy turn, and a failed engine. They do not start OpenCode.
