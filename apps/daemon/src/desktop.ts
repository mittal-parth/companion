/**
 * Desktop apps for the bots, on the same screen as Chrome.
 *
 * A bot may start only the apps on a short list. Each launch is its own
 * process, recorded against that bot, and stopped when the bot closes it or
 * the daemon stops. Two bots therefore get two windows, and a crashed daemon's
 * apps are stopped on the next start.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DesktopLease,
  DesktopSession,
  DesktopWindow,
} from "@companion/shared";
import type { DisplayHost } from "./display.js";
import { reapLeftovers } from "./display.js";
import { exited, stopChild } from "./engine.js";

/** The apps a bot is allowed to start. Anything else would be a shell. */
export const desktopAppNames = ["form", "mousepad"] as const;

export type DesktopAppName = (typeof desktopAppNames)[number];

/** Starts and stops the apps a bot is allowed to use. */
export type DesktopHost = {
  /** Where the screen is and where the shared lock lives. Does not list windows. */
  session(botId: string): Promise<DesktopSession>;
  /** The calling bot's windows. Starts the screen on first use. */
  lease(botId: string): Promise<DesktopLease>;
  /**
   * Starts one allow-listed app for this bot.
   * `file` is a path inside the bot's folder, and only mousepad uses it.
   */
  launch(
    botId: string,
    app: string,
    file: string | undefined,
    botDirectory: string,
  ): Promise<DesktopWindow>;
  /** Stops one of this bot's windows, or all of them when no window is named. */
  closeApps(botId: string, windowId: string | undefined): Promise<void>;
  /** Stops every app this host started. The display keeps running. */
  close(): Promise<void>;
};

export type DesktopHostOptions = {
  /** Holds the lock, the app record and per-bot editor settings. */
  directory: string;
  display: DisplayHost;
};

type AppRecord = {
  botId: string;
  app: DesktopAppName;
  pid: number;
  child: ChildProcess;
};

type ListedWindow = {
  id: string;
  pid: number;
  title: string;
  app_name: string;
};

const windowWaitMs = 15_000;

/**
 * Creates the host. No app starts until `launch` is called, and the screen
 * starts on the first `session` or `lease`.
 */
export function createDesktopHost(options: DesktopHostOptions): DesktopHost {
  const stateFile = join(options.directory, "host.json");
  const formScript = fileURLToPath(
    new URL("../fixtures/desktop-form.py", import.meta.url),
  );
  let apps: AppRecord[] = [];
  let reaped = false;
  let generation: string | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let closed = false;

  /** One launch or listing at a time, so a new window is credited to the right bot. */
  function exclusive<T>(body: () => Promise<T>): Promise<T> {
    const run = tail.then(body, body);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function screen(): Promise<DesktopSession> {
    if (closed) throw new Error("The desktop host is closed.");
    if (!reaped) {
      reaped = true;
      await reapLeftovers(stateFile);
      apps = [];
    }
    mkdirSync(options.directory, { recursive: true });
    const endpoint = await options.display.endpoint();
    if (generation !== undefined && generation !== endpoint.generation) {
      apps = [];
      writeState();
    }
    generation = endpoint.generation;
    return {
      display: endpoint.display,
      dbusAddress: endpoint.dbusAddress,
      generation: endpoint.generation,
      session: "",
      lockPath: join(options.directory, "lock"),
    };
  }

  function sessionFor(botId: string, base: DesktopSession): DesktopSession {
    return { ...base, session: `bot-${botId.replace(/[^A-Za-z0-9-]/g, "-")}` };
  }

  function writeState(): void {
    writeFileSync(
      stateFile,
      JSON.stringify({
        processes: apps.map((app) => ({
          pid: app.pid,
          name: app.app === "form" ? "desktop-form.py" : "mousepad",
        })),
      }),
    );
  }

  function forget(pid: number): void {
    apps = apps.filter((app) => app.pid !== pid);
    writeState();
  }

  async function listWindows(base: DesktopSession): Promise<ListedWindow[]> {
    const result = await runDesktopTool(base, ["list-windows"]);
    let parsed: { ok?: unknown; data?: unknown; error?: { message?: unknown } };
    try {
      parsed = JSON.parse(result.output) as typeof parsed;
    } catch {
      throw new Error("The desktop did not list its windows.");
    }
    if (parsed.ok !== true || !Array.isArray(parsed.data)) {
      const message = parsed.error?.message;
      throw new Error(
        typeof message === "string"
          ? message
          : "The desktop did not list its windows.",
      );
    }
    return parsed.data.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const window = entry as Partial<ListedWindow>;
      if (
        typeof window.id !== "string" ||
        typeof window.pid !== "number" ||
        typeof window.title !== "string" ||
        typeof window.app_name !== "string"
      ) {
        return [];
      }
      return [
        {
          id: window.id,
          pid: window.pid,
          title: window.title,
          app_name: window.app_name,
        },
      ];
    });
  }

  function windowsFor(
    botId: string,
    listed: readonly ListedWindow[],
  ): DesktopWindow[] {
    return listed.flatMap((window) => {
      const owner = apps.find(
        (app) => app.botId === botId && app.pid === window.pid,
      );
      if (owner === undefined) return [];
      return [
        {
          windowId: window.id,
          app: owner.app,
          toolApp: window.app_name,
          pid: window.pid,
          title: window.title,
        },
      ];
    });
  }

  async function stopApp(app: AppRecord): Promise<void> {
    stopChild(app.child);
    await exited(app.child);
    forget(app.pid);
  }

  return {
    async session(botId) {
      return sessionFor(botId, await screen());
    },

    lease(botId) {
      return exclusive(async () => {
        const base = sessionFor(botId, await screen());
        apps = apps.filter((app) => alive(app.pid));
        writeState();
        const listed = await listWindows(base);
        return { ...base, windows: windowsFor(botId, listed) };
      });
    },

    launch(botId, app, file, botDirectory) {
      return exclusive(async () => {
        const name = desktopApp(app);
        if (name === "form" && file !== undefined) {
          throw new Error("desktop launch form takes no file.");
        }
        const opened =
          name === "mousepad" && file !== undefined
            ? fileInside(botDirectory, file)
            : undefined;
        const base = sessionFor(botId, await screen());
        const before = new Set(
          (await listWindows(base)).map((window) => window.id),
        );
        const child = spawnApp(name, {
          base,
          formScript,
          botId,
          botDirectory,
          directory: options.directory,
          file: opened,
        });
        const pid = child.pid;
        if (pid === undefined) {
          stopChild(child);
          throw new Error("The app did not start.");
        }
        apps.push({ botId, app: name, pid, child });
        writeState();
        try {
          const appeared = await waitForWindows(
            base,
            before,
            () => !alive(pid),
          );
          const owned = appeared.filter((window) => window.pid === pid);
          const windows = owned.length > 0 ? owned : appeared;
          const primary =
            windows.find((window) => window.title !== "Question") ?? windows[0];
          if (primary === undefined) {
            throw new Error("The app did not open a window.");
          }
          return {
            windowId: primary.id,
            app: name,
            toolApp: primary.app_name,
            pid,
            title: primary.title,
          };
        } catch (error) {
          await stopApp({ botId, app: name, pid, child });
          throw error;
        }
      });
    },

    closeApps(botId, windowId) {
      return exclusive(async () => {
        const base = sessionFor(botId, await screen());
        const listed = await listWindows(base).catch(() => []);
        const mine = apps.filter((app) => app.botId === botId);
        const targets =
          windowId === undefined
            ? mine
            : mine.filter((app) =>
                listed.some(
                  (window) => window.id === windowId && window.pid === app.pid,
                ),
              );
        if (windowId !== undefined && targets.length === 0) {
          throw new Error("That window is not yours.");
        }
        for (const app of targets) await stopApp(app);
      });
    },

    async close() {
      closed = true;
      await exclusive(async () => {
        for (const app of [...apps].reverse()) {
          stopChild(app.child);
          await exited(app.child);
        }
        apps = [];
        rmSync(stateFile, { force: true });
      });
    },
  };
}

function desktopApp(app: string): DesktopAppName {
  switch (app) {
    case "form":
    case "mousepad":
      return app;
    default:
      throw new Error("desktop launch only starts form or mousepad.");
  }
}

/** A path the bot asked for, refused when it leaves the bot's folder. */
function fileInside(botDirectory: string, file: string): string {
  const root = resolve(botDirectory);
  const target = resolve(botDirectory, file);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error("That file is outside your folder.");
  }
  return target;
}

function spawnApp(
  app: DesktopAppName,
  input: {
    base: DesktopSession;
    formScript: string;
    botId: string;
    botDirectory: string;
    directory: string;
    file: string | undefined;
  },
): ChildProcess {
  const env = {
    ...process.env,
    DISPLAY: input.base.display,
    DBUS_SESSION_BUS_ADDRESS: input.base.dbusAddress,
  };
  switch (app) {
    case "form": {
      const result = join(
        input.botDirectory,
        ".companion",
        "desktop-form.json",
      );
      mkdirSync(dirname(result), { recursive: true });
      rmSync(result, { force: true });
      return spawn("python3", [input.formScript, result, "Companion form"], {
        env,
        detached: true,
        stdio: "ignore",
      });
    }
    case "mousepad": {
      // A fresh config, so a crashed editor does not ask to restore a session,
      // and one bot's settings are not the other's.
      const configHome = join(input.directory, "mousepad", input.botId);
      mkdirSync(configHome, { recursive: true });
      return spawn(
        "mousepad",
        ["--disable-server", ...(input.file === undefined ? [] : [input.file])],
        {
          env: { ...env, XDG_CONFIG_HOME: configHome },
          detached: true,
          stdio: "ignore",
        },
      );
    }
    default: {
      const unexpected: never = app;
      throw new Error(`Unknown app ${String(unexpected)}.`);
    }
  }
}

/** Polls until a window exists that was not there before the launch. */
async function waitForWindows(
  base: DesktopSession,
  before: ReadonlySet<string>,
  exitedEarly: () => boolean,
): Promise<ListedWindow[]> {
  const deadline = Date.now() + windowWaitMs;
  for (;;) {
    if (exitedEarly()) {
      throw new Error("The app exited before it opened a window.");
    }
    const result = await runDesktopTool(base, ["list-windows"]);
    const listed = parseWindows(result.output);
    const appeared = listed.filter((window) => !before.has(window.id));
    if (appeared.length > 0) return appeared;
    if (Date.now() > deadline) {
      throw new Error(
        "The app did not open a window. The accessibility bus may be missing.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function parseWindows(output: string): ListedWindow[] {
  try {
    const parsed = JSON.parse(output) as { ok?: unknown; data?: unknown };
    if (parsed.ok !== true || !Array.isArray(parsed.data)) return [];
    return parsed.data.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const window = entry as Partial<ListedWindow>;
      if (typeof window.id !== "string" || typeof window.pid !== "number") {
        return [];
      }
      return [
        {
          id: window.id,
          pid: window.pid,
          title: typeof window.title === "string" ? window.title : "",
          app_name: typeof window.app_name === "string" ? window.app_name : "",
        },
      ];
    });
  } catch {
    return [];
  }
}

/** Runs the agent-desktop that ships with the daemon, on the shared screen. */
function runDesktopTool(
  base: DesktopSession,
  args: string[],
): Promise<{ code: number; output: string }> {
  const root = join(homedir(), ".agent-desktop");
  mkdirSync(root, { recursive: true });
  chmodSync(root, 0o700);
  const bin = join(
    dirname(fileURLToPath(import.meta.resolve("agent-desktop/package.json"))),
    "bin",
    "agent-desktop",
  );
  return new Promise((resolveRun) => {
    const child = spawn(bin, args, {
      env: {
        ...process.env,
        DISPLAY: base.display,
        DBUS_SESSION_BUS_ADDRESS: base.dbusAddress,
      },
      stdio: ["ignore", "pipe", "pipe"],
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
