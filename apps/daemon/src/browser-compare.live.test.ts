/**
 * Compares agent-browser and Playwright CLI by giving a real bot the same
 * three tasks on the fake site with each tool, several times, and recording
 * what happened. The bot, the model, the page and the wording are the same.
 * Only the tool's name and how it attaches to Chrome differ.
 *
 * It is a measurement, not a pass/fail check: a bot that fails a task is a
 * result. Skipped unless COMPANION_COMPARE=1. Results go to the JSON file named
 * by COMPARE_OUT, or the system temp folder, after every attempt.
 * COMPARE_RUNS (default 3) and COMPARE_TOOLS (default both) narrow the run.
 */
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
import { startDaemon, type Daemon } from "./api.js";
import { createBrowserHost, type BrowserHost } from "./browser.js";
import { startFixtureSite, type FixtureSite } from "./browser-fixture-site.js";
import {
  askBot,
  createLiveBot,
  opencodeBin,
  requireOpencode,
  type LiveTurn,
} from "./live-support.js";

type Tool = "agent-browser" | "playwright-cli";
type TaskName = "booking" | "awkward" | "login";

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
const tools = (process.env.COMPARE_TOOLS ?? "agent-browser,playwright-cli")
  .split(",")
  .map((name) => name.trim()) as Tool[];
const resultsFile =
  process.env.COMPARE_OUT ?? join(tmpdir(), "browser-compare.json");

const here = dirname(fileURLToPath(import.meta.url));
const toolRoot = join(here, "..", "node_modules");
const launchers: Record<Tool, string[]> = {
  "agent-browser": [
    process.execPath,
    join(toolRoot, "agent-browser", "bin", "agent-browser.js"),
  ],
  "playwright-cli": [
    process.execPath,
    join(toolRoot, "@playwright", "cli", "playwright-cli.js"),
  ],
};
/** What the bot types for each tool. Neither name is on the daemon's deny list. */
const commandNames: Record<Tool, string> = {
  "agent-browser": "ab",
  "playwright-cli": "pw",
};

const attempts: Attempt[] = [];

test.skipIf(!compare)(
  "measure agent-browser and Playwright CLI on the same tasks",
  async () => {
    requireOpencode();
    const shims = mkdtempSync(join(tmpdir(), "companion-compare-bin-"));
    for (const tool of tools) {
      const [node, script] = launchers[tool];
      const path = join(shims, commandNames[tool]);
      writeFileSync(path, `#!/bin/sh\nexec "${node}" "${script}" "$@"\n`);
      chmodSync(path, 0o755);
    }
    const originalPath = process.env.PATH;
    process.env.PATH = `${shims}${process.platform === "win32" ? ";" : ":"}${originalPath ?? ""}`;
    try {
      for (const tool of tools) {
        await measureSnapshots(tool);
        for (const task of ["booking", "awkward", "login"] as const) {
          for (let run = 1; run <= runs; run += 1) {
            attempts.push(await attempt(tool, task, run));
            writeFileSync(resultsFile, JSON.stringify(attempts, null, 2));
          }
        }
      }
    } finally {
      process.env.PATH = originalPath;
      rmSync(shims, { recursive: true, force: true });
    }
  },
  4 * 60 * 60 * 1000,
);

/** One attempt: a fresh site, Chrome, daemon and bot, so runs cannot help each other. */
async function attempt(
  tool: Tool,
  task: TaskName,
  run: number,
): Promise<Attempt> {
  const started = Date.now();
  const directory = mkdtempSync(join(tmpdir(), "companion-compare-"));
  const site = await startFixtureSite();
  let host = createBrowserHost({ directory: join(directory, "browser") });
  let daemon: Daemon | undefined;
  const turns: LiveTurn[] = [];
  let missing: string[] = [];
  let error: string | undefined;
  const begin = (browser: BrowserHost) =>
    startDaemon({
      storePath: join(directory, "threads.db"),
      opencodeBin,
      browser,
    });
  try {
    daemon = await begin(host);
    const bot = await createLiveBot(daemon, "Compare");
    const ask = async (text: string, session: string) => {
      const { port } = await host.endpoint();
      const turn = await askBot(
        daemon as Daemon,
        bot.id,
        `${toolBlock(tool, port, session)}\n\n${text}`,
      );
      turns.push(turn);
      return turn;
    };
    switch (task) {
      case "booking": {
        const turn = await ask(
          `Open ${site.url}/ and search it for "cottage". Open the second result and book it for Priya Nair on the premium plan, accepting the terms. Reply with the confirmation code the page shows.`,
          `s${run}`,
        );
        missing = codesMissing(turn.reply, [
          site.bookingCode(2, "Priya Nair", "premium"),
        ]);
        break;
      }
      case "awkward": {
        const turn = await ask(
          `Open ${site.url}/awkward and collect four codes. (1) The report code on the page that the "Open the report" link opens. (2) The frame code: click "Check answer" in the form inside the frame. (3) The dialog code: click "Reveal dialog code" and accept the confirmation dialog. (4) The late code: wait for the "Late button" to appear, then click it. Reply with all four codes.`,
          `s${run}`,
        );
        missing = codesMissing(turn.reply, Object.values(site.awkwardCodes));
        break;
      }
      case "login": {
        const first = await ask(
          `Sign in at ${site.url}/login as user priya with any password, then reply with the account code the page shows.`,
          `a${run}`,
        );
        missing = codesMissing(first.reply, [site.accountCode("priya")]);
        // Chrome and the daemon stop and start again on the same profile.
        await daemon.close();
        daemon = undefined;
        host = createBrowserHost({ directory: join(directory, "browser") });
        daemon = await begin(host);
        const second = await ask(
          `Open ${site.url}/account and reply with the account code it shows. Do not sign in again unless the page asks you to.`,
          `b${run}`,
        );
        missing = [
          ...missing,
          ...codesMissing(second.reply, [site.accountCode("priya")]),
        ];
        if (
          site.requests.filter((entry) => entry === "POST /login").length > 1
        ) {
          missing.push("signed in a second time");
        }
        break;
      }
      default: {
        const unexpected: never = task;
        throw new Error(`Unknown task ${String(unexpected)}.`);
      }
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message.slice(0, 500) : "failed";
    if (missing.length === 0) missing = ["the task did not finish"];
  } finally {
    await daemon?.close();
    await host.close();
    await site.stop();
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
      .join("\n---\n")
      .slice(0, 600),
  };
}

/** The same sentence of setup for each tool, differing only in how it attaches. */
function toolBlock(tool: Tool, port: number, session: string): string {
  switch (tool) {
    case "agent-browser":
      return `Use only the \`ab\` command for the browser (it is agent-browser). Do not use the \`browser\` command. Chrome is already running with remote debugging on port ${port}. Put \`--session ${session} --cdp ${port} --pin-tab\` on every \`ab\` command. Run \`ab skills get core\` first to learn the commands.`;
    case "playwright-cli":
      return `Use only the \`pw\` command for the browser (it is Playwright CLI). Do not use the \`browser\` command. Chrome is already running with remote debugging at http://127.0.0.1:${port}. Attach once with \`pw attach --cdp=http://127.0.0.1:${port} --session=${session}\`, then put \`-s=${session}\` on every later \`pw\` command. Run \`pw --help\` first to learn the commands.`;
    default: {
      const unexpected: never = tool;
      throw new Error(`Unknown tool ${String(unexpected)}.`);
    }
  }
}

function codesMissing(reply: string, expected: string[]): string[] {
  return expected.filter((code) => !reply.includes(code));
}

/**
 * How much text one snapshot of each fake page costs the model. Playwright CLI
 * writes its snapshot to a file and prints only the path, so the file counts too.
 */
async function measureSnapshots(tool: Tool): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "companion-compare-snap-"));
  const site: FixtureSite = await startFixtureSite();
  const host = createBrowserHost({ directory: join(directory, "browser") });
  try {
    const { port } = await host.endpoint();
    // Asynchronous, because the fake site answers from this process and a
    // blocked event loop would leave every page load hanging.
    const run = async (args: string[]) => {
      const [node, script] = launchers[tool];
      try {
        const done = await promisify(execFile)(
          node ?? "node",
          [script ?? "", ...args],
          {
            cwd: directory,
            encoding: "utf8",
            env: { ...process.env, AGENT_BROWSER_NO_VERSION_CHECK: "1" },
            timeout: 60_000,
          },
        );
        return done.stdout;
      } catch (error) {
        throw new Error(`${tool} ${args.join(" ")} failed: ${String(error)}`);
      }
    };
    const sizes: Record<string, number> = {};
    // Own window in the shared Chrome, as the browser command would open.
    const target = await host.openWindow();
    if (tool === "agent-browser") {
      await run(["--session", "snap", "--cdp", String(port), "tab", target]);
    } else {
      await run(["attach", `--cdp=http://127.0.0.1:${port}`, "--session=snap"]);
    }
    try {
      for (const page of ["/items/2", "/awkward"]) {
        let text: string;
        if (tool === "agent-browser") {
          const base = [
            "--session",
            "snap",
            "--cdp",
            String(port),
            "--pin-tab",
          ];
          await run([...base, "open", `${site.url}${page}`]);
          text = await run([...base, "snapshot", "-i"]);
        } else {
          await run(["-s=snap", "goto", `${site.url}${page}`]);
          const printed = await run(["-s=snap", "snapshot"]);
          const folder = join(directory, ".playwright-cli");
          const files = existsSync(folder) ? readdirSync(folder) : [];
          const newest = files
            .map((name) => join(folder, name))
            .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
          text =
            printed +
            (newest === undefined ? "" : readFileSync(newest, "utf8"));
        }
        if (text.length === 0) {
          throw new Error(`${tool} printed no snapshot of ${page}.`);
        }
        sizes[page] = text.length;
      }
    } finally {
      await run(
        tool === "agent-browser"
          ? ["--session", "snap", "close"]
          : ["-s=snap", "close"],
      ).catch(() => undefined);
    }
    mkdirSync(dirname(resultsFile), { recursive: true });
    writeFileSync(
      `${resultsFile}.${tool}.snapshots.json`,
      JSON.stringify(sizes, null, 2),
    );
  } finally {
    await host.close();
    await site.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}
