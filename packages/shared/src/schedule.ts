/**
 * When a schedule will next send its prompt.
 *
 * The daemon fires schedules, and later the control plane wakes a stopped
 * computer from the same instants. Both call these functions. Nothing here
 * stores a schedule or starts a turn.
 *
 * Croner computes the calendar dates, including daylight saving, and its
 * finest schedule is one minute. This file decides which kind of schedule it
 * is, and steps an interval in real minutes rather than clock hours.
 * The instant `nextRun` returns is the occurrence: pass it back as `now` and
 * the following occurrence comes back.
 */
import { Cron, CronDate } from "croner";

const minimumIntervalMinutes = 1;
const maxIntervalMinutes = 24 * 60;
const minuteMs = 60_000;
/** Stops a weekday and window search that never lands. */
const intervalSearchSteps = 11_000;

const ianaZone = /^(?:UTC|[A-Za-z][\w+-]*(?:\/[\w+-]+){1,2})$/;
const clockTime = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A same-day limit on an interval. `start` runs, `end` does not. */
export type ScheduleWindow = {
  start: string;
  end: string;
};

type ScheduleText = {
  id: string;
  botId: string;
  prompt: string;
};

/** Calendar times. Five cron fields, read in `timezone`. */
export type CronSchedule = ScheduleText & {
  kind: "cron";
  expression: string;
  timezone: string;
};

/**
 * Real minutes measured from `anchorAt`.
 * Weekdays and `window` are wall-clock limits in `timezone`.
 * `endsAt` is the last instant that still runs.
 * Weekday 0 is Sunday, matching cron.
 */
export type IntervalSchedule = ScheduleText & {
  kind: "interval";
  everyMinutes: number;
  anchorAt: number;
  timezone: string;
  weekdays?: number[];
  window?: ScheduleWindow;
  endsAt?: number;
};

/** One instant, already resolved to UTC milliseconds. */
export type OnceSchedule = ScheduleText & {
  kind: "once";
  at: number;
};

/** A prompt to send into one bot's conversation at later times. */
export type Schedule = CronSchedule | IntervalSchedule | OnceSchedule;

/** A schedule that can be stored, or the reason it cannot. */
export type ScheduleValidation =
  { ok: true; schedule: Schedule } | { ok: false; reason: string };

/**
 * Accept a schedule whose times can be computed.
 * The caller supplies the timezone or the instant. This does not infer one.
 */
export function validateSchedule(input: unknown): ScheduleValidation {
  if (!isRecord(input)) return invalid("A schedule must be an object.");
  const id = requiredText(input.id);
  if (id === null) return invalid("A schedule needs an id.");
  const botId = requiredText(input.botId);
  if (botId === null) return invalid("A schedule needs a bot.");
  const prompt = requiredText(input.prompt);
  if (prompt === null) return invalid("A schedule needs a prompt.");
  const text = { id, botId, prompt };

  switch (input.kind) {
    case "cron":
      return validateCron(text, input);
    case "interval":
      return validateInterval(text, input);
    case "once":
      return validateOnce(text, input);
    default:
      return invalid("A schedule kind must be cron, interval, or once.");
  }
}

/**
 * The earliest occurrence strictly after `now`.
 * `now` and the result are UTC epoch milliseconds.
 * The result names that occurrence for a later exactly-once fire.
 */
export function nextRun(schedule: Schedule, now: number): number | null {
  switch (schedule.kind) {
    case "cron":
      return nextCron(schedule, now);
    case "interval":
      return nextInterval(schedule, now);
    case "once":
      return schedule.at > now ? schedule.at : null;
    default: {
      const unexpected: never = schedule;
      return unexpected;
    }
  }
}

/** Up to `count` occurrences after `now`, in order. */
export function nextRuns(
  schedule: Schedule,
  now: number,
  count: number,
): number[] {
  if (!Number.isInteger(count) || count < 1) return [];
  const runs: number[] = [];
  let cursor = now;
  for (let index = 0; index < count; index += 1) {
    const at = nextRun(schedule, cursor);
    if (at === null) break;
    runs.push(at);
    cursor = at;
  }
  return runs;
}

/**
 * A short phrase for when a schedule runs.
 * The schedules panel shows this under the prompt. It is not a cron field.
 */
export function describeSchedule(schedule: Schedule): string {
  switch (schedule.kind) {
    case "cron":
      return describeCron(schedule.expression);
    case "interval":
      return describeInterval(schedule);
    case "once":
      return "Once";
    default: {
      const unexpected: never = schedule;
      return unexpected;
    }
  }
}

function validateCron(
  text: ScheduleText,
  input: Record<string, unknown>,
): ScheduleValidation {
  if (typeof input.expression !== "string") {
    return invalid(
      "A cron expression needs five fields: minute, hour, day of month, month, and day of week.",
    );
  }
  const expression = input.expression.trim().replace(/\s+/g, " ");
  if (expression.includes("@")) {
    return invalid("A cron expression cannot use a macro such as @daily.");
  }
  if (expression.split(" ").length !== 5) {
    return invalid(
      "A cron expression needs five fields: minute, hour, day of month, month, and day of week.",
    );
  }
  if (!knownTimeZone(input.timezone)) {
    return invalid(
      "A cron timezone must be an IANA name such as Asia/Kolkata.",
    );
  }
  const timezone = input.timezone;
  try {
    cronOf(expression, timezone);
  } catch {
    return invalid("A cron expression is invalid.");
  }
  const schedule: CronSchedule = {
    ...text,
    kind: "cron",
    expression,
    timezone,
  };
  return { ok: true, schedule };
}

function validateInterval(
  text: ScheduleText,
  input: Record<string, unknown>,
): ScheduleValidation {
  const everyMinutes = input.everyMinutes;
  if (
    typeof everyMinutes !== "number" ||
    !Number.isInteger(everyMinutes) ||
    everyMinutes < minimumIntervalMinutes ||
    everyMinutes > maxIntervalMinutes
  ) {
    return invalid("Interval minutes must be a whole number from 1 to 1440.");
  }
  if (!isEpoch(input.anchorAt))
    return invalid("An interval needs a start time.");
  if (!knownTimeZone(input.timezone)) {
    return invalid(
      "An interval timezone must be an IANA name such as Asia/Kolkata.",
    );
  }
  const weekdays = weekdaysOf(input.weekdays);
  if (weekdays === "invalid") {
    return invalid(
      "Interval weekdays must be between 0 (Sunday) and 6 (Saturday).",
    );
  }
  const window = readWindow(input.window, everyMinutes);
  if (!window.ok) return invalid(window.reason);
  if (input.endsAt !== undefined && !isEpoch(input.endsAt))
    return invalid("An interval end must be a time.");
  if (isEpoch(input.endsAt) && input.endsAt < input.anchorAt) {
    return invalid("An interval end must not be before its start.");
  }

  const schedule: IntervalSchedule = {
    ...text,
    kind: "interval",
    everyMinutes,
    anchorAt: input.anchorAt,
    timezone: input.timezone,
    ...(weekdays === undefined ? {} : { weekdays }),
    ...(window.window === undefined ? {} : { window: window.window }),
    ...(isEpoch(input.endsAt) ? { endsAt: input.endsAt } : {}),
  };
  return { ok: true, schedule };
}

function validateOnce(
  text: ScheduleText,
  input: Record<string, unknown>,
): ScheduleValidation {
  if (!isEpoch(input.at)) return invalid("A one-time schedule needs a time.");
  const schedule: OnceSchedule = { ...text, kind: "once", at: input.at };
  return { ok: true, schedule };
}

function nextCron(schedule: CronSchedule, now: number): number | null {
  const next = cronOf(schedule.expression, schedule.timezone).nextRun(
    new Date(now),
  );
  if (next === null) return null;
  const at = next.getTime();
  return at > now ? at : null;
}

/**
 * Fixed clock times move through a daylight-saving gap and run once in a
 * repeated hour. A list or a step keeps both passes of a repeated hour and
 * skips a time that does not exist. That is croner's rule.
 */
function cronOf(expression: string, timezone: string): Cron {
  return new Cron(expression, { timezone, paused: true, mode: "5-part" });
}

function nextInterval(schedule: IntervalSchedule, now: number): number | null {
  const step = schedule.everyMinutes * minuteMs;
  let candidate = firstGridAfter(schedule.anchorAt, step, now);
  if (candidate === null) return null;
  if (schedule.weekdays === undefined && schedule.window === undefined) {
    return pastEnd(schedule, candidate) ? null : candidate;
  }

  for (let guard = 0; guard < intervalSearchSteps; guard += 1) {
    if (pastEnd(schedule, candidate)) return null;
    if (intervalAllows(schedule, candidate)) return candidate;
    const next = nextOpening(schedule, candidate, step);
    if (next === null || next <= candidate) return null;
    candidate = next;
  }
  return null;
}

function firstGridAfter(
  anchorAt: number,
  step: number,
  now: number,
): number | null {
  if (anchorAt > now) return anchorAt;
  const steps = Math.floor((now - anchorAt) / step) + 1;
  const at = anchorAt + steps * step;
  if (!Number.isSafeInteger(at) || at <= now) return null;
  return at;
}

function pastEnd(schedule: IntervalSchedule, at: number): boolean {
  return schedule.endsAt !== undefined && at > schedule.endsAt;
}

function intervalAllows(schedule: IntervalSchedule, at: number): boolean {
  const local = zoned(at, schedule.timezone);
  if (
    schedule.weekdays !== undefined &&
    !schedule.weekdays.includes(local.weekday)
  ) {
    return false;
  }
  if (schedule.window === undefined) return true;
  const start = minutesOfClock(schedule.window.start);
  const end = minutesOfClock(schedule.window.end);
  return local.minute >= start && local.minute < end;
}

/** The next grid point inside a later allowed weekday and window. */
function nextOpening(
  schedule: IntervalSchedule,
  candidate: number,
  step: number,
): number | null {
  const local = zoned(candidate, schedule.timezone);
  const start =
    schedule.window === undefined ? 0 : minutesOfClock(schedule.window.start);
  const weekdayOk =
    schedule.weekdays === undefined ||
    schedule.weekdays.includes(local.weekday);
  let daysAhead = 1;
  if (weekdayOk && local.minute < start) {
    daysAhead = 0;
  } else if (schedule.weekdays !== undefined) {
    for (let ahead = 1; ahead <= 7; ahead += 1) {
      if (schedule.weekdays.includes((local.weekday + ahead) % 7)) {
        daysAhead = ahead;
        break;
      }
    }
  }
  const date = new Date(
    Date.UTC(local.year, local.month - 1, local.day + daysAhead),
  );
  const opening = atWall(
    schedule.timezone,
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    start,
  );
  if (opening === null) return null;
  const earliest = Math.max(opening, candidate + minuteMs);
  if (earliest <= schedule.anchorAt) return schedule.anchorAt;
  const steps = Math.ceil((earliest - schedule.anchorAt) / step);
  const at = schedule.anchorAt + steps * step;
  if (!Number.isSafeInteger(at)) return null;
  return at < earliest ? at + step : at;
}

/** Wall-clock fields of an instant, read by croner in the schedule's zone. */
function zoned(
  ms: number,
  timezone: string,
): {
  year: number;
  month: number;
  day: number;
  minute: number;
  weekday: number;
} {
  const local = new CronDate(new Date(ms), timezone);
  return {
    year: local.year,
    month: local.month + 1,
    day: local.day,
    minute: local.hour * 60 + local.minute,
    weekday: new Date(Date.UTC(local.year, local.month, local.day)).getUTCDay(),
  };
}

/**
 * UTC milliseconds of one wall-clock minute.
 * Croner decides the instant, including a daylight-saving gap: 2:30 in a
 * spring-forward hour comes back as 3:00, the same instant a cron would fire.
 */
function atWall(
  timezone: string,
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
): number | null {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const midnight = new CronDate(null, timezone);
  midnight.year = year;
  midnight.month = month - 1;
  midnight.day = day;
  midnight.hour = 0;
  midnight.minute = 0;
  midnight.second = 0;
  midnight.ms = 0;
  const next = cronOf(`${minute} ${hour} * * *`, timezone).nextRun(
    new Date(midnight.getTime() - minuteMs),
  );
  if (next === null) return null;
  const local = new CronDate(next, timezone);
  if (local.year !== year || local.month !== month - 1 || local.day !== day) {
    return null;
  }
  return next.getTime();
}

function weekdaysOf(value: unknown): number[] | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) return "invalid";
  const weekdays: number[] = [];
  for (const day of value) {
    if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6)
      return "invalid";
    if (!weekdays.includes(day)) weekdays.push(day);
  }
  weekdays.sort((left, right) => left - right);
  return weekdays;
}

function readWindow(
  value: unknown,
  everyMinutes: number,
):
  | { ok: true; window: ScheduleWindow | undefined }
  | { ok: false; reason: string } {
  if (value === undefined) return { ok: true, window: undefined };
  if (
    !isRecord(value) ||
    typeof value.start !== "string" ||
    typeof value.end !== "string" ||
    !clockTime.test(value.start) ||
    !clockTime.test(value.end)
  ) {
    return { ok: false, reason: "An interval window must use 24-hour HH:MM." };
  }
  const start = minutesOfClock(value.start);
  const end = minutesOfClock(value.end);
  if (start >= end)
    return {
      ok: false,
      reason: "An interval window must end later on the same day.",
    };
  if (end - start < everyMinutes) {
    return {
      ok: false,
      reason: "An interval window must be at least as long as the interval.",
    };
  }
  return { ok: true, window: { start: value.start, end: value.end } };
}

function minutesOfClock(value: string): number {
  const match = clockTime.exec(value);
  if (match === null) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

function knownTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64 || !ianaZone.test(value))
    return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function requiredText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(reason: string): ScheduleValidation {
  return { ok: false, reason };
}

const weekdayNames = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const weekdayAlias: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function describeCron(expression: string): string {
  const [minute, hour, day, month, weekday] = expression.split(" ");
  if (
    minute === undefined ||
    hour === undefined ||
    day === undefined ||
    month === undefined ||
    weekday === undefined ||
    expression.split(" ").length !== 5
  ) {
    return "On a custom schedule";
  }
  if (day === "*" && month === "*" && weekday === "*") {
    const stepped = steppedPhrase(minute, hour);
    if (stepped !== null) return stepped;
  }
  if (day === "*" && month === "*") {
    const clock = clockPhrase(minute, hour);
    const days = weekdayPhrase(weekday);
    if (clock !== null && days !== null) {
      if (days === "every day") return `Every day at ${clock}`;
      if (days === "weekdays") return `Weekdays at ${clock}`;
      if (days === "weekends") return `Weekends at ${clock}`;
      return `${days} at ${clock}`;
    }
  }
  return "On a custom schedule";
}

function describeInterval(schedule: IntervalSchedule): string {
  const extras: string[] = [];
  if (schedule.weekdays !== undefined) {
    const days = weekdayList(schedule.weekdays);
    if (days === "weekdays") extras.push("on weekdays");
    else if (days === "weekends") extras.push("on weekends");
    else if (days !== null && days !== "every day") extras.push(`on ${days}`);
  }
  if (schedule.window !== undefined) {
    extras.push(
      `from ${clockFromHHMM(schedule.window.start)} to ${clockFromHHMM(schedule.window.end)}`,
    );
  }
  const every = everyPhrase(schedule.everyMinutes);
  return extras.length === 0 ? every : `${every}, ${extras.join(", ")}`;
}

function everyPhrase(minutes: number): string {
  if (minutes === 1) return "Every minute";
  if (minutes < 60) return `Every ${minutes} minutes`;
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "Every hour" : `Every ${hours} hours`;
  }
  return `Every ${minutes} minutes`;
}

function steppedPhrase(minute: string, hour: string): string | null {
  const minuteStep = stepOf(minute);
  if (minuteStep !== null && hour === "*") {
    return minuteStep === 1 ? "Every minute" : `Every ${minuteStep} minutes`;
  }
  const hourStep = stepOf(hour);
  if (minute === "0" && hourStep !== null) {
    return hourStep === 1 ? "Every hour" : `Every ${hourStep} hours`;
  }
  return null;
}

function stepOf(field: string): number | null {
  const match = /^\*\/(\d+)$/.exec(field);
  if (match === null) return null;
  const value = Number(match[1]);
  if (!Number.isInteger(value) || value < 1) return null;
  return value;
}

function clockPhrase(minute: string, hour: string): string | null {
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null;
  const minutes = Number(minute);
  const hours = Number(hour);
  if (minutes > 59 || hours > 23) return null;
  return formatClock(hours, minutes);
}

function clockFromHHMM(value: string): string {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (match === null) return value;
  return formatClock(Number(match[1]), Number(match[2]));
}

function formatClock(hours: number, minutes: number): string {
  const period = hours < 12 ? "AM" : "PM";
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${minutes.toString().padStart(2, "0")} ${period}`;
}

/** Days named the way the panel reads them, or null when the field is not a list of days. */
function weekdayPhrase(field: string): string | null {
  const days = parseWeekdayField(field);
  return days === null ? null : weekdayList(days);
}

function weekdayList(days: number[]): string | null {
  const unique = [...new Set(days)].sort((left, right) => left - right);
  if (unique.some((day) => weekdayNames[day] === undefined)) return null;
  if (unique.length === 7) return "every day";
  if (unique.length === 5 && unique.every((day, index) => day === index + 1)) {
    return "weekdays";
  }
  if (unique.length === 2 && unique[0] === 0 && unique[1] === 6) {
    return "weekends";
  }
  const labels = unique.map((day) => `${weekdayNames[day]}s`);
  if (labels.length === 1) return labels[0] ?? null;
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
}

function parseWeekdayField(field: string): number[] | null {
  if (field === "*") return [0, 1, 2, 3, 4, 5, 6];
  if (field.includes("/")) return null;
  const days: number[] = [];
  for (const part of field.split(",")) {
    const range = part.split("-");
    if (range.length === 1) {
      const day = weekdayNumber(range[0] ?? "");
      if (day === null) return null;
      days.push(day);
      continue;
    }
    if (range.length !== 2) return null;
    const start = weekdayNumber(range[0] ?? "");
    const end = weekdayNumber(range[1] ?? "");
    if (start === null || end === null || start > end) return null;
    for (let day = start; day <= end; day += 1) days.push(day);
  }
  return days.length === 0 ? null : days;
}

function weekdayNumber(token: string): number | null {
  const named = weekdayAlias[token.toLowerCase()];
  if (named !== undefined) return named;
  if (!/^\d+$/.test(token)) return null;
  const day = Number(token);
  if (day === 7) return 0;
  if (day < 0 || day > 6) return null;
  return day;
}
