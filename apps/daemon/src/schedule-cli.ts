/**
 * The `schedule` command a bot runs to manage its own schedules.
 *
 * It reads the daemon's address and its token from `.companion/schedule.json`
 * in the bot's folder, so it never says which bot it is, and prints one JSON
 * line. The daemon checks the times. This file only reads the arguments.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ScheduleAccess, ScheduleCommand } from "@companion/shared";

const usage = `schedule create --prompt "text" --cron "0 9 * * *" --tz Asia/Kolkata
schedule create --prompt "text" --every 30m [--tz Asia/Kolkata] [--weekdays mon,fri] [--window 09:00-17:00] [--until 2026-12-31T00:00:00+05:30]
schedule create --prompt "text" --at 2026-11-12T09:00:00+05:30
schedule list
schedule pause <id>
schedule resume <id>
schedule delete <id>
schedule help`;

const weekdaysByName: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/** Arguments that failed to parse, with the message to show the bot. */
export class ScheduleUsageError extends Error {}

/**
 * Reads one `schedule` command.
 * `now` is the instant an interval is anchored at, in epoch milliseconds.
 */
export function parseScheduleArgs(
  argv: string[],
  now: number,
): ScheduleCommand {
  const [command, ...rest] = argv;
  switch (command) {
    case "help":
    case undefined:
      if (rest.length > 0) fail("help takes no arguments.");
      return { command: "help" };
    case "list":
      if (rest.length > 0) fail("list takes no arguments.");
      return { command: "list" };
    case "pause":
    case "resume":
    case "delete":
      return { command, id: oneId(rest, command) };
    case "create":
      return { command: "create", body: createBody(flags(rest), now) };
    default:
      fail(`Unknown command "${command}".\n${usage}`);
  }
}

/**
 * Runs one `schedule` command and prints one JSON line.
 * Returns 0 when it worked and 1 when it did not, including a daemon error.
 */
export async function runScheduleCli(
  argv: string[],
  context: {
    cwd: string;
    now(): number;
    fetch: typeof fetch;
    print(text: string): void;
  },
): Promise<number> {
  let command: ScheduleCommand;
  try {
    command = parseScheduleArgs(argv, context.now());
  } catch (error) {
    return finish(context.print, 1, messageOf(error));
  }
  if (command.command === "help") {
    return finish(context.print, 0, undefined, { usage });
  }

  const access = readAccess(context.cwd);
  if (!access.ok) return finish(context.print, 1, access.error);

  const path = requestPath(command);
  let response: Response;
  try {
    response = await context.fetch(`${access.access.url}${path}`, {
      method: methodOf(command),
      headers: {
        authorization: `Bearer ${access.access.token}`,
        ...(command.command === "create"
          ? { "content-type": "application/json" }
          : {}),
      },
      ...(command.command === "create"
        ? { body: JSON.stringify(command.body) }
        : {}),
    });
  } catch {
    return finish(context.print, 1, "The daemon is not reachable.");
  }
  if (!response.ok) {
    return finish(context.print, 1, await errorText(response));
  }
  const body = (await response.json()) as unknown;
  return finish(context.print, 0, undefined, resultOf(command, body));
}

function requestPath(command: ScheduleCommand): string {
  switch (command.command) {
    case "create":
    case "list":
      return "/agent/schedules";
    case "pause":
      return `/agent/schedules/${encodeURIComponent(command.id)}/pause`;
    case "resume":
      return `/agent/schedules/${encodeURIComponent(command.id)}/resume`;
    case "delete":
      return `/agent/schedules/${encodeURIComponent(command.id)}`;
    case "help":
      return "";
    default: {
      const unexpected: never = command;
      return unexpected;
    }
  }
}

function methodOf(command: ScheduleCommand): string {
  switch (command.command) {
    case "list":
      return "GET";
    case "delete":
      return "DELETE";
    case "create":
    case "pause":
    case "resume":
      return "POST";
    case "help":
      return "GET";
    default: {
      const unexpected: never = command;
      return unexpected;
    }
  }
}

function resultOf(
  command: ScheduleCommand,
  body: unknown,
): Record<string, unknown> {
  switch (command.command) {
    case "list":
      return { schedules: body };
    case "delete":
      return isRecord(body) ? body : {};
    case "create":
    case "pause":
    case "resume":
      return { schedule: body };
    case "help":
      return {};
    default: {
      const unexpected: never = command;
      return unexpected;
    }
  }
}

function finish(
  print: (text: string) => void,
  code: number,
  error: string | undefined,
  extra: Record<string, unknown> = {},
): number {
  const line =
    error === undefined
      ? { ok: true, ...extra }
      : { ok: false, error, ...extra };
  print(`${JSON.stringify(line)}\n`);
  return code;
}

/**
 * Finds the daemon's address and this bot's token from anywhere inside the
 * bot's folder. `folder` is the bot's `.companion` directory, where other
 * commands keep their own state.
 */
export function readAccess(
  cwd: string,
):
  | { ok: true; access: ScheduleAccess; folder: string }
  | { ok: false; error: string } {
  const file = findAccessFile(cwd);
  if (file === undefined) {
    return {
      ok: false,
      error:
        "This directory is not inside a bot folder, so there is no daemon access here.",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { ok: false, error: `${file} could not be read.` };
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.url !== "string" ||
    typeof parsed.token !== "string" ||
    parsed.url === "" ||
    parsed.token === ""
  ) {
    return { ok: false, error: `${file} has no daemon url and token.` };
  }
  return {
    ok: true,
    access: { url: parsed.url, token: parsed.token },
    folder: dirname(file),
  };
}

/** Walks up from `cwd` to the filesystem root looking for the access file. */
function findAccessFile(cwd: string): string | undefined {
  let directory = resolve(cwd);
  for (;;) {
    const candidate = join(directory, ".companion", "schedule.json");
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // Not in this directory. Keep walking up.
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function createBody(
  parsed: Map<string, string>,
  now: number,
): Record<string, unknown> {
  const prompt = required(parsed, "prompt");
  const kinds = ["cron", "every", "at"].filter((name) => parsed.has(name));
  if (kinds.length === 0) {
    fail("create needs one of --cron, --every or --at.");
  }
  if (kinds.length > 1) {
    fail("create takes only one of --cron, --every or --at.");
  }
  const kind = kinds[0];
  switch (kind) {
    case "cron":
      return cronBody(parsed, prompt);
    case "every":
      return intervalBody(parsed, prompt, now);
    case "at":
      return onceBody(parsed, prompt);
    default:
      fail(`Unknown schedule kind "${kind ?? ""}".`);
  }
}

function cronBody(
  parsed: Map<string, string>,
  prompt: string,
): Record<string, unknown> {
  reject(parsed, ["weekdays", "window", "until"], "--cron");
  return {
    kind: "cron",
    prompt,
    expression: required(parsed, "cron"),
    timezone: required(parsed, "tz"),
  };
}

function intervalBody(
  parsed: Map<string, string>,
  prompt: string,
  now: number,
): Record<string, unknown> {
  const every = required(parsed, "every");
  const match = /^(\d+)([mhd])$/.exec(every);
  const amount = match === null ? Number.NaN : Number(match[1]);
  const unit = match?.[2];
  const everyMinutes =
    unit === "m" ? amount : unit === "h" ? amount * 60 : amount * 24 * 60;
  if (!Number.isInteger(everyMinutes) || everyMinutes < 1) {
    fail("--every takes a duration like 30m, 2h or 1d.");
  }
  const limited = parsed.has("weekdays") || parsed.has("window");
  if (limited && !parsed.has("tz")) {
    fail("--weekdays and --window need --tz, because they follow a clock.");
  }
  const body: Record<string, unknown> = {
    kind: "interval",
    prompt,
    everyMinutes,
    anchorAt: now,
    timezone: parsed.get("tz") ?? "UTC",
  };
  if (parsed.has("weekdays"))
    body.weekdays = weekdays(required(parsed, "weekdays"));
  if (parsed.has("window")) body.window = windowOf(required(parsed, "window"));
  if (parsed.has("until"))
    body.endsAt = instant(required(parsed, "until"), "--until");
  return body;
}

function onceBody(
  parsed: Map<string, string>,
  prompt: string,
): Record<string, unknown> {
  reject(parsed, ["tz", "weekdays", "window", "until"], "--at");
  return {
    kind: "once",
    prompt,
    at: instant(required(parsed, "at"), "--at"),
  };
}

/** An ISO time with an explicit offset, as epoch milliseconds. */
function instant(value: string, flag: string): number {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    fail(`${flag} needs a UTC offset, for example 2026-11-12T09:00:00+05:30.`);
  }
  const at = Date.parse(value);
  if (Number.isNaN(at)) fail(`${flag} is not a valid time: ${value}.`);
  return at;
}

function weekdays(value: string): number[] {
  const days = value
    .split(",")
    .map((day) => day.trim().toLowerCase())
    .filter((day) => day !== "");
  if (days.length === 0) fail("--weekdays needs at least one day.");
  return days.map((day) => {
    if (day in weekdaysByName) return weekdaysByName[day] ?? 0;
    if (/^[0-6]$/.test(day)) return Number(day);
    fail(
      `--weekdays has an unknown day "${day}". Use sun, mon, tue, wed, thu, fri, sat or 0 to 6.`,
    );
  });
}

function windowOf(value: string): { start: string; end: string } {
  const match = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(value);
  if (match === null)
    fail("--window takes HH:MM-HH:MM, for example 09:00-17:00.");
  return { start: match[1] ?? "", end: match[2] ?? "" };
}

function reject(
  parsed: Map<string, string>,
  names: string[],
  flag: string,
): void {
  for (const name of names) {
    if (parsed.has(name)) fail(`--${name} cannot be used with ${flag}.`);
  }
}

function required(parsed: Map<string, string>, name: string): string {
  const value = parsed.get(name);
  if (value === undefined || value.trim() === "") {
    fail(`--${name} is required.`);
  }
  return value.trim();
}

function flags(argv: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (!token.startsWith("--") || token === "--") {
      fail(`Unexpected argument "${token}".\n${usage}`);
    }
    const equals = token.indexOf("=");
    const name = token.slice(2, equals === -1 ? undefined : equals);
    if (name === "" || parsed.has(name)) {
      fail(`--${name} was given twice.`);
    }
    const value = equals === -1 ? argv[(index += 1)] : token.slice(equals + 1);
    if (value === undefined || value.startsWith("--")) {
      fail(`--${name} needs a value.`);
    }
    parsed.set(name, value);
  }
  return parsed;
}

function oneId(argv: string[], command: string): string {
  const [id, extra] = argv;
  if (id === undefined || id.startsWith("--") || id.trim() === "") {
    fail(`${command} needs the schedule id.`);
  }
  if (extra !== undefined) fail(`${command} takes only the schedule id.`);
  return id;
}

function fail(message: string): never {
  throw new ScheduleUsageError(message);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "The command failed.";
}

async function errorText(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as unknown;
    if (isRecord(body) && typeof body.error === "string") return body.error;
  } catch {
    // The body was not JSON. Fall through to the status.
  }
  return `The daemon returned ${response.status}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const code = await runScheduleCli(process.argv.slice(2), {
    cwd: process.cwd(),
    now: () => Date.now(),
    fetch,
    print: (text) => process.stdout.write(text),
  });
  process.exitCode = code;
}
