/**
 * The one screen every bot shares.
 *
 * The machine has no monitor, so the daemon starts a virtual display, a window
 * manager, a session bus and the accessibility bus. Chrome and desktop apps
 * both run on that screen. Nothing starts until something asks, and a crashed
 * daemon's leftovers are stopped on the next start.
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
import { exited, stopChild } from "./engine.js";

/** Where the shared screen is, for a process that wants to draw on it. */
export type DisplayEndpoint = {
  /** The X display, such as `:1`. */
  display: string;
  /** The session bus apps and the accessibility tree share. */
  dbusAddress: string;
  /** Changes when the screen is started again, so old windows are gone. */
  generation: string;
};

/** Hands out the shared screen, starting it on first use. */
export type DisplayHost = {
  endpoint(): Promise<DisplayEndpoint>;
  /** Stops the accessibility bus, the window manager, the display and the session bus. */
  close(): Promise<void>;
};

export type DisplayHostOptions = {
  /** Holds the bus socket and the record of child processes. */
  directory: string;
  xvfbBin?: string;
  openboxBin?: string;
  dbusBin?: string;
  /** Defaults to the system AT-SPI launcher. Skipped when that file is absent. */
  atspiBin?: string;
  /** Size of the virtual screen, as `WIDTHxHEIGHTxDEPTH`. */
  screen?: string;
};

type Running = {
  endpoint: DisplayEndpoint;
  children: ChildProcess[];
};

type Leftover = { pid: number; name: string };

const atspiLauncher = "/usr/libexec/at-spi-bus-launcher";

/**
 * Creates the host. No process starts until `endpoint()` is first called.
 * A start that is already under way is shared by every caller.
 */
export function createDisplayHost(options: DisplayHostOptions): DisplayHost {
  const stateFile = join(options.directory, "host.json");
  let current: Running | undefined;
  let starting: Promise<Running> | undefined;
  let closed = false;

  async function stopRunning(running: Running): Promise<void> {
    for (const child of [...running.children].reverse()) {
      stopChild(child);
      await exited(child);
    }
    rmSync(stateFile, { force: true });
    rmSync(join(options.directory, "bus"), { force: true });
  }

  async function start(): Promise<Running> {
    await reapLeftovers(stateFile);
    mkdirSync(options.directory, { recursive: true });
    rmSync(join(options.directory, "bus"), { force: true });

    const children: ChildProcess[] = [];
    try {
      const dbus = spawn(
        options.dbusBin ?? "dbus-daemon",
        [
          "--session",
          "--nofork",
          "--print-address=1",
          `--address=unix:path=${join(options.directory, "bus")}`,
        ],
        { stdio: ["ignore", "pipe", "ignore"], detached: true },
      );
      children.push(dbus);
      const dbusAddress = await dbusAddressFrom(dbus);

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
      children.push(xvfb);
      const display = await displayNumber(xvfb);
      const env = {
        ...process.env,
        DISPLAY: display,
        DBUS_SESSION_BUS_ADDRESS: dbusAddress,
      };

      const openbox = spawn(options.openboxBin ?? "openbox", [], {
        env,
        stdio: "ignore",
        detached: true,
      });
      children.push(openbox);
      await started(openbox, "Openbox");

      const atspiBin = options.atspiBin ?? atspiLauncher;
      if (existsSync(atspiBin)) {
        const atspi = spawn(atspiBin, [], {
          env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
        children.push(atspi);
        await accessibilityBus(atspi);
      }

      const endpoint: DisplayEndpoint = {
        display,
        dbusAddress,
        generation: randomUUID(),
      };
      writeFileSync(
        stateFile,
        JSON.stringify({
          ...endpoint,
          processes: children.map((child) => ({
            pid: child.pid,
            name: commandName(child.spawnfile),
          })),
        }),
      );
      return { endpoint, children };
    } catch (error) {
      for (const child of [...children].reverse()) {
        stopChild(child);
        await exited(child);
      }
      throw error;
    }
  }

  async function endpoint(): Promise<DisplayEndpoint> {
    if (closed) throw new Error("The display is closed.");
    if (current !== undefined) {
      if (current.children.every(alive)) return current.endpoint;
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
      throw new Error("The display is closed.");
    }
    current = running;
    return running.endpoint;
  }

  return {
    endpoint,
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

/**
 * Stops the processes a daemon that crashed left running.
 * A pid is only killed when it still looks like the program recorded for it,
 * because the number may have been given to something else since.
 */
export async function reapLeftovers(stateFile: string): Promise<void> {
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

function commandName(file: string): string {
  const name = file.split("/").pop() ?? file;
  return name === "" ? file : name;
}

function alive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/** Reads the display number Xvfb picks and prints to the pipe it was given. */
function displayNumber(xvfb: ChildProcess): Promise<string> {
  const pipe = xvfb.stdio[3] as Readable | null | undefined;
  if (pipe === null || pipe === undefined) {
    return Promise.reject(new Error("Xvfb did not open its display pipe."));
  }
  return firstLine(xvfb, pipe, "Xvfb", (line) =>
    /^\d+$/.test(line) ? `:${line}` : undefined,
  );
}

/** Reads the session-bus address dbus-daemon prints as it starts. */
function dbusAddressFrom(dbus: ChildProcess): Promise<string> {
  const pipe = dbus.stdout;
  if (pipe === null) {
    return Promise.reject(new Error("dbus-daemon did not open its output."));
  }
  return firstLine(dbus, pipe, "dbus-daemon", (line) =>
    line.startsWith("unix:") ? line : undefined,
  );
}

/**
 * Resolves with the first line `accept` understands.
 * Fails when the process ends, or when nothing arrives.
 */
function firstLine(
  child: ChildProcess,
  pipe: Readable,
  label: string,
  accept: (line: string) => string | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => {
      reject(new Error(`${label} did not become ready. Is it installed?`));
    }, 10_000);
    const finish = (error?: Error, value?: string) => {
      clearTimeout(timer);
      if (error !== undefined) reject(error);
      else resolve(value ?? "");
    };
    pipe.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (!text.includes("\n")) return;
      const value = accept((text.split("\n")[0] ?? "").trim());
      if (value !== undefined) finish(undefined, value);
    });
    child.once("error", (error) => {
      finish(new Error(`${label} could not start: ${error.message}`));
    });
    child.once("exit", (code) => {
      finish(
        new Error(`${label} exited (${code ?? "signal"}) before it was ready.`),
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

/**
 * Waits until the accessibility bus has something to say, or a short moment
 * when it stays quiet. A bus that exits is a broken session, not an empty one.
 */
function accessibilityBus(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve();
    }, 1000);
    const ready = () => {
      clearTimeout(timer);
      resolve();
    };
    child.stdout?.once("data", ready);
    child.stderr?.once("data", ready);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(
        new Error(`The accessibility bus could not start: ${error.message}`),
      );
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `The accessibility bus exited (${code ?? "signal"}) before it was ready.`,
        ),
      );
    });
  });
}
