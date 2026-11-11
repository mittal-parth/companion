/**
 * Proves the `desktop` command stays on the calling bot's windows and refuses
 * what would reach the rest of the screen. A fake daemon and a recording runner
 * stand in for the daemon and for agent-desktop. The real screen is in
 * desktop.test.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { runDesktopCli, type DesktopCliContext } from "../src/desktop-cli.js";

let directory: string;
let bot: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "companion-desktop-cli-"));
  bot = join(directory, "bots", "one");
  mkdirSync(join(bot, ".companion"), { recursive: true });
  writeFileSync(
    join(bot, ".companion", "schedule.json"),
    JSON.stringify({ url: "http://daemon.test", token: "secret" }),
  );
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const window = {
  windowId: "w1",
  app: "form",
  toolApp: "python3.12",
  pid: 40,
  title: "Companion form",
};

function fixture(windows = [window]) {
  const calls: string[][] = [];
  const quiet: boolean[] = [];
  const printed: string[] = [];
  const errors: string[] = [];
  const requests: Array<{ url: string; body: string | undefined }> = [];
  const context: DesktopCliContext = {
    cwd: bot,
    fetch: (async (url: string, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : undefined;
      requests.push({ url, body });
      if (url.endsWith("/session")) {
        return Response.json({
          display: ":9",
          dbusAddress: "unix:path=/tmp/bus",
          generation: "gen-1",
          session: "bot-one",
          lockPath: join(directory, "lock"),
        });
      }
      if (url.endsWith("/launch")) {
        return Response.json(window);
      }
      if (url.endsWith("/close")) return Response.json({ closed: true });
      return Response.json({
        display: ":9",
        dbusAddress: "unix:path=/tmp/bus",
        generation: "gen-1",
        session: "bot-one",
        lockPath: join(directory, "lock"),
        windows,
      });
    }) as typeof fetch,
    run: async (args, options) => {
      calls.push(args);
      quiet.push(options?.quiet === true);
      if (args.includes("list-windows")) {
        return {
          code: 0,
          output: JSON.stringify({
            ok: true,
            data: [
              { pid: 40, title: "Companion form" },
              { pid: 99, title: "Other" },
            ],
          }),
        };
      }
      return { code: 0, output: "" };
    },
    print: (text) => printed.push(text),
    printError: (text) => errors.push(text),
  };
  return { context, calls, quiet, printed, errors, requests };
}

test("a ref action keeps the ref and is not given a window id", async () => {
  const { context, calls } = fixture();
  expect(
    await runDesktopCli(["click", "--window-id", "w1", "@e1"], context),
  ).toBe(0);
  expect(calls).toEqual([["--session", "bot-one", "click", "@e1"]]);
});

test("a snapshot is pinned to the bot's only window and session", async () => {
  const { context, calls, requests } = fixture();
  expect(await runDesktopCli(["snapshot", "-i", "--compact"], context)).toBe(0);
  expect(calls).toEqual([
    [
      "--session",
      "bot-one",
      "snapshot",
      "--window-id",
      "w1",
      "-i",
      "--compact",
    ],
  ]);
  expect(requests.map((request) => request.url)).toEqual([
    "http://daemon.test/agent/desktop/session",
    "http://daemon.test/agent/desktop",
  ]);
});

test("launch asks the daemon and does not run the desktop tool", async () => {
  const { context, calls, printed, errors, requests } = fixture();
  expect(await runDesktopCli(["launch", "form"], context)).toBe(0);
  expect(calls).toEqual([]);
  expect(printed.join("")).toContain("w1");
  expect(errors.join("")).toContain("snapshot");
  expect(requests.at(-1)).toEqual({
    url: "http://daemon.test/agent/desktop/launch",
    body: JSON.stringify({ app: "form" }),
  });
});

test("a file outside the bot's folder is refused before launch", async () => {
  const { context, errors, requests } = fixture();
  expect(
    await runDesktopCli(["launch", "mousepad", "/etc/passwd"], context),
  ).toBe(1);
  expect(errors.join("")).toContain("outside your folder");
  expect(requests.some((request) => request.url.endsWith("/launch"))).toBe(
    false,
  );
});

test("headed input, the raw launch, and the clipboard are refused", async () => {
  const { context, calls, errors } = fixture();
  expect(await runDesktopCli(["snapshot", "--headed"], context)).toBe(1);
  expect(await runDesktopCli(["launch", "xterm"], context)).toBe(1);
  expect(await runDesktopCli(["clipboard-get"], context)).toBe(1);
  expect(calls).toEqual([]);
  expect(errors.join("")).toContain("pointer");
  expect(errors.join("")).toContain("desktop launch form");
  expect(errors.join("")).toContain("clipboard");
});

test("another bot's window is refused", async () => {
  const { context, calls, errors } = fixture();
  expect(
    await runDesktopCli(["snapshot", "--window-id", "someone-else"], context),
  ).toBe(1);
  expect(calls).toEqual([]);
  expect(errors.join("")).toContain("not yours");
  expect(errors.join("")).toContain("w1");
});

test("several windows have to be named", async () => {
  const { context, errors } = fixture([
    window,
    { ...window, windowId: "w2", title: "Notes" },
  ]);
  expect(await runDesktopCli(["snapshot"], context)).toBe(1);
  expect(errors.join("")).toContain("--window-id");
  expect(errors.join("")).toContain("w2");
});

test("a screenshot is raised, saved in the bot's folder, and handed to the vision subagent", async () => {
  const { context, calls, quiet, printed } = fixture();
  expect(await runDesktopCli(["screenshot"], context)).toBe(0);
  expect(quiet[0]).toBe(true);
  expect(calls[0]?.slice(0, 4)).toEqual([
    "--session",
    "bot-one",
    "focus-window",
    "--window-id",
  ]);
  const saved = calls[1]?.at(-1) ?? "";
  expect(saved.startsWith(join(bot, "images"))).toBe(true);
  expect(printed.join("")).toContain(saved);
  expect(printed.join("")).toContain("vision subagent");
});

test("a window list hides the other bot", async () => {
  const { context, printed } = fixture();
  expect(await runDesktopCli(["list-windows"], context)).toBe(0);
  const listed = JSON.parse(printed.join("")) as {
    data: Array<{ title: string }>;
  };
  expect(listed.data.map((entry) => entry.title)).toEqual(["Companion form"]);
});

test("two commands wait for the one desktop lock", async () => {
  const { context } = fixture();
  let running = 0;
  let overlap = 0;
  context.run = async () => {
    running += 1;
    overlap = Math.max(overlap, running);
    await new Promise((resolve) => setTimeout(resolve, 40));
    running -= 1;
    return { code: 0, output: "" };
  };
  const results = await Promise.all([
    runDesktopCli(["get", "text"], context),
    runDesktopCli(["get", "text"], context),
  ]);
  expect(results).toEqual([0, 0]);
  expect(overlap).toBe(1);
});

test("skills run without asking the daemon", async () => {
  const { context, calls, requests } = fixture();
  expect(await runDesktopCli(["skills", "get", "desktop"], context)).toBe(0);
  expect(calls).toEqual([["skills", "get", "desktop"]]);
  expect(requests).toEqual([]);
});
