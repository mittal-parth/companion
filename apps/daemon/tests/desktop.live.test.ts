/**
 * Proves a real bot finishes a task in a window that is not a browser.
 * Skipped unless COMPANION_LIVE=1, so CI does not call the provider.
 * The permission that denies xdotool is covered by the engine unit test.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const sentence = "The oak code is 4419.";

test.skipIf(!live)(
  "a bot writes a sentence in Mousepad",
  async () => {
    requireOpencode();
    const directory = mkdtempSync(join(tmpdir(), "companion-desktop-live-"));
    const daemon = await startDaemon({
      storePath: join(directory, "threads.db"),
      opencodeBin,
    });
    try {
      const bot = await createLiveBot(daemon, "Desk");
      writeFileSync(join(bot.directory, "note.txt"), "");
      const filled = await askBot(
        daemon,
        bot.id,
        `Use the desktop command to open mousepad on note.txt in your folder. Type exactly this sentence into the document: ${sentence} Leave the window open. Reply with the sentence once it is in the editor.`,
      );
      expect(hasToolCall(filled.updates), JSON.stringify(filled.events)).toBe(
        true,
      );
      expect(filled.reply, JSON.stringify(filled.events)).toContain("4419");
      const seen = await desktop(
        join(directory, "bin", "desktop"),
        bot.directory,
        ["snapshot", "-i", "--compact"],
      );
      expect(seen.code, `${seen.stdout}\n${seen.stderr}`).toBe(0);
      expect(seen.stdout).toContain(sentence);
    } finally {
      await daemon.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  900_000,
);

/** Runs the `desktop` command from inside the bot's folder. */
function desktop(
  shim: string,
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(shim, args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("exit", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
