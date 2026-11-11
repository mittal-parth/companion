/**
 * The one Chrome every bot shares.
 *
 * The daemon starts a virtual display, a light window manager and a headed
 * Chrome with one persistent profile, so a login made by one bot is there for
 * the others and survives a restart. Chrome allows one process per profile, so
 * bots share that process and each works in its own window (see browser-cli.ts).
 * Nothing starts until a bot first asks, and everything stops with the daemon.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { BrowserEndpoint } from "@companion/shared";
import { exited, stopChild } from "./engine.js";

/** Hands out the shared Chrome's address, starting it on first use. */
export type BrowserHost = {
  /** Where Chrome listens. Restarts Chrome first if it has died. */
  endpoint(): Promise<BrowserEndpoint>;
  /**
   * Opens a new window in Chrome's own profile and returns its target id. It
   * has to be this profile, not an isolated one, or the bot would not share
   * the other bots' logins.
   */
  openWindow(): Promise<string>;
  /** Stops Chrome, then the window manager and the display. */
  close(): Promise<void>;
};

export type BrowserHostOptions = {
  /** Holds the Chrome profile, which is kept between runs. */
  directory: string;
  /** Defaults to `COMPANION_CHROME`, then `google-chrome`. */
  chromeBin?: string;
  xvfbBin?: string;
  openboxBin?: string;
  /** Size of the virtual screen, as `WIDTHxHEIGHTxDEPTH`. */
  screen?: string;
};

type Running = {
  port: number;
  generation: string;
  chrome: ChildProcess;
  helpers: ChildProcess[];
};

/** Chrome flushes its profile on SIGTERM, so it gets longer than a helper. */
const chromeGraceMs = 8000;

/** What a leftover process from a crashed daemon has to look like to be killed. */
type Leftover = { pid: number; name: string };

/**
 * Creates the host. No process starts until `endpoint()` is first called.
 * A start that is already under way is shared by every caller.
 */
export function createBrowserHost(options: BrowserHostOptions): BrowserHost {
  const profile = join(options.directory, "chrome-profile");
  const stateFile = join(options.directory, "host.json");
  let current: Running | undefined;
  let starting: Promise<Running> | undefined;
  let closed = false;

  async function stopRunning(running: Running): Promise<void> {
    // Chrome writes cookies and storage to disk as it closes itself. Signalling
    // its whole process group can stop the part that writes them first.
    await cdpCall(running.port, "Browser.close", {}).catch(() => undefined);
    await exited(running.chrome, chromeGraceMs);
    stopChild(running.chrome);
    for (const helper of [...running.helpers].reverse()) {
      stopChild(helper);
      await exited(helper);
    }
    rmSync(stateFile, { force: true });
  }

  async function start(): Promise<Running> {
    await reapLeftovers(stateFile);
    mkdirSync(profile, { recursive: true });
    // A crashed Chrome leaves these behind, and a new one refuses to start.
    for (const name of [
      "SingletonLock",
      "SingletonSocket",
      "SingletonCookie",
      "DevToolsActivePort",
    ]) {
      rmSync(join(profile, name), { force: true });
    }

    const helpers: ChildProcess[] = [];
    try {
      const xvfb = spawn(
        options.xvfbBin ?? "Xvfb",
        [
          "-displayfd",
          "3",
          "-screen",
          "0",
          options.screen ?? "1920x1080x24",
          "-nolisten",
          "tcp",
        ],
        { stdio: ["ignore", "ignore", "ignore", "pipe"], detached: true },
      );
      helpers.push(xvfb);
      const display = await displayNumber(xvfb);
      const env = { ...process.env, DISPLAY: display };

      const openbox = spawn(options.openboxBin ?? "openbox", [], {
        env,
        stdio: "ignore",
        detached: true,
      });
      helpers.push(openbox);
      await started(openbox, "Openbox");

      const chrome = spawn(
        options.chromeBin ?? process.env.COMPANION_CHROME ?? "google-chrome",
        [
          `--user-data-dir=${profile}`,
          // Port 0 lets Chrome pick one and write it to DevToolsActivePort.
          "--remote-debugging-port=0",
          "--no-first-run",
          "--no-default-browser-check",
          "--password-store=basic",
          "--hide-crash-restore-bubble",
          "--window-size=1280,900",
          // Bots' windows overlap on one screen. Without these, Chrome treats
          // a covered window as hidden and stalls its clicks and timers.
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--disable-background-timer-throttling",
          "--disable-features=CalculateNativeWinOcclusion",
          ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
          "about:blank",
        ],
        { env, stdio: "ignore", detached: true },
      );
      helpers.push(chrome);
      await started(chrome, "Chrome");
      const port = await debuggingPort(profile, chrome);

      const generation = randomUUID();
      writeFileSync(
        stateFile,
        JSON.stringify({
          generation,
          processes: [
            { pid: xvfb.pid, name: "Xvfb" },
            { pid: openbox.pid, name: "openbox" },
            { pid: chrome.pid, name: "chrome" },
          ],
        }),
      );
      return { port, generation, chrome, helpers: helpers.slice(0, 2) };
    } catch (error) {
      for (const helper of [...helpers].reverse()) {
        stopChild(helper);
        await exited(helper);
      }
      throw error;
    }
  }

  async function endpoint(): Promise<BrowserEndpoint> {
    if (closed) throw new Error("The browser host is closed.");
    if (current !== undefined) {
      if (await answers(current.port)) {
        return { port: current.port, generation: current.generation };
      }
      const dead = current;
      current = undefined;
      await stopRunning(dead);
    }
    starting ??= start().finally(() => {
      starting = undefined;
    });
    const running = await starting;
    if (closed) {
      await stopRunning(running);
      throw new Error("The browser host is closed.");
    }
    current = running;
    return { port: running.port, generation: running.generation };
  }

  return {
    endpoint,

    async openWindow() {
      const { port } = await endpoint();
      const created = await cdpCall(port, "Target.createTarget", {
        url: "about:blank",
        newWindow: true,
      });
      const targetId = (created as { targetId?: unknown }).targetId;
      if (typeof targetId !== "string") {
        throw new Error("Chrome did not open a window.");
      }
      return targetId;
    },

    async close() {
      closed = true;
      const pending = starting;
      if (pending !== undefined) {
        try {
          current ??= await pending;
        } catch {
          // The start failed and cleaned up after itself.
        }
      }
      const running = current;
      current = undefined;
      if (running !== undefined) await stopRunning(running);
    },
  };
}

/** Reads the display number Xvfb picks and prints to the pipe it was given. */
async function displayNumber(xvfb: ChildProcess): Promise<string> {
  const pipe = xvfb.stdio[3] as Readable | null | undefined;
  if (pipe === null || pipe === undefined) {
    throw new Error("Xvfb did not open its display pipe.");
  }
  return new Promise<string>((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => {
      reject(new Error("Xvfb did not report a display. Is it installed?"));
    }, 10_000);
    pipe.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      const line = text.split("\n")[0] ?? "";
      if (text.includes("\n") && /^\d+$/.test(line.trim())) {
        clearTimeout(timer);
        resolve(`:${line.trim()}`);
      }
    });
    xvfb.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Xvfb could not start: ${error.message}`));
    });
    xvfb.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(`Xvfb exited (${code ?? "signal"}) before it was ready.`),
      );
    });
  });
}

/** Resolves once the process exists, and fails if the program is missing. */
function started(child: ChildProcess, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", () => {
      resolve();
    });
    child.once("error", (error) => {
      reject(new Error(`${label} could not start: ${error.message}`));
    });
  });
}

/** Waits for Chrome to write the port it chose, then for it to answer. */
async function debuggingPort(
  profile: string,
  chrome: ChildProcess,
): Promise<number> {
  const file = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (chrome.exitCode !== null || chrome.signalCode !== null) {
      throw new Error(
        `Chrome exited (${chrome.exitCode ?? chrome.signalCode}).`,
      );
    }
    if (existsSync(file)) {
      const port = Number(readFileSync(file, "utf8").split("\n")[0]);
      if (Number.isInteger(port) && port > 0 && (await answers(port))) {
        return port;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chrome did not open its debugging port.");
}

/** Sends one command to Chrome's browser-level DevTools endpoint and returns its result. */
async function cdpCall(
  port: number,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(5000),
  });
  const { webSocketDebuggerUrl } = (await response.json()) as {
    webSocketDebuggerUrl: string;
  };
  const socket = new WebSocket(webSocketDebuggerUrl);
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Chrome did not answer ${method}.`));
      }, 10_000);
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ id: 1, method, params }));
      });
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as {
          id?: number;
          result?: unknown;
          error?: { message?: string };
        };
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.error !== undefined) {
          reject(new Error(message.error.message ?? `${method} failed.`));
          return;
        }
        resolve(message.result);
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`Chrome refused ${method}.`));
      });
    });
  } finally {
    socket.close();
  }
}

/** True when Chrome answers on its debugging port. */
async function answers(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Stops the processes a daemon that crashed left running.
 * A pid is only killed when it still looks like the program recorded for it,
 * because the number may have been given to something else since.
 */
async function reapLeftovers(stateFile: string): Promise<void> {
  if (!existsSync(stateFile)) return;
  let leftovers: Leftover[] = [];
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as {
      processes?: Leftover[];
    };
    leftovers = parsed.processes ?? [];
  } catch {
    // An unreadable record names nothing to stop.
  }
  rmSync(stateFile, { force: true });
  for (const { pid, name } of leftovers) {
    if (!looksLike(pid, name)) continue;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      continue;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  for (const { pid, name } of leftovers) {
    if (looksLike(pid, name)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // It stopped on its own.
      }
    }
  }
}

/** True when `pid` is a live process whose command line names `name`. */
function looksLike(pid: number, name: string): boolean {
  try {
    const command = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return command.toLowerCase().includes(name.toLowerCase());
  } catch {
    return false;
  }
}
