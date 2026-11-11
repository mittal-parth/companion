/**
 * Proves the shared Chrome works for several bots at once: one Chrome with one
 * profile, a window per bot, a login shared between bots and kept across a
 * daemon restart. It runs a real Chrome on a virtual display, so it is skipped
 * where Xvfb, Openbox or Chrome is not installed, and it needs no model.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type { BotView } from "@companion/shared";
import { expect, test } from "vitest";
import { startDaemon, type Daemon } from "../src/api.js";
import { createBrowserHost } from "../src/browser.js";
import { startFixtureSite } from "./fixture-site.js";
import { installBrowserShim, type Engine } from "../src/engine.js";

const chrome = process.env.COMPANION_CHROME ?? "google-chrome";
const installed = ["Xvfb", "openbox", chrome].every(
  (program) => spawnSync("which", [program]).status === 0,
);

test.skipIf(!installed)(
  "the host shares one Chrome and starts it again when it dies",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "companion-host-"));
    const host = createBrowserHost({ directory });
    try {
      const first = await host.endpoint();
      expect(await host.endpoint()).toEqual(first);
      expect(await answers(first.port)).toBe(true);

      // Chrome dies without the daemon asking, as a crash would.
      const state = JSON.parse(
        readFileSync(join(directory, "host.json"), "utf8"),
      ) as { processes: Array<{ pid: number; name: string }> };
      const browser = state.processes.find((entry) => entry.name === "chrome");
      process.kill(browser?.pid ?? 0, "SIGKILL");

      const second = await host.endpoint();
      expect(second.generation).not.toBe(first.generation);
      expect(await answers(second.port)).toBe(true);

      await host.close();
      expect(await answers(second.port)).toBe(false);
    } finally {
      await host.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  120_000,
);

test.skipIf(!installed)(
  "two bots fill forms at once without colliding, share a login and keep it across a restart",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "companion-browser-"));
    const site = await startFixtureSite();
    let daemon = await startDaemon(options(directory));
    try {
      const ada = await createBot(daemon, "Ada");
      const bob = await createBot(daemon, "Bob");
      installBrowserShim(join(directory, "bin"));
      const as = (bot: BotView) => (args: string[]) =>
        browser(join(directory, "bin", "browser"), bot.directory, args);
      const adaBrowser = as(ada);
      const bobBrowser = as(bob);

      // Both bots run their steps together, so their commands interleave.
      const book = async (
        run: (args: string[]) => Promise<Result>,
        name: string,
        plan: string,
      ) => {
        await ok(run(["open", `${site.url}/search?q=cottage`]));
        await ok(run(["click", 'a[href="/items/2"]']));
        await ok(run(["wait", "input[name=name]"]));
        await ok(run(["fill", "input[name=name]", name]));
        await ok(run(["select", "select[name=plan]", plan]));
        await ok(run(["click", "button"]));
        await ok(run(["wait", "--text", "Please accept the terms"]));
        const rejected = await ok(run(["get", "text", "body"]));
        expect(rejected).toContain("Please accept the terms");
        await ok(run(["check", "input[name=terms]"]));
        await ok(run(["click", "button"]));
        await ok(run(["wait", "--text", "Booking confirmed"]));
        return ok(run(["get", "text", "body"]));
      };
      const [adaPage, bobPage] = await Promise.all([
        book(adaBrowser, "Ada", "premium"),
        book(bobBrowser, "Bob", "basic"),
      ]);
      expect(adaPage).toContain(site.bookingCode(2, "Ada", "premium"));
      expect(adaPage).not.toContain(site.bookingCode(2, "Bob", "basic"));
      expect(bobPage).toContain(site.bookingCode(2, "Bob", "basic"));
      expect(bobPage).not.toContain(site.bookingCode(2, "Ada", "premium"));

      // Each bot is still on its own page, in its own window.
      expect(await ok(adaBrowser(["get", "url"]))).toContain("/items/2/book");
      await ok(bobBrowser(["open", `${site.url}/awkward`]));
      expect(await ok(adaBrowser(["get", "url"]))).toContain("/items/2/book");
      expect(await ok(bobBrowser(["get", "url"]))).toContain("/awkward");

      // One bot signs in. The other is signed in without doing anything.
      await ok(adaBrowser(["open", `${site.url}/login`]));
      await ok(adaBrowser(["fill", "input[name=user]", "ada"]));
      await ok(adaBrowser(["click", "button"]));
      await ok(adaBrowser(["wait", "--text", "Signed in as"]));
      expect(await ok(adaBrowser(["get", "text", "body"]))).toContain(
        site.accountCode("ada"),
      );
      await ok(bobBrowser(["open", `${site.url}/account`]));
      expect(await ok(bobBrowser(["get", "text", "body"]))).toContain(
        site.accountCode("ada"),
      );

      // The daemon stops and starts again. Chrome and its windows are gone,
      // and the login is still there.
      await daemon.close();
      daemon = await startDaemon(options(directory));
      await ok(adaBrowser(["open", `${site.url}/account`]));
      expect(await ok(adaBrowser(["get", "text", "body"]))).toContain(
        site.accountCode("ada"),
      );
    } finally {
      await daemon.close();
      await site.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  240_000,
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

/** Runs the `browser` command as a bot would, from inside its folder. */
function browser(shim: string, cwd: string, args: string[]): Promise<Result> {
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

/** Expects the command to have worked and returns what it printed. */
async function ok(result: Promise<Result>): Promise<string> {
  const finished = await result;
  expect(finished.code, `${finished.stdout}\n${finished.stderr}`).toBe(0);
  return finished.stdout;
}

async function answers(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
