# Companion

One user has many bots. Each bot has its own instructions, memory, and threads. An engine runs the turns; our daemon hosts the bots and is the ACP client.

## Agents

**Bot**:
A named agent belonging to one user, with its own instructions, memory, and one long-lived conversation about its task. A content bot is that whole conversation. It remembers an engine for the session.
_Avoid_: agent, assistant, engine

**Engine**:
The ACP process that runs a turn. OpenCode is the default engine.
_Avoid_: bot, harness, model

**Provider**:
The API an engine calls to run a model. Models on one provider share that API's message shape.
_Avoid_: engine, model

**Model**:
The weights a turn runs. More than one provider can serve the same model.
_Avoid_: engine, provider, bot

**Vision subagent**:
A read-only child session that looks at an image file for a model that cannot see. The managed default uses Sarvam's GLM 5.3 Flash for this. A model that can already see does not have one.
_Avoid_: browser, screenshot

**Harness**:
The model-and-tool loop inside an engine: one prompt, tool execution, permission checks, and the session updates that result.
_Avoid_: daemon, bot

**Daemon**:
Our long-running process that hosts the user's bots and speaks ACP to the engine.
_Avoid_: engine, bot

## Conversations

**Thread**:
The stored transcript and engine session of a bot's conversation: the updates, the session id, and the working directory a restart loads. The local API does not ask anyone to create one. A bot's conversation is that one thread. When a second channel needs its own transcript, that channel gets its own thread, and those threads share the bot's files and memory.
_Avoid_: channel, chat, session

**Channel**:
A way a person reaches a bot, such as the web app, Slack, or Discord. A channel delivers into a thread.
_Avoid_: thread

**Message**:
A user message, an agent message, or an agent thought in a thread, identified the way ACP identifies it. Its content arrives as one or more session updates.
_Avoid_: event, chat log entry

**Session**:
The engine's handle for the current run of a thread. A new session can be attached to an existing thread.
_Avoid_: thread

**Session update**:
One `session/update` notification from the engine. A thread's transcript is the sequence of these.
_Avoid_: event, delta

**Approval**:
The user's allow-or-deny decision on a sensitive action the engine wants to take.
_Avoid_: permission

**Schedule**:
A rule that sends one prompt into a bot's conversation at later times. It is a calendar cron, an elapsed interval, or a single instant. The maths names each occurrence; the daemon fires it later. A schedule can be paused: while it is, nothing fires, no receipt is written, and the slots it misses are not caught up. The bot manages its own schedules by running the `schedule` command.
_Avoid_: job, routine

## Browser

**Shared browser**:
The one headed Chrome and profile that every bot on a machine uses, so a login made by one bot is there for the others.
_Avoid_: browser profile, session

**Bot window**:
The browser window the daemon opens in the shared browser for one bot. Every `browser` command from that bot is pinned to it.
_Avoid_: tab, session
