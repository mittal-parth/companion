# Phase 1.5

`session/cancel` stops the turn that is running. Sent while OpenCode was still working, the prompt returned stop reason `cancelled`. That value is on the hello fixture as `cancel`.

OpenCode advertises `loadSession`. After the process was killed, a new process accepted `session/load` for the same session id and working directory. The load response carried `configOptions`, the same kind of model and mode selectors `session/new` returns. A prompt on that loaded session finished with `end_turn`.

A test does the same two steps against an in-process engine: cancel fails a tool that is waiting for an approval, and a second connection loads the session and continues the prompt list.
