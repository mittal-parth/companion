/**
 * Proves the `browser` command keeps each bot in its own window of the shared
 * Chrome and refuses what would reach every bot. A fake daemon and a recording
 * runner stand in for the daemon and for agent-browser. The real Chrome run is
 * in browser.test.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { runBrowserCli, type BrowserCliContext } from "./browser-cli.js";

let directory: string;
let bot: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "companion-browser-cli-"));
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

/** A context whose daemon hands out `generation`, recording every agent-browser call. */
function fixture(generation: () => string = () => "gen-1") {
  const calls: string[][] = [];
  const errors: string[] = [];
  const requests: Array<{ url: string; authorization: string | null }> = [];
  let windows = 0;
  const context: BrowserCliContext = {
    cwd: bot,
    fetch: (async (url: string, init?: RequestInit) => {
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (url.endsWith("/window")) {
        windows += 1;
        return Response.json({ targetId: `target-${windows}` });
      }
      return Response.json({
        port: 9333,
        generation: generation(),
        session: "bot-one",
      });
    }) as typeof fetch,
    run: async (args) => {
      calls.push(args);
      return { code: 0, output: "" };
    },
    printError: (text) => errors.push(text),
  };
  return { context, calls, errors, requests };
}

const attach = ["--session", "bot-one", "--cdp", "9333"];
const connection = [...attach, "--pin-tab"];

test("the first command opens the bot's own window, then runs pinned to it", async () => {
  const { context, calls, requests } = fixture();
  expect(await runBrowserCli(["open", "https://example.com"], context)).toBe(0);
  expect(calls).toEqual([
    ["--session", "bot-one", "close"],
    [...attach, "tab", "target-1"],
    [...connection, "open", "https://example.com"],
  ]);
  expect(requests).toEqual([
    { url: "http://daemon.test/agent/browser", authorization: "Bearer secret" },
    {
      url: "http://daemon.test/agent/browser/window",
      authorization: "Bearer secret",
    },
  ]);

  calls.length = 0;
  expect(await runBrowserCli(["snapshot", "-i"], context)).toBe(0);
  expect(calls).toEqual([[...connection, "snapshot", "-i"]]);
});

test("a Chrome that started again gives the bot a new window", async () => {
  let generation = "gen-1";
  const { context, calls } = fixture(() => generation);
  await runBrowserCli(["snapshot"], context);
  calls.length = 0;

  generation = "gen-2";
  await runBrowserCli(["snapshot"], context);
  expect(calls.map((call) => call.at(-1))).toEqual([
    "close",
    "target-2",
    "snapshot",
  ]);
});

test("a window that cannot be opened stops the command", async () => {
  const { context, calls, errors } = fixture();
  context.run = async (args) => {
    calls.push(args);
    return args.includes("tab")
      ? { code: 7, output: "Chrome would not open a window." }
      : { code: 0, output: "" };
  };
  expect(await runBrowserCli(["snapshot"], context)).toBe(7);
  expect(errors.join("")).toContain("Chrome would not open a window.");
  expect(calls.some((call) => call.includes("snapshot"))).toBe(false);

  // The failure is not remembered as a window, so the next command tries again.
  calls.length = 0;
  await runBrowserCli(["snapshot"], context);
  expect(calls.some((call) => call.includes("tab"))).toBe(true);
});

test("asking for a new window opens one and rebinds the session", async () => {
  const { context, calls, errors } = fixture();
  await runBrowserCli(["snapshot"], context);
  calls.length = 0;

  expect(await runBrowserCli(["window", "new"], context)).toBe(0);
  expect(calls).toEqual([
    ["--session", "bot-one", "close"],
    [...attach, "tab", "target-2"],
  ]);
  expect(errors.join("")).toContain("new window");

  // The next command works in that window with no further setup.
  calls.length = 0;
  await runBrowserCli(["snapshot"], context);
  expect(calls).toEqual([[...connection, "snapshot"]]);
});

test("what would reach every bot, or reroute this one, is refused", async () => {
  const { context, calls, errors } = fixture();
  const refused = [
    ["--session", "other", "snapshot"],
    ["--cdp=9222", "snapshot"],
    ["open", "https://example.com", "--profile", "/tmp/x"],
    ["--headed", "open", "https://example.com"],
    ["close"],
    ["close", "--all"],
    ["connect", "9222"],
    ["cookies", "clear"],
    ["dashboard", "start"],
    ["install"],
  ];
  for (const argv of refused) {
    errors.length = 0;
    expect(await runBrowserCli(argv, context), argv.join(" ")).toBe(1);
    expect(errors.join(""), argv.join(" ")).not.toBe("");
  }
  expect(calls).toEqual([]);

  // Reading cookies and clearing one page's storage are still allowed.
  expect(await runBrowserCli(["cookies", "get"], context)).toBe(0);
});

test("help and skills run without Chrome or the daemon", async () => {
  const { context, calls, requests } = fixture();
  expect(await runBrowserCli(["skills", "get", "core"], context)).toBe(0);
  expect(await runBrowserCli(["--version"], context)).toBe(0);
  expect(calls).toEqual([["skills", "get", "core"], ["--version"]]);
  expect(requests).toEqual([]);
});

test("no arguments print the usage", async () => {
  const { context, errors } = fixture();
  expect(await runBrowserCli([], context)).toBe(1);
  expect(errors.join("")).toContain("browser skills get core");
});

test("outside a bot folder there is nothing to connect with", async () => {
  const { context, calls, errors } = fixture();
  context.cwd = directory;
  expect(await runBrowserCli(["snapshot"], context)).toBe(1);
  expect(errors.join("")).toContain("not inside a bot folder");
  expect(calls).toEqual([]);
});

test("a daemon that is down or says no is reported", async () => {
  const down = fixture();
  down.context.fetch = (async () => {
    throw new Error("refused");
  }) as typeof fetch;
  expect(await runBrowserCli(["snapshot"], down.context)).toBe(1);
  expect(down.errors.join("")).toContain("not reachable");

  const refused = fixture();
  refused.context.fetch = (async () =>
    Response.json(
      { error: "The browser could not start: Xvfb is missing." },
      { status: 503 },
    )) as typeof fetch;
  expect(await runBrowserCli(["snapshot"], refused.context)).toBe(1);
  expect(refused.errors.join("")).toContain("Xvfb is missing");
  expect(refused.calls).toEqual([]);
});

test("one bot's commands never overlap, even when issued together", async () => {
  const { context } = fixture();
  let running = 0;
  let overlapped = false;
  context.run = async () => {
    running += 1;
    if (running > 1) overlapped = true;
    await new Promise((resolve) => setTimeout(resolve, 30));
    running -= 1;
    return { code: 0, output: "" };
  };
  await Promise.all([
    runBrowserCli(["snapshot"], context),
    runBrowserCli(["snapshot"], context),
    runBrowserCli(["snapshot"], context),
  ]);
  expect(overlapped).toBe(false);
});

test("a lock left by a command that died does not block the bot", async () => {
  const lock = join(bot, ".companion", "browser.lock");
  mkdirSync(lock);
  // pid 2 ** 22 + 1 is above the kernel's default pid limit, so it is not running.
  writeFileSync(join(lock, "pid"), String(2 ** 22 + 1));
  const { context, calls } = fixture();
  expect(await runBrowserCli(["snapshot"], context)).toBe(0);
  expect(calls.at(-1)?.at(-1)).toBe("snapshot");
});
