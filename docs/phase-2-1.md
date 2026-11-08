# Phase 2.1

The daemon is the local API for one user's bots. It listens on `127.0.0.1` with no auth. `POST /bots` takes a name and an optional engine (`opencode` by default). It creates one folder, `bots/<id>` next to the database, and one thread row. That row is the conversation: the folder, the session id, and the updates. `GET /bots` lists bots. `GET /bots/:id` returns the bot and its updates. `POST /bots/:id/messages` takes `{ "text" }` and streams server-sent events: `update` with one ACP session update, then `done` with the stop reason. An error after the stream has started is an `error` event. A second message for a bot that is already in a turn is `409`.

A bot is one conversation, and messages are sent to that bot. A tool request is allowed, so a turn can finish a file read.

One OpenCode process stays up for the life of the daemon. The first prompt calls `session/new` and stores the session id. A later prompt on that process reuses it. A session id with no open session in this process is `session/load`.

The turn runs on Sarvam's `glm5.3`. Before OpenCode starts, the daemon writes `opencode.json` into the process config and into the bot's folder. The provider id is `sarvam`, the package is `@opencode/ai/providers/openai-compatible`, and the base URL is `https://api.sarvam.ai/v2`. The model reference is `sarvam/glm5.3`. The key stays in `SARVAM_API_KEY`. The config names that variable twice: as the provider credential, and as the `api-subscription-key` header. The key is not written into the file.

OpenCode 2.2.6 read a word from the bot's `note.txt`, called a tool, and replied with that word. The stop reason was `end_turn`. That check is `apps/daemon/src/api.live.test.ts`. It runs when `COMPANION_LIVE=1`. The scripted tests in `apps/daemon/src/api.test.ts` cover create, the stream, the stored updates, the busy turn, and a failed engine. They do not start OpenCode.

```bash
COMPANION_LIVE=1 pnpm exec vitest run apps/daemon/src/api.live.test.ts
```

`opencode` must be on `PATH`, or set `OPENCODE_BIN`.
