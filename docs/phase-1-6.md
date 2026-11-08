# Phase 1.6

The daemon keeps its own SQLite database of threads. That file is the list the product shows, the transcript the chat renders, and the note that says which engine to start after a restart.

OpenCode already stores the session, in `~/.local/share/opencode/opencode.db` on this machine. That database is how OpenCode continues a session after `session/load`. The daemon keeps the thread beside it, in its own file. A thread can outlive that session, and another bot can run on Claude or Codex instead of OpenCode. Each of those engines has its own files. The session id in one of them means nothing to the others.

The daemon's file is `threads.db` under `$XDG_DATA_HOME/companion`, or `~/.local/share/companion` when that variable is unset. It sits apart from the engine's store and from the bot's files under `/bots/<id>/`.

A bot has a default engine. A new thread copies it. Changing the bot's engine afterward leaves an existing thread on the engine it started with, because that session id belongs to that engine. Replacing the session id later does not change the engine or the transcript.

A thread holds the bot, the engine, the session id, the working directory, and the session updates in the order the engine sent them. Those updates are the same objects as in `apps/daemon/fixtures/opencode-hello.json`. On a restart the daemon reads the thread back and starts that engine with `session/load`, passing the session id and the working directory. Starting the engine arrives with the local API. This store remembers which engine, session, and directory that call needs.

The check closes the database and opens it again. The thread that comes back matches the one that was written, including the recorded OpenCode updates.
