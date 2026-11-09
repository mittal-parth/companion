# Phase 2.2

A user can have more than one bot. Each bot has its own folder, `bots/<id>` next to the database, and its own OpenCode session in that folder. Two bots can be in a turn at the same time. One bot still refuses a second message until its turn finishes.

The folder is the bot's files. `AGENTS.md` is its instructions and `MEMORY.md` is its memory. The daemon does not write either file and does not keep a copy to show in a UI. The model creates them and edits them when the chat gives it something worth keeping. A missed write stays missed.

OpenCode loads a global `AGENTS.md` from the daemon's config directory into every session. That file is the standing rule: read the two files in the working directory, because the copies on disk are the latest, and update them when the user defines the bot or states a fact. It is not pasted into each message. OpenCode also reloads a bot's own `AGENTS.md` when that file changes, before the next prompt. `MEMORY.md` is not an instructions file, so the model reads it with its file tools.

`POST /bots` takes a name, an optional engine (`opencode` by default), and an optional description. The description is not stored. For an OpenCode bot, create runs a real turn before it returns. With a description, that turn tells the model the name and the description and asks it to write them into the two files, then reply. Without one, the model greets the user by name and asks what the bot is for. The reply is stored with the conversation, the same way a later message is. A failed opening turn returns an error, and the bot row is still there. Claude and Codex are still refused when a message is sent. Their folders are created, and the opening turn waits until those engines exist.

Grok Bot and OpenMausBot do the same split. Each bot has its own instructions and memory, and the bots share one computer, including its files and logins. Separate folders are not a sandbox. A bot that can edit files can edit another bot's folder if it tries. The plan's `/shared` directory is the place for rules and references every bot should see, the way Grok's shared brain is a folder on the shared computer rather than a shared memory. This task does not create it. Nothing here needs a file that belongs to every bot.

Name and avatar can change later. There is no avatar yet, and no route that renames a bot.

The scripted tests cover two folders, the opening prompt, a daemon that does not write the two files, and two turns in flight. The live test starts OpenCode twice at once, checks that each bot wrote only its own code word, restarts the daemon, and asks both bots to read their files.

```bash
COMPANION_LIVE=1 pnpm exec vitest run apps/daemon/src/api.live.test.ts
```

`opencode` must be on `PATH`, or set `OPENCODE_BIN`.
