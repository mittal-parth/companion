# Companion

One user has many bots. Each bot has its own instructions, memory, and threads. An engine runs the turns; our daemon hosts the bots and is the ACP client.

## Agents

**Bot**:
A named agent belonging to one user, with its own instructions, memory, and threads. New threads copy its engine.
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

**Harness**:
The model-and-tool loop inside an engine: one prompt, tool execution, permission checks, and the session updates that result.
_Avoid_: daemon, bot

**Daemon**:
Our long-running process that hosts the user's bots and speaks ACP to the engine.
_Avoid_: engine, bot

## Conversations

**Thread**:
The transcript of one conversation, owned by one bot. The web conversation and the Slack conversation with the same bot are two threads, and they share that bot's files and memory. A thread stays the same conversation when the engine's session is replaced. It records the engine that owns its session, so a restart starts that engine and loads the session.
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
