/**
 * The `browser` command a bot runs to drive the shared Chrome.
 *
 * It is agent-browser with the connection settings filled in. The daemon says
 * where Chrome listens and names the bot's session. This command points that
 * session at the bot's own window and pins it there, so two bots on one Chrome
 * never navigate each other's pages. Settings that would reach every bot, such
 * as clearing cookies or closing the browser, are refused. Commands of one bot
 * run one at a time, so a model that fires two at once cannot interleave them.
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BrowserLease } from "@companion/shared";
// A `.ts` specifier, because Node runs this file directly when a bot types `browser`.
import { readAccess } from "./schedule-cli.ts";

const usage = `browser <command> [arguments]
Drives your own window of the shared Chrome. The commands are agent-browser's.
Run "browser skills get core" first for the workflow and the full command list.`;

/** Commands that never touch Chrome, so they run as given. */
const offlineCommands = new Set([
  "skills",
  "help",
  "--help",
  "-h",
  "--version",
  "-V",
]);

/** Flags that would reroute the command away from this bot's window. */
const blockedFlags = new Set([
  "--session",
  "--cdp",
  "--profile",
  "--auto-connect",
  "--executable-path",
  "--args",
  "--extension",
  "--provider",
  "--engine",
  "--headed",
  "--namespace",
  "--pin-tab",
  "--no-pin-tab",
]);

/** Commands that act on every bot's browser, or that this command replaces. */
const blockedCommands = new Set([
  "connect",
  "close",
  "dashboard",
  "install",
  "upgrade",
  "mcp",
  "chat",
  "plugin",
]);

/** How long a command waits for the same bot's earlier command. */
const lockWaitMs = 300_000;

/** A lock older than this was left by a command that died. */
const lockStaleMs = 600_000;

/** What `runBrowserCli` needs from outside, so a test can stand in for each. */
export type BrowserCliContext = {
  cwd: string;
  fetch: typeof fetch;
  /**
   * Runs agent-browser with these arguments. A quiet run keeps its output and
   * returns it, and a normal run passes it straight to the bot.
   */
  run(
    args: string[],
    quiet?: boolean,
  ): Promise<{ code: number; output: string }>;
  printError(text: string): void;
};

/**
 * Runs one `browser` command.
 * Returns agent-browser's exit code, or 1 when this command refuses or cannot
 * reach the daemon.
 */
export async function runBrowserCli(
  argv: string[],
  context: BrowserCliContext,
): Promise<number> {
  const [first] = argv;
  if (first === undefined) {
    context.printError(`${usage}\n`);
    return 1;
  }
  if (offlineCommands.has(first)) return (await context.run(argv)).code;

  const refusal = refusalFor(argv);
  if (refusal !== undefined) {
    context.printError(`${refusal}\n`);
    return 1;
  }

  const access = readAccess(context.cwd);
  if (!access.ok) {
    context.printError(`${access.error}\n`);
    return 1;
  }
  mkdirSync(access.folder, { recursive: true });
  const release = await takeLock(join(access.folder, "browser.lock"));
  try {
    let lease: BrowserLease;
    try {
      lease = await requestLease(context, access.access);
    } catch (error) {
      context.printError(`${messageOf(error)}\n`);
      return 1;
    }
    const connection = [
      "--session",
      lease.session,
      "--cdp",
      String(lease.port),
      "--pin-tab",
    ];

    // The first command, a Chrome that started again, or a bot that asks for a
    // new window: open one and bind the session to it. The daemon opens it in
    // Chrome's own profile. agent-browser's own "window new" would use a
    // private one that shares no logins.
    const windowFile = join(access.folder, "browser-window.json");
    const asksForWindow = argv[0] === "window" && argv[1] === "new";
    if (asksForWindow || readGeneration(windowFile) !== lease.generation) {
      // Drops the session's old connection and its pin on a tab that is gone.
      await context.run(["--session", lease.session, "close"], true);
      let targetId: string;
      try {
        targetId = await requestWindow(context, access.access);
      } catch (error) {
        context.printError(`${messageOf(error)}\n`);
        return 1;
      }
      // Not pinned yet: a pinned session with no tab opens a spare blank one,
      // which would sit in front of this window's page and hide it.
      const bound = await context.run(
        [
          "--session",
          lease.session,
          "--cdp",
          String(lease.port),
          "tab",
          targetId,
        ],
        true,
      );
      if (bound.code !== 0) {
        context.printError(`${bound.output}\n`);
        return bound.code;
      }
      writeFileSync(
        windowFile,
        JSON.stringify({ generation: lease.generation }),
      );
      if (asksForWindow) {
        context.printError("Opened a new window for you.\n");
        return 0;
      }
    }
    return (await context.run([...connection, ...argv])).code;
  } finally {
    release();
  }
}

/** Says why a command may not run, or nothing when it may. */
function refusalFor(argv: string[]): string | undefined {
  for (const token of argv) {
    const flag = token.split("=")[0] ?? token;
    if (blockedFlags.has(flag)) {
      return `${flag} is set for you. Your session, window and Chrome are chosen by this command.`;
    }
  }
  const command = argv.find((token) => !token.startsWith("-")) ?? "";
  if (command === "close") {
    return 'Your window stays open between commands, so there is nothing to close. Use "browser tab close" for a tab you opened.';
  }
  if (blockedCommands.has(command)) {
    return `"${command}" is not available here. It would affect every bot's browser.`;
  }
  const rest = argv.slice(argv.indexOf(command) + 1);
  if (command === "cookies" && rest[0] === "clear") {
    return "Clearing cookies would sign out every bot, so it is not available.";
  }
  return undefined;
}

/** Posts to one of the daemon's browser routes as this bot and returns the JSON answer. */
async function postBrowser(
  context: BrowserCliContext,
  access: { url: string; token: string },
  path: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await context.fetch(`${access.url}/agent/browser${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${access.token}` },
    });
  } catch {
    throw new Error("The daemon is not reachable.");
  }
  if (!response.ok) {
    let detail = `The daemon returned ${response.status}.`;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string") detail = body.error;
    } catch {
      // The body was not JSON. Keep the status.
    }
    throw new Error(detail);
  }
  return response.json();
}

/** Asks the daemon for the window it opened for this bot, as a Chrome target id. */
async function requestWindow(
  context: BrowserCliContext,
  access: { url: string; token: string },
): Promise<string> {
  const body = (await postBrowser(context, access, "/window")) as {
    targetId?: unknown;
  };
  if (typeof body.targetId !== "string") {
    throw new Error("The daemon sent an unexpected window answer.");
  }
  return body.targetId;
}

/** Asks the daemon for the shared Chrome and this bot's session name. */
async function requestLease(
  context: BrowserCliContext,
  access: { url: string; token: string },
): Promise<BrowserLease> {
  const body = (await postBrowser(
    context,
    access,
    "",
  )) as Partial<BrowserLease>;
  if (
    typeof body.port !== "number" ||
    typeof body.generation !== "string" ||
    typeof body.session !== "string"
  ) {
    throw new Error("The daemon sent an unexpected browser answer.");
  }
  return {
    port: body.port,
    generation: body.generation,
    session: body.session,
  };
}

function readGeneration(file: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      generation?: unknown;
    };
    return typeof parsed.generation === "string"
      ? parsed.generation
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Waits for this bot's earlier command to finish, then holds the bot's lock.
 * A lock whose command died, or that is very old, is taken over. Returns the
 * function that gives the lock back.
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
      throw new Error("Another browser command of yours is still running.");
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
    // The lock vanished while it was being read, so it is free again.
    return !existsSync(path);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "The command failed.";
}

/** Runs the agent-browser that ships with the daemon. */
function runAgentBrowser(
  cwd: string,
  args: string[],
  quiet = false,
): Promise<{ code: number; output: string }> {
  const launcher = join(
    dirname(fileURLToPath(import.meta.resolve("agent-browser/package.json"))),
    "bin",
    "agent-browser.js",
  );
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [launcher, ...args], {
      cwd,
      stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
      // Skips a network check for a newer Chrome that prints a warning on every call.
      env: { ...process.env, AGENT_BROWSER_NO_VERSION_CHECK: "1" },
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.once("error", (error) => {
      resolve({ code: 1, output: error.message });
    });
    child.once("exit", (code) => {
      resolve({ code: code ?? 1, output: output.trim() });
    });
  });
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const cwd = process.cwd();
  process.exitCode = await runBrowserCli(process.argv.slice(2), {
    cwd,
    fetch,
    run: (args, quiet) => runAgentBrowser(cwd, args, quiet),
    printError: (text) => process.stderr.write(text),
  });
}
