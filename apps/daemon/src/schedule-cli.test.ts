/**
 * Proves the `schedule` CLI reads its arguments and talks to the daemon.
 * The parser tests run with no daemon. The rest start a real daemon with a
 * scripted engine and run the CLI as its own process.
 */
import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { ScheduleListing } from "@companion/shared";
import { expect, test } from "vitest";
import { startDaemon, type Daemon } from "./api.js";
import type { Engine } from "./engine.js";
import { installScheduleShim } from "./engine.js";
import { parseScheduleArgs, ScheduleUsageError } from "./schedule-cli.js";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("./schedule-cli.ts", import.meta.url));
const now = Date.parse("2026-11-10T12:00:00Z");

const scripted: Engine = {
  async prompt() {
    return "end_turn";
  },
  async close() {},
};

test("create reads a cron, an interval and a one-time schedule", () => {
  expect(
    parseScheduleArgs(
      [
        "create",
        "--prompt",
        "Check",
        "--cron",
        "0 9 * * *",
        "--tz",
        "Asia/Kolkata",
      ],
      now,
    ),
  ).toEqual({
    command: "create",
    body: {
      kind: "cron",
      prompt: "Check",
      expression: "0 9 * * *",
      timezone: "Asia/Kolkata",
    },
  });
  expect(
    parseScheduleArgs(["create", "--prompt=Ping", "--every=2h"], now).body,
  ).toMatchObject({
    kind: "interval",
    everyMinutes: 120,
    anchorAt: now,
    timezone: "UTC",
  });
  expect(
    parseScheduleArgs(
      [
        "create",
        "--prompt",
        "Ping",
        "--every",
        "1d",
        "--tz",
        "Asia/Kolkata",
        "--weekdays",
        "Mon,fri,0",
        "--window",
        "09:00-17:00",
        "--until",
        "2026-12-31T00:00:00+05:30",
      ],
      now,
    ).body,
  ).toEqual({
    kind: "interval",
    prompt: "Ping",
    everyMinutes: 1440,
    anchorAt: now,
    timezone: "Asia/Kolkata",
    weekdays: [1, 5, 0],
    window: { start: "09:00", end: "17:00" },
    endsAt: Date.parse("2026-12-31T00:00:00+05:30"),
  });
  expect(
    parseScheduleArgs(
      ["create", "--prompt", "Once", "--at", "2026-11-12T09:00:00+05:30"],
      now,
    ).body,
  ).toEqual({
    kind: "once",
    prompt: "Once",
    at: Date.parse("2026-11-12T09:00:00+05:30"),
  });
  expect(
    parseScheduleArgs(
      ["create", "--prompt", "Once", "--at", "2026-11-12T09:00:00Z"],
      now,
    ).body,
  ).toMatchObject({
    at: Date.parse("2026-11-12T09:00:00Z"),
  });
});

test("bad arguments name what was wrong", () => {
  const bad: Array<[string[], string]> = [
    [["create", "--cron", "0 9 * * *", "--tz", "UTC"], "--prompt is required."],
    [
      ["create", "--prompt", "X"],
      "create needs one of --cron, --every or --at.",
    ],
    [
      [
        "create",
        "--prompt",
        "X",
        "--cron",
        "0 9 * * *",
        "--every",
        "30m",
        "--tz",
        "UTC",
      ],
      "create takes only one of --cron, --every or --at.",
    ],
    [["create", "--prompt", "X", "--cron", "0 9 * * *"], "--tz is required."],
    [
      ["create", "--prompt", "X", "--every", "30m", "--weekdays", "mon"],
      "--weekdays and --window need --tz",
    ],
    [
      ["create", "--prompt", "X", "--at", "2026-11-12T09:00:00"],
      "--at needs a UTC offset",
    ],
    [
      [
        "create",
        "--prompt",
        "X",
        "--at",
        "2026-11-12T09:00:00Z",
        "--tz",
        "UTC",
      ],
      "--tz cannot be used with --at.",
    ],
    [
      ["create", "--prompt", "X", "--every", "soon"],
      "--every takes a duration",
    ],
    [
      [
        "create",
        "--prompt",
        "X",
        "--every",
        "30m",
        "--weekdays",
        "fundays",
        "--tz",
        "UTC",
      ],
      "unknown day",
    ],
    [["create", "--prompt"], "--prompt needs a value."],
    [["nope", "--nope", "x"], "Unknown command"],
    [["pause"], "pause needs the schedule id."],
    [["pause", "one", "two"], "pause takes only the schedule id."],
    [["dance"], "Unknown command"],
  ];
  for (const [argv, expected] of bad) {
    expect(() => parseScheduleArgs(argv, now), argv.join(" ")).toThrow(
      ScheduleUsageError,
    );
    expect(() => parseScheduleArgs(argv, now), argv.join(" ")).toThrow(
      expected,
    );
  }
});

test("the commands reach the daemon and come back as JSON", async () => {
  await withBots(async ({ directory, bot, other }) => {
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const created = await cliJson(bot, [
      "create",
      "--prompt",
      "Check the weather",
      "--cron",
      "0 9 * * *",
      "--tz",
      "Asia/Kolkata",
    ]);
    expect(created).toMatchObject({
      ok: true,
      schedule: {
        kind: "cron",
        expression: "0 9 * * *",
        timezone: "Asia/Kolkata",
        paused: false,
      },
    });
    expect(created.schedule.nextRunAt).toEqual(expect.any(String));

    const interval = await cliJson(bot, [
      "create",
      "--prompt",
      "Ping",
      "--every",
      "30m",
    ]);
    expect(interval.schedule).toMatchObject({
      kind: "interval",
      everyMinutes: 30,
      timezone: "UTC",
    });

    const once = await cliJson(bot, ["create", "--prompt", "Once", "--at", at]);
    expect(once.schedule).toMatchObject({ kind: "once" });

    const listed = await cliJson(bot, ["list"]);
    expect(listed.schedules).toHaveLength(3);

    const paused = await cliJson(bot, ["pause", created.schedule.id]);
    expect(paused.schedule).toMatchObject({ paused: true, nextRunAt: null });
    const afterPause = await cliJson(bot, ["list"]);
    expect(
      afterPause.schedules.find((item) => item.id === created.schedule.id)
        ?.paused,
    ).toBe(true);

    const resumed = await cliJson(bot, ["resume", created.schedule.id]);
    expect(resumed.schedule.paused).toBe(false);
    expect(resumed.schedule.nextRunAt).toEqual(expect.any(String));

    const removed = await cliJson(bot, ["delete", once.schedule.id]);
    expect(removed).toEqual({ ok: true, deleted: once.schedule.id });
    expect((await cliJson(bot, ["list"])).schedules).toHaveLength(2);

    const nested = join(bot, "notes", "today");
    mkdir(nested);
    expect((await cliJson(nested, ["list"])).schedules).toHaveLength(2);

    const shim = join(directory, "bin", "schedule");
    installScheduleShim(join(directory, "bin"));
    const throughShim = await run(shim, ["list"], { cwd: bot });
    expect(JSON.parse(throughShim.stdout).schedules).toHaveLength(2);

    expect(other).not.toBe(bot);
  });
});

test("bad input, another bot and a missing daemon all fail cleanly", async () => {
  await withBots(async ({ daemon, bot, other }) => {
    const badCron = await cliRun(bot, [
      "create",
      "--prompt",
      "X",
      "--cron",
      "nope",
      "--tz",
      "UTC",
    ]);
    expect(badCron.code).toBe(1);
    expect(badCron.json).toMatchObject({
      ok: false,
      error: expect.stringContaining("five fields"),
    });

    const badZone = await cliRun(bot, [
      "create",
      "--prompt",
      "X",
      "--cron",
      "0 9 * * *",
      "--tz",
      "Mars/Base",
    ]);
    expect(badZone.json.error).toContain("IANA");

    const past = await cliRun(bot, [
      "create",
      "--prompt",
      "X",
      "--at",
      "2020-01-01T00:00:00Z",
    ]);
    expect(past.json).toMatchObject({
      ok: false,
      error: "A one-time schedule must be in the future.",
    });

    const tooLong = await cliRun(bot, [
      "create",
      "--prompt",
      "X",
      "--every",
      "25h",
    ]);
    expect(tooLong.json.error).toContain("whole number from 1 to 1440");

    const created = await cliJson(bot, [
      "create",
      "--prompt",
      "Mine",
      "--every",
      "1h",
    ]);
    for (const command of ["pause", "resume", "delete"] as const) {
      const foreign = await cliRun(other, [command, created.schedule.id]);
      expect(foreign.code, command).toBe(1);
      expect(foreign.json.error, command).toBe(
        `Unknown schedule ${created.schedule.id}.`,
      );
    }
    expect((await cliJson(other, ["list"])).schedules).toEqual([]);
    expect(daemon.listSchedules()).toHaveLength(1);

    const access = JSON.parse(
      readFileSync(join(bot, ".companion", "schedule.json"), "utf8"),
    ) as { url: string; token: string };
    writeFileSync(
      join(bot, ".companion", "schedule.json"),
      JSON.stringify({ ...access, token: "nope" }),
    );
    const tampered = await cliRun(bot, ["list"]);
    expect(tampered.json).toMatchObject({
      ok: false,
      error: "Unknown or missing schedule token.",
    });
    writeFileSync(
      join(bot, ".companion", "schedule.json"),
      JSON.stringify(access),
    );

    const elsewhere = mkdtempSync(join(tmpdir(), "companion-not-a-bot-"));
    try {
      const lost = await cliRun(elsewhere, ["list"]);
      expect(lost.json.error).toContain("not inside a bot folder");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }

    const url = daemon.url;
    await daemon.close();
    writeFileSync(
      join(bot, ".companion", "schedule.json"),
      JSON.stringify({ url, token: access.token }),
    );
    const down = await cliRun(bot, ["list"]);
    expect(down.json).toMatchObject({
      ok: false,
      error: "The daemon is not reachable.",
    });
  });
});

test("a one-time schedule created through the CLI fires once", async () => {
  const prompts: string[] = [];
  await withBots(
    async ({ daemon, bot }) => {
      const at = new Date(Date.now() + 1_000).toISOString();
      const created = await cliJson(bot, [
        "create",
        "--prompt",
        "Check the weather",
        "--at",
        at,
      ]);
      await waitFor(() => prompts.includes("Check the weather"));
      expect(daemon.receipts(created.schedule.id)).toEqual([Date.parse(at)]);
    },
    {
      async prompt(_botId, text) {
        prompts.push(text);
        return "end_turn";
      },
      async close() {},
    },
  );
});

type CliSchedule = ScheduleListing;

async function withBots(
  runCase: (started: {
    daemon: Daemon;
    directory: string;
    bot: string;
    other: string;
  }) => Promise<void>,
  engine: Engine = scripted,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "companion-cli-"));
  const daemon = await startDaemon({
    storePath: join(directory, "threads.db"),
    engine,
  });
  try {
    const bot = await createBot(daemon, "Ada");
    const other = await createBot(daemon, "Bea");
    await runCase({ daemon, directory, bot, other });
  } finally {
    await daemon.close().catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
}

async function createBot(daemon: Daemon, name: string): Promise<string> {
  const response = await fetch(`${daemon.url}/bots`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(201);
  const bot = (await response.json()) as { directory: string };
  return bot.directory;
}

type CliResult = {
  code: number;
  json: {
    ok: boolean;
    error: string;
    schedule: CliSchedule;
    schedules: CliSchedule[];
  };
};

async function cliRun(cwd: string, args: string[]): Promise<CliResult> {
  const result = await run(process.execPath, [cli, ...args], { cwd }).catch(
    (error: { code?: number; stdout?: string }) => error,
  );
  const stdout = result.stdout ?? "";
  return {
    code: result.code ?? 0,
    json: JSON.parse(stdout) as CliResult["json"],
  };
}

async function cliJson(
  cwd: string,
  args: string[],
): Promise<CliResult["json"]> {
  const result = await cliRun(cwd, args);
  expect(result, args.join(" ")).toMatchObject({ code: 0, json: { ok: true } });
  return result.json;
}

function mkdir(path: string): void {
  mkdirSync(path, { recursive: true });
}

async function waitFor(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!ready()) {
    if (Date.now() >= deadline) throw new Error("The schedule did not fire.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
