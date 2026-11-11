/**
 * Compares agent-desktop with xdotool plus screenshots by giving a real bot
 * the same two tasks with each tool, several times, and recording what happened.
 * The bot, the model, the windows and the wording are the same. Only the tool
 * changes.
 *
 * It is a measurement, not a pass/fail check: a bot that fails a task is a
 * result. Skipped unless COMPANION_COMPARE=1. Results go to the JSON file named
 * by COMPARE_OUT, or the system temp folder, after every attempt.
 * COMPARE_RUNS (default 3) and COMPARE_TOOLS (default both) narrow the run.
 */
import { execFile } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "vitest";
import { startDaemon, type Daemon } from "../src/api.js";
import { createBrowserHost } from "../src/browser.js";
import { createDesktopHost } from "../src/desktop.js";
import { createDisplayHost, type DisplayEndpoint } from "../src/display.js";
import {
  askBot,
  createLiveBot,
  opencodeBin,
  requireOpencode,
  type LiveTurn,
} from "./helpers.js";

type Tool = "agent-desktop" | "xdotool";
type TaskName = "form" | "note";

type Attempt = {
  tool: Tool;
  task: TaskName;
  run: number;
  passed: boolean;
  missing: string[];
  toolCalls: number;
  /** The largest context the model reported, a stand-in for tokens used. */
  contextTokens: number;
  seconds: number;
  error?: string;
  reply: string;
};

const compare = process.env.COMPANION_COMPARE === "1";
const runs = Number(process.env.COMPARE_RUNS ?? "3");
const tools = (process.env.COMPARE_TOOLS ?? "agent-desktop,xdotool")
  .split(",")
  .map((name) => name.trim()) as Tool[];
const tasks = (process.env.COMPARE_TASKS ?? "form,note")
  .split(",")
  .map((name) => name.trim()) as TaskName[];
const resultsFile =
  process.env.COMPARE_OUT ?? join(tmpdir(), "desktop-compare.json");
const noteSentence = "The oak code is 4419.";
const desktopBin = join(
  dirname(fileURLToPath(import.meta.resolve("agent-desktop/package.json"))),
  "bin",
  "agent-desktop",
);

const attempts: Attempt[] = [];

test.skipIf(!compare)(
  "measure agent-desktop and xdotool on the same desktop tasks",
  async () => {
    requireOpencode();
    console.log(
      `compare matrix tools=${tools.join(",")} tasks=${tasks.join(",")} runs=${runs}`,
    );
    await measureSnapshot();
    for (const tool of tools) {
      for (const task of tasks) {
        for (let run = 1; run <= runs; run += 1) {
          attempts.push(await attempt(tool, task, run));
          writeFileSync(resultsFile, JSON.stringify(attempts, null, 2));
        }
      }
    }
  },
  4 * 60 * 60 * 1000,
);

/** One attempt: a fresh screen, window, daemon and bot. */
async function attempt(
  tool: Tool,
  task: TaskName,
  run: number,
): Promise<Attempt> {
  const started = Date.now();
  const directory = mkdtempSync(join(tmpdir(), "companion-desktop-compare-"));
  const display = createDisplayHost({ directory: join(directory, "display") });
  const desktop = createDesktopHost({
    directory: join(directory, "desktop"),
    display,
  });
  const browser = createBrowserHost({
    directory: join(directory, "browser"),
    display,
  });
  let daemon: Daemon | undefined;
  const turns: LiveTurn[] = [];
  let missing: string[] = [];
  let error: string | undefined;
  const target = join(directory, "target");
  mkdirSync(target, { recursive: true });
  if (task === "note") writeFileSync(join(target, "oak-note.txt"), "");
  try {
    const screen = await display.endpoint();
    const opened =
      task === "form"
        ? await desktop.launch("compare", "form", undefined, target)
        : await desktop.launch(
            "compare",
            "mousepad",
            join(target, "oak-note.txt"),
            target,
          );
    daemon = await startDaemon({
      storePath: join(directory, "threads.db"),
      opencodeBin,
      browser,
      desktop,
      display,
    });
    installWrappers(join(directory, "bin"), screen);
    const bot = await createLiveBot(daemon, "Compare");
    const turn = await askBot(
      daemon,
      bot.id,
      promptFor(tool, task, opened.windowId),
    );
    turns.push(turn);
    missing = await missingPieces(
      task,
      target,
      screen,
      opened.windowId,
      turn.reply,
    );
  } catch (caught) {
    error = caught instanceof Error ? caught.message.slice(0, 500) : "failed";
    if (missing.length === 0) missing = ["the task did not finish"];
  } finally {
    await daemon?.close();
    await desktop.close();
    await browser.close();
    await display.close();
    rmSync(directory, { recursive: true, force: true });
  }
  return {
    tool,
    task,
    run,
    passed: missing.length === 0,
    missing,
    toolCalls: turns.reduce(
      (total, turn) =>
        total +
        turn.updates.filter((update) => update.sessionUpdate === "tool_call")
          .length,
      0,
    ),
    contextTokens: Math.max(
      0,
      ...turns.flatMap((turn) =>
        turn.updates.flatMap((update) =>
          update.sessionUpdate === "usage_update" ? [update.used] : [],
        ),
      ),
    ),
    seconds: Math.round((Date.now() - started) / 1000),
    ...(error === undefined ? {} : { error }),
    reply: turns
      .map((turn) => turn.reply)
      .join("\n")
      .slice(0, 600),
  };
}

function promptFor(tool: Tool, task: TaskName, windowId: string): string {
  const job =
    task === "form"
      ? "A window titled Companion form is already open. Enter the name Priya Nair, accept the terms, and submit. The form rejects a submit until the terms are accepted. Reply with the confirmation code the window shows."
      : `A Mousepad window is already open. Type exactly this sentence into the document: ${noteSentence} Do not write the file with a file tool or the shell. Reply with the sentence once it is in the editor.`;
  switch (tool) {
    case "agent-desktop":
      return `Use only the ad command for this. It is agent-desktop. Do not use the desktop command, xdotool, or scrot. Run ad skills get desktop first. The window id is ${windowId}. Put --window-id ${windowId} on snapshot, find, screenshot, press and focus-window. Commands that take a ref reject --window-id, so leave it off those. ${job}`;
    case "xdotool":
      return `Use only xd and shot for this. xd is xdotool and shot saves a PNG of the screen. Do not use the desktop command or agent-desktop. Find the window with xd search --name ${task === "form" ? "Companion" : "oak-note"}. Activate it with xd windowactivate --sync before you type. shot FILE.png prints a path: ask the vision subagent to read that file and say what is on screen. Do not read the image yourself. Type with xd type --window ID, and use xd key for Tab, space and Return. ${job}`;
    default: {
      const unexpected: never = tool;
      throw new Error(`Unknown tool ${String(unexpected)}.`);
    }
  }
}

/** What the window itself shows, which a made-up reply will not match. */
async function missingPieces(
  task: TaskName,
  target: string,
  screen: DisplayEndpoint,
  windowId: string,
  reply: string,
): Promise<string[]> {
  switch (task) {
    case "form": {
      let saved: { code?: string; name?: string } = {};
      try {
        saved = JSON.parse(
          readFileSync(join(target, ".companion", "desktop-form.json"), "utf8"),
        ) as { code?: string; name?: string };
      } catch {
        return ["the form wrote no confirmation"];
      }
      const missing: string[] = [];
      if (saved.name !== "Priya Nair") missing.push("name");
      if (saved.code === undefined || !reply.includes(saved.code)) {
        missing.push(saved.code ?? "code");
      }
      return missing;
    }
    case "note": {
      const text = await toolText(screen, [
        "snapshot",
        "--window-id",
        windowId,
      ]);
      const missing: string[] = [];
      if (!text.includes(noteSentence))
        missing.push("the editor does not contain the sentence");
      if (!reply.includes("4419")) missing.push("4419");
      return missing;
    }
    default: {
      const unexpected: never = task;
      throw new Error(`Unknown task ${String(unexpected)}.`);
    }
  }
}

/** How a snapshot compares with a screenshot of the same form, in characters. */
async function measureSnapshot(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "companion-desktop-size-"));
  const display = createDisplayHost({ directory: join(directory, "display") });
  const desktop = createDesktopHost({
    directory: join(directory, "desktop"),
    display,
  });
  try {
    const screen = await display.endpoint();
    const opened = await desktop.launch(
      "compare",
      "form",
      undefined,
      join(directory, "target"),
    );
    const snapshot = await toolText(screen, [
      "snapshot",
      "--window-id",
      opened.windowId,
      "-i",
      "--compact",
    ]);
    const shot = join(directory, "shot.png");
    await toolText(screen, ["focus-window", "--window-id", opened.windowId]);
    await toolText(screen, [
      "screenshot",
      "--window-id",
      opened.windowId,
      shot,
    ]);
    writeFileSync(
      `${resultsFile}.sizes.json`,
      JSON.stringify(
        {
          snapshotChars: snapshot.length,
          screenshotBytes: statSync(shot).size,
        },
        null,
        2,
      ),
    );
  } finally {
    await desktop.close();
    await display.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function installWrappers(binDir: string, screen: DisplayEndpoint): void {
  mkdirSync(binDir, { recursive: true });
  const env = `export DISPLAY='${screen.display}'\nexport DBUS_SESSION_BUS_ADDRESS='${screen.dbusAddress}'\n`;
  writeFileSync(
    join(binDir, "ad"),
    `#!/bin/sh\n${env}exec "${desktopBin}" "$@"\n`,
  );
  writeFileSync(
    join(binDir, "xd"),
    `#!/bin/sh\nexport DISPLAY='${screen.display}'\nexec xdotool "$@"\n`,
  );
  writeFileSync(
    join(binDir, "shot"),
    `#!/bin/sh\nexport DISPLAY='${screen.display}'\nif [ -z "$1" ]; then echo "usage: shot file.png" >&2; exit 1; fi\nscrot -o "$1"\necho "The screenshot is saved at $1"\necho "Ask the vision subagent to read that file and answer the question. Do not read the image yourself."\n`,
  );
  for (const name of ["ad", "xd", "shot"]) chmodSync(join(binDir, name), 0o755);
}

/** Runs agent-desktop on the screen and returns what it printed. */
async function toolText(
  screen: DisplayEndpoint,
  args: string[],
): Promise<string> {
  const run = promisify(execFile);
  const result = await run(desktopBin, args, {
    env: {
      ...process.env,
      DISPLAY: screen.display,
      DBUS_SESSION_BUS_ADDRESS: screen.dbusAddress,
    },
    timeout: 30_000,
    maxBuffer: 10_000_000,
  });
  return result.stdout;
}
