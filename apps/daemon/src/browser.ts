/**
 * The one Chrome every bot shares.
 *
 * The daemon starts a headed Chrome with one persistent profile on the shared
 * display, so a login made by one bot is there for the others and survives a
 * restart. Chrome allows one process per profile, so bots share that process
 * and each works in its own window (see browser-cli.ts). Nothing starts until
 * a bot first asks, and Chrome stops with the daemon. The display stays up for
 * desktop apps when this host did not start it.
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
import type { BrowserEndpoint } from "@companion/shared";
import {
  createDisplayHost,
  reapLeftovers,
  type DisplayHost,
} from "./display.js";
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
  /**
   * The screen Chrome draws on. When omitted, this host starts its own and
   * stops it on close. The daemon passes the shared one, which desktop apps
   * use as well.
   */
  display?: DisplayHost;
  /** Defaults to `COMPANION_CHROME`, then `google-chrome`. */
  chromeBin?: string;
  xvfbBin?: string;
  openboxBin?: string;
  /** Size of the virtual screen, as `WIDTHxHEIGHTxDEPTH`. Used for a private display only. */
  screen?: string;
};

type Running = {
  port: number;
  generation: string;
  chrome: ChildProcess;
};

/** Chrome flushes its profile on SIGTERM, so it gets longer than a helper. */
const chromeGraceMs = 8000;

/**
 * Creates the host. No process starts until `endpoint()` is first called.
 * A start that is already under way is shared by every caller.
 */
export function createBrowserHost(options: BrowserHostOptions): BrowserHost {
  const profile = join(options.directory, "chrome-profile");
  const stateFile = join(options.directory, "host.json");
  const ownsDisplay = options.display === undefined;
  const display =
    options.display ??
    createDisplayHost({
      directory: join(options.directory, "display"),
      xvfbBin: options.xvfbBin,
      openboxBin: options.openboxBin,
      screen: options.screen,
    });
  let current: Running | undefined;
  let starting: Promise<Running> | undefined;
  let closed = false;

  async function stopRunning(running: Running): Promise<void> {
    // Chrome writes cookies and storage to disk as it closes itself. Signalling
    // its whole process group can stop the part that writes them first.
    await cdpCall(running.port, "Browser.close", {}).catch(() => undefined);
    await exited(running.chrome, chromeGraceMs);
    stopChild(running.chrome);
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

    let chrome: ChildProcess | undefined;
    try {
      const screen = await display.endpoint();
      const env = {
        ...process.env,
        DISPLAY: screen.display,
        DBUS_SESSION_BUS_ADDRESS: screen.dbusAddress,
      };
      chrome = spawn(
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
          // Lets the desktop accessibility tree see Chrome when a bot asks.
          "--force-renderer-accessibility",
          // Bots' windows overlap on one screen. Without these, Chrome treats
          // a covered window as hidden and stalls its clicks and timers.
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--disable-background-timer-throttling",
          "--disable-features=CalculateNativeWinOcclusion",
          // Chrome's own sandbox needs namespaces that a container's default
          // seccomp profile blocks. The image says so with this variable and
          // relies on the container and the VM instead (the VM is the boundary).
          ...(process.getuid?.() === 0 ||
          process.env.COMPANION_CHROME_SANDBOX === "off"
            ? ["--no-sandbox"]
            : []),
          "about:blank",
        ],
        { env, stdio: "ignore", detached: true },
      );
      await started(chrome, "Chrome");
      const port = await debuggingPort(profile, chrome);

      const generation = randomUUID();
      writeFileSync(
        stateFile,
        JSON.stringify({
          generation,
          processes: [{ pid: chrome.pid, name: "chrome" }],
        }),
      );
      return { port, generation, chrome };
    } catch (error) {
      if (chrome !== undefined) {
        stopChild(chrome);
        await exited(chrome);
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
      if (ownsDisplay) await display.close();
    },
  };
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
  // The first start on a machine made from an image reads Chrome from a disk
  // that is still filling in, which can take well over 30 seconds.
  const deadline = Date.now() + 90_000;
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
