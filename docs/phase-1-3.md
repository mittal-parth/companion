# Phase 1.3

This task checks that OpenCode can run a tool-calling turn on Sarvam's `glm5.3`, the managed default model. The engine stays OpenCode. GLM can be served by other providers. Sarvam is the one this service calls.

The turn used the same ACP messages as the hello script: `initialize`, `session/new`, and `session/prompt`. OpenCode 2.2.6 read `note.txt` and replied `marigold`. It did not ask permission. The stop reason was `end_turn`.

OpenCode was pointed at Sarvam with a temp `opencode.json` for that run only. The provider id is `sarvam`, the package is `@opencode/ai/providers/openai-compatible`, and the base URL is `https://api.sarvam.ai/v2`. The model reference is `sarvam/glm5.3`. The key stayed in `SARVAM_API_KEY`. The config named that variable twice: as OpenCode's provider credential, and as the `api-subscription-key` header. Sarvam's chat reference lists both. The key was not written into the config file.

The session updates stayed the hello shape. This run also sent `agent_thought_chunk` notes, an `effort` option set to `default`, and `thoughtTokens` (29) on the prompt result. Those three are now in `apps/daemon/fixtures/opencode-hello.json`. Tests read that file. They do not start OpenCode and they do not call Sarvam.

No script is kept for this task. The daemon writes this provider config when it starts OpenCode.
