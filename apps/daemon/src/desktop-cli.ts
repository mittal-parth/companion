/**
 * The `desktop` command a bot runs to drive an application that is not a web page.
 *
 * It is agent-desktop pointed at the shared screen, limited to the windows this
 * bot opened. One lock covers the whole desktop, so two bots cannot type at the
 * same time. Commands and flags that would reach another bot's windows, the
 * pointer, or the shared clipboard are refused. Web pages stay on `browser`.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  DesktopLease,
  DesktopSession,
  DesktopWindow,
} from "@companion/shared";
// A `.ts` specifier, because Node runs this file directly when a bot types `desktop`.
import { readAccess } from "./schedule-cli.ts";

const usage = `desktop launch form
desktop launch mousepad [file]
desktop windows
desktop close [window-id]
desktop <command> [arguments]
Drives an application on the shared screen. The commands are agent-desktop's.
Run "desktop skills get desktop" first for the workflow, then snapshot, act, and snapshot again.`;

/** Commands that never touch the screen, so they run as given. */
const offlineCommands = new Set([
  "skills",
  "help",
  "--help",
  "-h",
  "--version",
  "-V",
  "version",
]);

/** Flags that would move the pointer, change the screen, or leave this bot's session. */
const blockedFlags = new Set([
  "--headed",
  "--session",
  "--agent-id",
  "--trace",
  "--trace-strict",
  "--screen",
  "--cdp",
  "--env",
  "--cwd",
  "--arg",
  "--no-attach",
  "--force",
  "--debug",
]);

/**
 * Commands that act on the whole desktop, or that this command replaces.
 * `launch` and `close` here are agent-desktop's. This command handles its own
 * `launch` and `close` before this list is consulted.
 */
const blockedCommands = new Set([
  "launch",
  "close-app",
  "clipboard-get",
  "clipboard-set",
  "clipboard-clear",
  "key-down",
  "key-up",
  "mouse-down",
  "mouse-up",
  "hover",
  "drag",
  "mouse-move",
  "mouse-click",
  "mouse-wheel",
  "double-click",
  "triple-click",
  "open-system-surface",
  "list-notifications",
  "dismiss-notification",
  "dismiss-all-notifications",
  "sandbox",
  "mcp",
  "session",
  "trace",
  "cursor-overlay",
  "batch",
  "permissions",
]);

/**
 * Commands that take `--window-id`. Ref actions do not: the ref already names
 * an element from this bot's snapshot, and the flag is rejected there.
 */
const scopedCommands = new Set([
  "snapshot",
  "find",
  "screenshot",
  "press",
  "focus-window",
  "resize-window",
  "move-window",
  "minimize",
  "maximize",
  "restore",
  "list-surfaces",
]);

/** Flags that take the next argument, so that argument is not a command or a path. */
const valueFlags = new Set([
  "--app",
  "--window-id",
  "--max-depth",
  "--screenshot",
  "--session",
  "--agent-id",
  "--trace",
  "--surface",
  "--root",
  "--wait-for",
  "-w",
  "--timeout-ms",
  "--wait-for-gone",
  "--wait-timeout",
  "--screen",
  "--direction",
  "--amount",
  "--timeout",
  "--arg",
  "--env",
  "--cwd",
]);

/** How long a command waits while another bot is using the desktop. */
const lockWaitMs = 300_000;

/** A lock older than this was left by a command that died. */
const lockStaleMs = 600_000;

/** What `runDesktopCli` needs from outside, so a test can stand in for each. */
export type DesktopCliContext = {
  cwd: string;
  fetch: typeof fetch;
  /**
   * Runs agent-desktop with these arguments. A quiet run keeps its output and
   * returns it, and a normal run passes it straight to the bot.
   */
  run(
    args: string[],
    options?: { quiet?: boolean; env?: NodeJS.ProcessEnv },
  ): Promise<{ code: number; output: string }>;
  print(text: string): void;
  printError(text: string): void;
};

/**
 * Runs one `desktop` command.
 * Returns agent-desktop's exit code, or 1 when this command refuses or cannot
 * reach the daemon.
 */
export async function runDesktopCli(
  argv: string[],
  context: DesktopCliContext,
): Promise<number> {
  const [first] = argv;
  if (first === undefined) {
    context.printError(`${usage}\n`);
    return 1;
  }
  if (offlineCommands.has(first)) return (await context.run(argv)).code;

  const ownCommand =
    first === "launch" || first === "close" || first === "windows";
  if (!ownCommand) {
    const refusal = refusalFor(argv);
    if (refusal !== undefined) {
      context.printError(`${refusal}\n`);
      return 1;
    }
  }

  const access = readAccess(context.cwd);
  if (!access.ok) {
    context.printError(`${access.error}\n`);
    return 1;
  }

  let session: DesktopSession;
  try {
    session = await requestSession(context, access.access);
  } catch (error) {
    context.printError(`${messageOf(error)}\n`);
    return 1;
  }

  let release: () => void;
  try {
    release = await takeLock(session.lockPath);
  } catch (error) {
    context.printError(`${messageOf(error)}\n`);
    return 1;
  }
  try {
    if (first === "launch") return await launch(argv.slice(1), context, access);
    if (first === "close")
      return await closeApps(argv.slice(1), context, access);
    const lease = await requestLease(context, access.access);
    if (first === "windows") {
      context.print(`${JSON.stringify(shown(lease.windows))}\n`);
      return 0;
    }
    return await runTool(argv, lease, access.folder, context);
  } catch (error) {
    context.printError(`${messageOf(error)}\n`);
    return 1;
  } finally {
    release();
  }
}

/** Says why a command may not run, or nothing when it may. */
function refusalFor(argv: string[]): string | undefined {
  for (const token of argv) {
    const flag = token.split("=")[0] ?? token;
    if (blockedFlags.has(flag)) {
      return flag === "--headed"
        ? "--headed moves the pointer, which every bot shares, so it is not available. Act on a ref from your snapshot instead."
        : `${flag} is set for you. Your screen, session and windows are chosen by this command.`;
    }
  }
  const command = commandOf(argv).command;
  if (command === "close-app") {
    return 'Use "desktop close" to close a window you opened.';
  }
  if (command.startsWith("clipboard")) {
    return "The clipboard is shared by every bot, so it is not available.";
  }
  if (blockedCommands.has(command)) {
    return command === "launch"
      ? 'Use "desktop launch form" or "desktop launch mousepad" to start an app.'
      : `"${command}" is not available here. It would affect the whole desktop.`;
  }
  return undefined;
}

type Parsed = {
  command: string;
  windowId?: string;
  app?: string;
  positionals: string[];
};

/** Splits a command line into the command, the window it names, and its other arguments. */
function commandOf(argv: string[]): Parsed {
  let command = "";
  let windowId: string | undefined;
  let app: string | undefined;
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    const flag = token.split("=")[0] ?? token;
    if (token.startsWith("-")) {
      const value = token.includes("=")
        ? token.slice(token.indexOf("=") + 1)
        : valueFlags.has(flag)
          ? argv[++index]
          : undefined;
      if (flag === "--window-id" && value !== undefined) windowId = value;
      if (flag === "--app" && value !== undefined) app = value;
      continue;
    }
    if (command === "") command = token;
    else positionals.push(token);
  }
  return { command, windowId, app, positionals };
}

/**
 * Pins a command to one of this bot's windows and to its snapshot session.
 * Refuses a window or app that belongs to someone else.
 */
function scopeArgs(
  argv: string[],
  lease: DesktopLease,
): { args: string[]; windowId?: string } | { error: string } {
  const parsed = commandOf(argv);
  const owned = (windowId: string) =>
    lease.windows.some((window) => window.windowId === windowId);
  if (parsed.windowId !== undefined && !owned(parsed.windowId)) {
    return {
      error: `That window is not yours.\n${windowList(lease.windows)}`,
    };
  }
  if (parsed.app !== undefined) {
    const matches = lease.windows.filter(
      (window) => window.app === parsed.app || window.toolApp === parsed.app,
    );
    if (matches.length === 0) {
      return {
        error: `That app is not one of yours.\n${windowList(lease.windows)}`,
      };
    }
  }
  const needsWindow = scopedCommands.has(parsed.command);
  let windowId = parsed.windowId;
  if (windowId === undefined && needsWindow) {
    const matches =
      parsed.app === undefined
        ? lease.windows
        : lease.windows.filter(
            (window) =>
              window.app === parsed.app || window.toolApp === parsed.app,
          );
    const only = matches.length === 1 ? matches[0] : undefined;
    if (only !== undefined) windowId = only.windowId;
    else if (matches.length === 0) {
      return {
        error:
          "You have no window yet. Start one with desktop launch form or desktop launch mousepad.",
      };
    } else {
      return {
        error: `Name the window with --window-id.\n${windowList(matches)}`,
      };
    }
  }
  // A ref action rejects --window-id. The window was already checked above.
  const forwarded = needsWindow
    ? withoutApp(argv)
    : withoutApp(withoutFlag(argv, "--window-id"));
  const args = ["--session", lease.session, ...forwarded];
  if (needsWindow && windowId !== undefined && parsed.windowId === undefined) {
    const at = args.findIndex((token) => token === parsed.command);
    args.splice(at + 1, 0, "--window-id", windowId);
  }
  return { args, windowId };
}

/** Drops one flag and the value that follows it. */
function withoutFlag(argv: string[], flag: string): string[] {
  const kept: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    const name = token.split("=")[0] ?? token;
    if (name === flag) {
      if (!token.includes("=")) index += 1;
      continue;
    }
    kept.push(token);
  }
  return kept;
}

/** Drops positional arguments, leaving the command and its flags. */
function dropPositionals(
  args: string[],
  positionals: readonly string[],
): string[] {
  const drop = [...positionals];
  const kept: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? "";
    const flag = token.split("=")[0] ?? token;
    if (token.startsWith("-")) {
      kept.push(token);
      if (!token.includes("=") && valueFlags.has(flag)) {
        const value = args[index + 1];
        if (value !== undefined) kept.push(value);
        index += 1;
      }
      continue;
    }
    const at = drop.indexOf(token);
    if (at >= 0) {
      drop.splice(at, 1);
      continue;
    }
    kept.push(token);
  }
  return kept;
}

/** Drops `--app`, because a window id already says which window and the tool's app name differs from ours. */
function withoutApp(argv: string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    const flag = token.split("=")[0] ?? token;
    if (flag === "--app") {
      if (!token.includes("=")) index += 1;
      continue;
    }
    kept.push(token);
  }
  return kept;
}

function windowList(windows: readonly DesktopWindow[]): string {
  if (windows.length === 0) {
    return "You have no windows. Start one with desktop launch form or desktop launch mousepad.";
  }
  return windows
    .map((window) => `${window.windowId}  ${window.app}  ${window.title}`)
    .join("\n");
}

function shown(windows: readonly DesktopWindow[]) {
  return windows.map((window) => ({
    windowId: window.windowId,
    app: window.app,
    title: window.title,
  }));
}

/** Starts an allow-listed app and prints the window the bot should use. */
async function launch(
  argv: string[],
  context: DesktopCliContext,
  access: { access: { url: string; token: string }; folder: string },
): Promise<number> {
  const [app, file, extra] = argv;
  if (app === undefined || extra !== undefined) {
    context.printError(
      "Usage: desktop launch form   or   desktop launch mousepad [file]\n",
    );
    return 1;
  }
  if (app !== "form" && app !== "mousepad") {
    context.printError(
      "desktop launch only starts form or mousepad.\nUsage: desktop launch form   or   desktop launch mousepad [file]\n",
    );
    return 1;
  }
  if (file !== undefined && fileInside(access.folder, file) === undefined) {
    context.printError("That file is outside your folder.\n");
    return 1;
  }
  const body = (await postDesktop(
    context,
    access.access,
    "/launch",
    file === undefined ? { app } : { app, file },
  )) as Partial<DesktopWindow>;
  if (typeof body.windowId !== "string" || typeof body.app !== "string") {
    throw new Error("The daemon sent an unexpected launch answer.");
  }
  context.print(
    `${JSON.stringify({ windowId: body.windowId, app: body.app, title: body.title ?? "" })}\n`,
  );
  context.printError(
    "Take a snapshot of that window, act on the refs, then snapshot again.\n",
  );
  return 0;
}

/** Closes one of this bot's windows, or all of them. */
async function closeApps(
  argv: string[],
  context: DesktopCliContext,
  access: { access: { url: string; token: string } },
): Promise<number> {
  const [windowId, extra] = argv;
  if (extra !== undefined) {
    context.printError("Usage: desktop close [window-id]\n");
    return 1;
  }
  await postDesktop(
    context,
    access.access,
    "/close",
    windowId === undefined ? {} : { windowId },
  );
  context.print("Closed.\n");
  return 0;
}

/** Runs one agent-desktop command against this bot's windows. */
async function runTool(
  argv: string[],
  lease: DesktopLease,
  folder: string,
  context: DesktopCliContext,
): Promise<number> {
  const scoped = scopeArgs(argv, lease);
  if ("error" in scoped) {
    context.printError(`${scoped.error}\n`);
    return 1;
  }
  const env = {
    ...process.env,
    DISPLAY: lease.display,
    DBUS_SESSION_BUS_ADDRESS: lease.dbusAddress,
  };
  const command = commandOf(argv).command;
  if (
    (command === "screenshot" || command === "press") &&
    scoped.windowId !== undefined
  ) {
    // A covered window cannot be captured, and a key reaches whichever window
    // is in front. Raising this bot's window first is safe because the desktop
    // lock is held.
    await context.run(
      [
        "--session",
        lease.session,
        "focus-window",
        "--window-id",
        scoped.windowId,
      ],
      { quiet: true, env },
    );
  }
  if (command === "screenshot") {
    const requested = commandOf(argv).positionals[0];
    const path = screenshotPath(folder, requested);
    if (path === undefined) {
      context.printError("That screenshot path is outside your folder.\n");
      return 1;
    }
    mkdirSync(dirname(path), { recursive: true });
    const result = await context.run(
      [...dropPositionals(scoped.args, commandOf(argv).positionals), path],
      { env },
    );
    if (result.code === 0) {
      context.print(
        `The screenshot is saved at ${path}\nAsk the vision subagent to read that file and answer the question. Do not read the image yourself.\n`,
      );
    }
    return result.code;
  }
  if (command === "list-windows" || command === "list-apps") {
    const result = await context.run(scoped.args, { quiet: true, env });
    context.print(
      result.code === 0
        ? `${filterOwned(result.output, command, lease.windows)}\n`
        : result.output,
    );
    return result.code;
  }
  return (await context.run(scoped.args, { env })).code;
}

/**
 * Where a screenshot is written.
 * An explicit path has to stay in the bot's folder. Otherwise the file goes
 * next to the images the vision subagent already reads.
 */
function screenshotPath(
  folder: string,
  requested: string | undefined,
): string | undefined {
  if (requested !== undefined) return fileInside(folder, requested);
  return join(dirname(folder), "images", `${randomUUID()}.png`);
}

/** Resolves `file` against the bot's folder, or nothing when it would escape. */
function fileInside(folder: string, file: string): string | undefined {
  const root = resolve(dirname(folder));
  const target = resolve(root, file);
  if (target !== root && !target.startsWith(root + sep)) return undefined;
  return target;
}

/** Hides windows and apps this bot did not open. */
function filterOwned(
  output: string,
  command: "list-windows" | "list-apps",
  windows: readonly DesktopWindow[],
): string {
  let parsed: {
    ok?: unknown;
    data?: { apps?: Array<{ pid?: number }> } | Array<{ pid?: number }>;
  };
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    return output;
  }
  if (parsed.ok !== true) return output;
  const pids = new Set(windows.map((window) => window.pid));
  if (command === "list-windows" && Array.isArray(parsed.data)) {
    parsed.data = parsed.data.filter(
      (window) => window.pid !== undefined && pids.has(window.pid),
    );
  }
  if (
    command === "list-apps" &&
    !Array.isArray(parsed.data) &&
    Array.isArray(parsed.data?.apps)
  ) {
    parsed.data.apps = parsed.data.apps.filter(
      (app) => app.pid !== undefined && pids.has(app.pid),
    );
  }
  return JSON.stringify(parsed);
}

/** Posts to one of the daemon's desktop routes as this bot and returns the JSON answer. */
async function postDesktop(
  context: DesktopCliContext,
  access: { url: string; token: string },
  path: string,
  body?: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await context.fetch(`${access.url}/agent/desktop${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${access.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error("The daemon is not reachable.");
  }
  if (!response.ok) {
    let detail = `The daemon returned ${response.status}.`;
    try {
      const payload = (await response.json()) as { error?: unknown };
      if (typeof payload.error === "string") detail = payload.error;
    } catch {
      // The body was not JSON. Keep the status.
    }
    throw new Error(detail);
  }
  return response.json();
}

async function requestSession(
  context: DesktopCliContext,
  access: { url: string; token: string },
): Promise<DesktopSession> {
  const body = (await postDesktop(
    context,
    access,
    "/session",
  )) as Partial<DesktopSession>;
  if (!isSession(body)) {
    throw new Error("The daemon sent an unexpected desktop answer.");
  }
  return body;
}

async function requestLease(
  context: DesktopCliContext,
  access: { url: string; token: string },
): Promise<DesktopLease> {
  const body = (await postDesktop(
    context,
    access,
    "",
  )) as Partial<DesktopLease>;
  const raw: unknown = body.windows;
  if (!isSession(body) || !Array.isArray(raw)) {
    throw new Error("The daemon sent an unexpected desktop answer.");
  }
  const windows = raw.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const window = entry as Partial<DesktopWindow>;
    if (
      typeof window.windowId !== "string" ||
      typeof window.app !== "string" ||
      typeof window.toolApp !== "string" ||
      typeof window.pid !== "number" ||
      typeof window.title !== "string"
    ) {
      return [];
    }
    return [
      {
        windowId: window.windowId,
        app: window.app,
        toolApp: window.toolApp,
        pid: window.pid,
        title: window.title,
      },
    ];
  });
  return { ...body, windows };
}

function isSession(body: Partial<DesktopSession>): body is DesktopSession {
  return (
    typeof body.display === "string" &&
    typeof body.dbusAddress === "string" &&
    typeof body.generation === "string" &&
    typeof body.session === "string" &&
    typeof body.lockPath === "string"
  );
}

/**
 * Waits while another bot's command holds the desktop, then takes the lock.
 * A lock whose command died, or that is very old, is taken over.
 */
async function takeLock(path: string): Promise<() => void> {
  const deadline = Date.now() + lockWaitMs;
  for (;;) {
    try {
      mkdirSync(path);
      writeFileSync(join(path, "pid"), String(process.pid));
      return () => {
        rmSync(path, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (lockIsStale(path)) {
      rmSync(path, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(
        "Another bot is using the desktop. Wait, then try again.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function lockIsStale(path: string): boolean {
  try {
    const pid = Number(readFileSync(join(path, "pid"), "utf8"));
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      }
    }
    return Date.now() - statSync(path).mtimeMs > lockStaleMs;
  } catch {
    return !existsSync(path);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "The command failed.";
}

/** Runs the agent-desktop that ships with the daemon. */
function runAgentDesktop(
  args: string[],
  options?: { quiet?: boolean; env?: NodeJS.ProcessEnv },
): Promise<{ code: number; output: string }> {
  const bin = join(
    dirname(fileURLToPath(import.meta.resolve("agent-desktop/package.json"))),
    "bin",
    "agent-desktop",
  );
  return new Promise((resolveRun) => {
    const child = spawn(bin, args, {
      stdio: options?.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
      env: options?.env ?? process.env,
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.once("error", (error) => {
      resolveRun({ code: 1, output: error.message });
    });
    child.once("exit", (code) => {
      resolveRun({ code: code ?? 1, output: output.trim() });
    });
  });
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const cwd = process.cwd();
  process.exitCode = await runDesktopCli(process.argv.slice(2), {
    cwd,
    fetch,
    run: (args, options) => runAgentDesktop(args, options),
    print: (text) => process.stdout.write(text),
    printError: (text) => process.stderr.write(text),
  });
}
