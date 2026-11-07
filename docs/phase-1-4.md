# Phase 1.4

An approval is the user's allow or deny for a sensitive action. OpenCode asks with `session/request_permission`. The daemon answers with one of the options OpenCode offered. The engine waits until that answer comes back.

OpenCode asked when a turn tried to read `.env`. The options were Allow once, Always allow, and Reject. Reject is `reject_once` with option id `reject`. The reply selected that option. The tool call then updated to status `failed`, with the error `The user declined this tool call`. The file contents were not in the result. The turn stopped with `cancelled`.

That question, the rejection, and the failed update are in `apps/daemon/fixtures/opencode-hello.json`. The mapping lives in `apps/daemon/src/approval.ts`. A test holds the request open, answers it, and checks that a denial fails the tool instead of returning its output.
