# Phase 2.10

The managed model is Sarvam's `glm5.3`. It can call tools and it cannot see. An image sent to it is a 400, so a pasted image never goes on that prompt.

The daemon writes the file under the bot's `images/` folder and adds a line that names the path. The conversation stays on `glm5.3`. A read-only subagent, `vision`, runs on `glm5.3-flash` and answers the question about the file. It can read. It cannot edit, run a command, or launch another agent, and launching it does not ask the user. The parent decides what to do with the answer.

`glm5.3-flash` is the serverless Sarvam model that takes text and images and still calls tools. OpenCode is told that this model accepts an image attachment, so the file is sent rather than dropped. A model that can already see, including Flash itself and later Claude or Codex, does not get this subagent. Those turns receive the image bytes directly. The subagent answers in a few steps.

Pages stay on accessibility snapshots. That is Task 2.9. This subagent is for pixels: a pasted image, or a screenshot file the parent asks it to read.

A message may include `images`, each `{ "mimeType", "data" }` with base64 and no `data:` prefix. The type has to match the bytes. A turn holds at most four images, each at most 5 MB.

The unit tests check the config, the saved file, and that the text model's prompt has no image bytes. The live check paints a code in a normal font, so the letters are not in the file as text, and asks the bot what the code is.

```bash
COMPANION_LIVE=1 pnpm exec vitest run apps/daemon/src/image.live.test.ts -t "pasted code"
```

`opencode` must be on `PATH`, or set `OPENCODE_BIN`.
