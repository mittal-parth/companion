/**
 * When a schedule will next send its prompt.
 *
 * The daemon fires schedules, and later the control plane wakes a stopped
 * computer from the same instants. Both call these functions. Nothing here
 * stores a schedule or starts a turn.
 *
 * A cron schedule is a calendar time in its own timezone. An interval is a
 * fixed number of real minutes from an anchor, so "every two hours" does not
 * drift across a daylight-saving change. A once schedule is a single instant.
 * The instant `nextRun` returns is the occurrence: pass it back as `now` and
 * the following occurrence comes back.
 */
import { Cron, CronPattern } from "croner";

const minimumGapMinutes = 5;
const maxIntervalMinutes = 24 * 60;
const minuteMs = 60_000;
const minutesPerDay = 24 * 60;
const dayMs = minutesPerDay * minuteMs;
/** Long enough to see a weekday line up with any 5-minute grid. */
const intervalSearchSteps = 11_000;

const ianaZone = /^(?:UTC|[A-Za-z][\w+-]*(?:\/[\w+-]+){1,2})$/;
const clockTime = /^([01]\d|2[0-3]):([0-5]\d)$/;

const weekdayNumber: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

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
    parseCron(expression, timezone);
  } catch {
    return invalid("A cron expression is invalid.");
  }
  if (closerThanMinimum(expression, timezone)) {
    return invalid("A schedule must be at least 5 minutes apart.");
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
    everyMinutes < minimumGapMinutes ||
    everyMinutes > maxIntervalMinutes
  ) {
    return invalid("Interval minutes must be a whole number from 5 to 1440.");
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

function parseCron(expression: string, timezone: string): CronPattern {
  return new CronPattern(expression, timezone, { mode: "5-part" });
}

/**
 * Reject a cron whose clock times can fall under 5 minutes apart.
 * Day restrictions only remove runs, so a clock gap of 5 minutes or more is
 * always far enough. A closer pair is allowed only when no real day matches
 * it, such as 31 February.
 */
function closerThanMinimum(expression: string, timezone: string): boolean {
  const pattern = parseCron(expression, timezone);
  const clock = clockMinutesOf(pattern);
  if (clock.length === 0) return false;
  const firstMinute = clock[0] ?? 0;
  const lastMinute = clock[clock.length - 1] ?? firstMinute;
  let sameDay = minutesPerDay;
  for (let index = 1; index < clock.length; index += 1) {
    const earlier = clock[index - 1] ?? 0;
    const later = clock[index] ?? earlier;
    sameDay = Math.min(sameDay, later - earlier);
  }
  const wrap =
    clock.length === 1
      ? minutesPerDay
      : minutesPerDay - lastMinute + firstMinute;
  if (sameDay >= minimumGapMinutes && wrap >= minimumGapMinutes) return false;
  if (sameDay < minimumGapMinutes) {
    const first = cronOf(expression, timezone).nextRun(
      new Date(Date.UTC(2020, 0, 1)),
    );
    return first !== null && first.getTime() < Date.UTC(2040, 0, 1);
  }
  if (runsEveryDay(pattern)) return true;
  // The only remaining short gap is overnight. Adjacent weekdays meet it; others do not.
  const overnight = overnightGap(pattern);
  if (overnight !== "scan") return overnight;
  return wrapHappens(expression, timezone, lastMinute, firstMinute);
}

function clockMinutesOf(pattern: CronPattern): number[] {
  const minutes = selected(pattern.minute);
  const hours = selected(pattern.hour);
  const clock: number[] = [];
  for (const hour of hours) {
    for (const minute of minutes) clock.push(hour * 60 + minute);
  }
  clock.sort((left, right) => left - right);
  return clock;
}

function selected(flags: number[]): number[] {
  const values: number[] = [];
  for (let index = 0; index < flags.length; index += 1) {
    if (flags[index]) values.push(index);
  }
  return values;
}

function runsEveryDay(pattern: CronPattern): boolean {
  return (
    pattern.starDOM &&
    pattern.starDOW &&
    !pattern.lastDayOfMonth &&
    !pattern.lastWeekday &&
    pattern.month.every(Boolean) &&
    pattern.nearestWeekdays.every((flag) => flag === 0)
  );
}

/**
 * Whether the overnight pair can land on two calendar days this expression matches.
 * A day-of-week list is enough to know. A day-of-month limit needs a search.
 */
function overnightGap(pattern: CronPattern): boolean | "scan" {
  if (
    !pattern.starDOM ||
    pattern.lastDayOfMonth ||
    pattern.lastWeekday ||
    pattern.nearestWeekdays.some((flag) => flag !== 0)
  ) {
    return "scan";
  }
  const days = selected(pattern.dayOfWeek);
  for (const day of days) {
    if (days.includes((day + 1) % 7)) return true;
  }
  return false;
}

/** True when the last clock time of a day and the first of the next day both run. */
function wrapHappens(
  expression: string,
  timezone: string,
  late: number,
  early: number,
): boolean {
  const cron = cronOf(expression, timezone);
  let cursor = Date.UTC(2024, 0, 1);
  const end = Date.UTC(2028, 0, 1);
  while (cursor < end) {
    const next = cron.nextRun(new Date(cursor));
    if (next === null || next.getTime() >= end) return false;
    const local = wallClock(next.getTime(), timezone);
    const tomorrow = addDays(local, 1);
    const lateAt = utcFromWall(
      timezone,
      local.year,
      local.month,
      local.day,
      late,
    );
    const earlyAt = utcFromWall(
      timezone,
      tomorrow.year,
      tomorrow.month,
      tomorrow.day,
      early,
    );
    if (
      lateAt !== null &&
      earlyAt !== null &&
      earlyAt - lateAt < minimumGapMinutes * minuteMs &&
      cronHits(cron, lateAt) &&
      cronHits(cron, earlyAt)
    ) {
      return true;
    }
    const nextDay = utcFromWall(
      timezone,
      tomorrow.year,
      tomorrow.month,
      tomorrow.day,
      0,
    );
    cursor =
      nextDay !== null && nextDay > next.getTime()
        ? nextDay
        : next.getTime() + dayMs;
  }
  return false;
}

function cronHits(cron: Cron, at: number): boolean {
  const next = cron.nextRun(new Date(at - 1000));
  return next !== null && next.getTime() === at;
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
  const local = wallClock(at, schedule.timezone);
  if (
    schedule.weekdays !== undefined &&
    !schedule.weekdays.includes(local.weekday)
  )
    return false;
  if (schedule.window === undefined) return true;
  const minute = local.hour * 60 + local.minute;
  const start = minutesOfClock(schedule.window.start);
  const end = minutesOfClock(schedule.window.end);
  return minute >= start && minute < end;
}

/** The next grid point inside a later allowed weekday and window. */
function nextOpening(
  schedule: IntervalSchedule,
  candidate: number,
  step: number,
): number | null {
  const local = wallClock(candidate, schedule.timezone);
  const start =
    schedule.window === undefined ? 0 : minutesOfClock(schedule.window.start);
  const minute = local.hour * 60 + local.minute;
  const weekdayOk =
    schedule.weekdays === undefined ||
    schedule.weekdays.includes(local.weekday);
  // Still before today's window: try today. Otherwise the next allowed weekday.
  const daysAhead =
    weekdayOk && minute < start
      ? 0
      : daysUntilWeekday(local.weekday, schedule.weekdays);
  const date = addDays(local, daysAhead);
  const opening = utcAtOrAfterWall(
    schedule.timezone,
    date.year,
    date.month,
    date.day,
    start,
  );
  if (opening === null) return null;
  // A skipped daylight-saving hour can put the opening on the candidate already rejected.
  const earliest = Math.max(opening, candidate + minuteMs);
  return ceilGrid(schedule.anchorAt, step, earliest);
}

function daysUntilWeekday(
  weekday: number,
  weekdays: number[] | undefined,
): number {
  if (weekdays === undefined) return 1;
  for (let ahead = 1; ahead <= 7; ahead += 1) {
    if (weekdays.includes((weekday + ahead) % 7)) return ahead;
  }
  return 1;
}

function ceilGrid(
  anchorAt: number,
  step: number,
  target: number,
): number | null {
  if (target <= anchorAt) return anchorAt;
  const steps = Math.ceil((target - anchorAt) / step);
  const at = anchorAt + steps * step;
  if (!Number.isSafeInteger(at)) return null;
  return at < target ? at + step : at;
}

type Wall = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

function wallClock(epochMs: number, timeZone: string): Wall {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  let hour = Number(read("hour"));
  if (hour === 24) hour = 0;
  return {
    year: Number(read("year")),
    month: Number(read("month")),
    day: Number(read("day")),
    hour,
    minute: Number(read("minute")),
    weekday: weekdayNumber[read("weekday")] ?? 0,
  };
}

/** The UTC instant of a wall-clock minute, or null when that minute is skipped. */
function utcFromWall(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
): number | null {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const candidates = [
    asUtc,
    asUtc - 14 * 60 * minuteMs,
    asUtc + 14 * 60 * minuteMs,
  ];
  const hits: number[] = [];
  for (const guess of candidates) {
    const utc = guess - zoneOffsetMs(guess, timeZone);
    const local = wallClock(utc, timeZone);
    if (
      local.year === year &&
      local.month === month &&
      local.day === day &&
      local.hour === hour &&
      local.minute === minute
    ) {
      hits.push(utc);
    }
    const adjusted = guess - zoneOffsetMs(utc, timeZone);
    const second = wallClock(adjusted, timeZone);
    if (
      second.year === year &&
      second.month === month &&
      second.day === day &&
      second.hour === hour &&
      second.minute === minute
    ) {
      hits.push(adjusted);
    }
  }
  if (hits.length === 0) return null;
  return Math.min(...hits);
}

/**
 * The first real instant at or after a wall-clock minute.
 * A daylight-saving gap has no exact minute, so the search continues until
 * the clock shows that minute or a later one.
 */
function utcAtOrAfterWall(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
): number | null {
  const exact = utcFromWall(timeZone, year, month, day, minuteOfDay);
  if (exact !== null) return exact;
  const start = Date.UTC(year, month - 1, day) - 14 * 60 * minuteMs;
  const limit = start + 40 * 60 * minuteMs;
  const target = ((year * 100 + month) * 100 + day) * 10_000 + minuteOfDay;
  for (let cursor = start; cursor <= limit; cursor += minuteMs) {
    const local = wallClock(cursor, timeZone);
    const stamp =
      ((local.year * 100 + local.month) * 100 + local.day) * 10_000 +
      local.hour * 60 +
      local.minute;
    if (stamp >= target) return cursor;
  }
  return null;
}

function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  let hour = read("hour");
  if (hour === 24) hour = 0;
  return (
    Date.UTC(
      read("year"),
      read("month") - 1,
      read("day"),
      hour,
      read("minute"),
      read("second"),
    ) - epochMs
  );
}

function addDays(
  local: Wall,
  days: number,
): { year: number; month: number; day: number } {
  const date = new Date(
    Date.UTC(local.year, local.month - 1, local.day + days),
  );
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
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
