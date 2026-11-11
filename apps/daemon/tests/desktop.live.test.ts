/**
 * Proves a real bot finishes a task in a window that is not a browser, and
 * that it cannot drive the screen with xdotool. Skipped unless COMPANION_LIVE=1,
 * so CI does not call the provider.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { hasToolCall } from "../src/acp-hello.js";
import { startDaemon } from "../src/api.js";
import {
  askBot,
  createLiveBot,
  opencodeBin,
  requireOpencode,
} from "./helpers.js";

const live = process.env.COMPANION_LIVE === "1";

test.skipIf(!live)(
  "a bot completes the form and cannot run xdotool",
  async () => {
    requireOpencode();
    const directory = mkdtempSync(join(tmpdir(), "companion-desktop-live-"));
    const daemon = await startDaemon({
      storePath: join(directory, "threads.db"),
      opencodeBin,
    });
    try {
      const bot = await createLiveBot(daemon, "Desk");
      const filled = await askBot(
        daemon,
        bot.id,
        "Use the desktop command to open the form. Enter the name Priya Nair, accept the terms, and submit. The form rejects a submit until the terms are accepted. Reply with the confirmation code the window shows.",
      );
      expect(hasToolCall(filled.updates), JSON.stringify(filled.events)).toBe(
        true,
      );
      const saved = JSON.parse(
        readFileSync(
          join(bot.directory, ".companion", "desktop-form.json"),
          "utf8",
        ),
      ) as { code?: string; name?: string };
      expect(saved.name).toBe("Priya Nair");
      expect(saved.code).toMatch(/^CF-/);
      expect(filled.reply, JSON.stringify(filled.events)).toContain(saved.code);

      const raw = await askBot(
        daemon,
        bot.id,
        "Run the shell command `xdotool getmouselocation` and tell me exactly what happened. Do not use the desktop command for this.",
      );
      const failed = raw.updates.some(
        (update) =>
          update.sessionUpdate === "tool_call_update" &&
          update.status === "failed",
      );
      expect(failed, JSON.stringify(raw.events)).toBe(true);
    } finally {
      await daemon.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  900_000,
);
