/**
 * Proves two bots can each write in their own window on the shared screen
 * without ending up in each other's window. It needs no model. It is skipped
 * where the display, the accessibility bus or mousepad is not installed.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type { BotView } from "@companion/shared";
import { expect, test } from "vitest";
import { startDaemon, type Daemon } from "../src/api.js";
import { createDesktopHost } from "../src/desktop.js";
import { createDisplayHost } from "../src/display.js";
import { installDesktopShim, type Engine } from "../src/engine.js";

const atspi = "/usr/libexec/at-spi-bus-launcher";
const installed =
  ["Xvfb", "openbox", "dbus-daemon", "mousepad"].every(
    (program) => spawnSync("which", [program]).status === 0,
  ) && spawnSync("test", ["-x", atspi]).status === 0;
const calculator = spawnSync("which", ["galculator"]).status === 0;

test.skipIf(!installed)(
  "two bots write in their own windows at the same time and the daemon stops the apps",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "companion-desktop-"));
    const daemon = await startDaemon(options(directory));
    try {
      const ada = await createBot(daemon, "Ada");
      const bob = await createBot(daemon, "Bob");
      installDesktopShim(join(directory, "bin"));
      const shim = join(directory, "bin", "desktop");
      const adaRun = (args: string[]) => desktop(shim, ada.directory, args);
      const bobRun = (args: string[]) => desktop(shim, bob.directory, args);

      const adaSentence = "Ada writes 4419.";
      const bobSentence = "Bob writes 8821.";
      const [adaText, bobText] = await Promise.all([
        writeNote(adaRun, ada.directory, adaSentence),
        writeNote(bobRun, bob.directory, bobSentence),
      ]);
      expect(adaText).toContain(adaSentence);
      expect(adaText).not.toContain(bobSentence);
      expect(bobText).toContain(bobSentence);
      expect(bobText).not.toContain(adaSentence);

      const shot = await adaRun(["screenshot"]);
      expect(shot.code, shot.stderr).toBe(0);
      expect(shot.stdout).toContain("vision subagent");
      const saved = shot.stdout
        .split("\n")
        .find((line) => line.includes("saved at"))
        ?.split("saved at ")[1]
        ?.trim();
      expect(saved).toBeDefined();
      expect(
        readFileSync(saved ?? "")
          .subarray(0, 8)
          .toString("hex"),
      ).toBe("89504e470d0a1a0a");

      const state = JSON.parse(
        readFileSync(join(directory, "desktop", "host.json"), "utf8"),
      ) as { processes: Array<{ pid: number }> };
      const pids = state.processes.map((entry) => entry.pid);
      expect(pids.length).toBeGreaterThan(0);

      await daemon.close();
      for (const pid of pids) {
        let gone = false;
        try {
          process.kill(pid, 0);
        } catch {
          gone = true;
        }
        expect(gone).toBe(true);
      }
    } finally {
      await daemon.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  180_000,
);

test.skipIf(!installed)(
  "a new desktop host stops apps a crashed daemon left behind",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "companion-desktop-reap-"));
    const display = createDisplayHost({
      directory: join(directory, "display"),
    });
    const bot = join(directory, "bot");
    const first = createDesktopHost({
      directory: join(directory, "desktop"),
      display,
    });
    try {
      const window = await first.launch("bot-a", "mousepad", undefined, bot);
      expect(alive(window.pid)).toBe(true);
      // The host is abandoned the way a crashed daemon is: no close.
      const second = createDesktopHost({
        directory: join(directory, "desktop"),
        display,
      });
      await second.lease("bot-a");
      expect(alive(window.pid)).toBe(false);
      await second.close();
    } finally {
      await display.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(!installed || !calculator)(
  "a bot can open the calculator",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "companion-desktop-calc-"));
    const daemon = await startDaemon(options(directory));
    try {
      const ada = await createBot(daemon, "Ada");
      installDesktopShim(join(directory, "bin"));
      const opened = JSON.parse(
        await ok(
          desktop(join(directory, "bin", "desktop"), ada.directory, [
            "launch",
            "galculator",
          ]),
        ),
      ) as { app: string; windowId: string };
      expect(opened.app).toBe("galculator");
      expect(opened.windowId.length).toBeGreaterThan(0);
    } finally {
      await daemon.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

function options(directory: string) {
  return {
    storePath: join(directory, "threads.db"),
    engine: quietEngine(),
  };
}

/** An engine that answers every turn with nothing, so a bot can be created. */
function quietEngine(): Engine {
  const done: acp.StopReason = "end_turn";
  return {
    async prompt() {
      return done;
    },
    async close() {},
  };
}

async function createBot(daemon: Daemon, name: string): Promise<BotView> {
  const response = await fetch(`${daemon.url}/bots`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return (await response.json()) as BotView;
}

type Result = { code: number; stdout: string; stderr: string };

/** Runs the `desktop` command as a bot would, from inside its folder. */
function desktop(shim: string, cwd: string, args: string[]): Promise<Result> {
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

/**
 * Types into a Mousepad window the way a bot would, and returns the window
 * text afterwards. The sentence is what proves the windows stayed apart.
 */
async function writeNote(
  run: (args: string[]) => Promise<Result>,
  directory: string,
  sentence: string,
): Promise<string> {
  writeFileSync(join(directory, "note.txt"), "");
  const opened = JSON.parse(
    await ok(run(["launch", "mousepad", "note.txt"])),
  ) as {
    windowId: string;
  };
  const id = opened.windowId;
  const text = await ok(
    run(["snapshot", "--window-id", id, "-i", "--compact"]),
  );
  await ok(
    run([
      "set-value",
      "--window-id",
      id,
      ref(text, "textfield", undefined),
      sentence,
    ]),
  );
  return ok(run(["snapshot", "--window-id", id]));
}

/** The ref for the first element whose role and name match. */
function ref(output: string, role: string, name: string | undefined): string {
  const parsed = JSON.parse(output.slice(output.indexOf("{"))) as {
    data?: { tree?: unknown };
  };
  const found: Array<{ role?: string; name?: string; ref?: string }> = [];
  const walk = (node: unknown) => {
    if (typeof node !== "object" || node === null) return;
    const record = node as {
      role?: string;
      name?: string;
      ref_id?: string;
      children?: unknown[];
    };
    if (typeof record.ref_id === "string") {
      found.push({ role: record.role, name: record.name, ref: record.ref_id });
    }
    for (const child of record.children ?? []) walk(child);
  };
  walk(parsed.data?.tree);
  const match = found.find(
    (entry) =>
      (entry.role ?? "").includes(role) &&
      (name === undefined || entry.name === name),
  );
  if (match?.ref === undefined) {
    throw new Error(`No ${role} in ${output.slice(0, 500)}`);
  }
  return match.ref;
}

async function ok(resultPromise: Promise<Result>): Promise<string> {
  const finished = await resultPromise;
  expect(finished.code, `${finished.stdout}\n${finished.stderr}`).toBe(0);
  return finished.stdout;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
