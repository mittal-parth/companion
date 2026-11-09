import { expect, test } from "vitest";
import {
  nextRun,
  nextRuns,
  validateSchedule,
  type Schedule,
} from "./schedule.js";

const text = { id: "sched-1", botId: "bot-1", prompt: "Check the inbox." };

function accepted(input: unknown): Schedule {
  const result = validateSchedule(input);
  if (!result.ok) throw new Error(result.reason);
  return result.schedule;
}

function at(iso: string): number {
  return Date.parse(iso);
}

test("a cron schedule names the next UTC instant in its timezone", () => {
  const schedule = accepted({
    ...text,
    kind: "cron",
    expression: "0 9 * * *",
    timezone: "Asia/Kolkata",
  });
  const nine = at("2026-11-09T03:30:00.000Z");
  expect(nextRun(schedule, nine - 1)).toBe(nine);
  expect(nextRun(schedule, nine)).toBe(at("2026-11-10T03:30:00.000Z"));
});

test("the instant nextRun returns is the occurrence", () => {
  const schedule = accepted({
    ...text,
    kind: "cron",
    expression: "0 9 * * *",
    timezone: "UTC",
  });
  const first = nextRun(schedule, at("2026-11-09T00:00:00.000Z"));
  expect(first).toBe(at("2026-11-09T09:00:00.000Z"));
  if (first === null) return;
  expect(nextRun(schedule, first)).toBe(at("2026-11-10T09:00:00.000Z"));
  expect(
    nextRuns(schedule, at("2026-11-09T00:00:00.000Z"), 3).map((time) =>
      new Date(time).toISOString(),
    ),
  ).toEqual([
    "2026-11-09T09:00:00.000Z",
    "2026-11-10T09:00:00.000Z",
    "2026-11-11T09:00:00.000Z",
  ]);
});

test("a fixed time moves through a spring-forward gap and runs once in a repeated hour", () => {
  const spring = accepted({
    ...text,
    kind: "cron",
    expression: "30 2 * * *",
    timezone: "America/New_York",
  });
  expect(nextRun(spring, at("2026-03-08T05:00:00.000Z"))).toBe(
    at("2026-03-08T07:00:00.000Z"),
  );
  expect(nextRun(spring, at("2026-03-08T07:00:00.000Z"))).toBe(
    at("2026-03-09T06:30:00.000Z"),
  );

  const fall = accepted({
    ...text,
    kind: "cron",
    expression: "30 1 * * *",
    timezone: "America/New_York",
  });
  expect(
    nextRuns(fall, at("2026-11-01T04:00:00.000Z"), 2).map((time) =>
      new Date(time).toISOString(),
    ),
  ).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"]);
});

test("a list of hours runs both passes of a repeated hour and skips a missing hour", () => {
  const fall = accepted({
    ...text,
    kind: "cron",
    expression: "30 1,2 * * *",
    timezone: "America/New_York",
  });
  expect(
    nextRuns(fall, at("2026-11-01T04:00:00.000Z"), 3).map((time) =>
      new Date(time).toISOString(),
    ),
  ).toEqual([
    "2026-11-01T05:30:00.000Z",
    "2026-11-01T06:30:00.000Z",
    "2026-11-01T07:30:00.000Z",
  ]);

  const spring = accepted({
    ...text,
    kind: "cron",
    expression: "0,30 2 * * *",
    timezone: "America/New_York",
  });
  expect(nextRun(spring, at("2026-03-08T05:00:00.000Z"))).toBe(
    at("2026-03-09T06:00:00.000Z"),
  );
});

test("calendar names, the last day, and the second Monday follow croner", () => {
  const secondMonday = accepted({
    ...text,
    kind: "cron",
    expression: "0 9 * * MON#2",
    timezone: "Asia/Kolkata",
  });
  expect(nextRun(secondMonday, at("2026-11-01T00:00:00.000Z"))).toBe(
    at("2026-11-09T03:30:00.000Z"),
  );

  const lastDay = accepted({
    ...text,
    kind: "cron",
    expression: "0 9 L * *",
    timezone: "UTC",
  });
  expect(nextRun(lastDay, at("2024-02-01T00:00:00.000Z"))).toBe(
    at("2024-02-29T09:00:00.000Z"),
  );
  expect(nextRun(lastDay, at("2026-02-01T00:00:00.000Z"))).toBe(
    at("2026-02-28T09:00:00.000Z"),
  );

  const either = accepted({
    ...text,
    kind: "cron",
    expression: "0 0 1 * MON",
    timezone: "UTC",
  });
  expect(
    nextRuns(either, at("2026-10-31T00:00:00.000Z"), 2).map((time) =>
      new Date(time).toISOString(),
    ),
  ).toEqual(["2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z"]);
});

test("the 31st skips a short month, and 31 February never runs", () => {
  const thirtyFirst = accepted({
    ...text,
    kind: "cron",
    expression: "0 9 31 * *",
    timezone: "UTC",
  });
  expect(nextRun(thirtyFirst, at("2026-02-01T00:00:00.000Z"))).toBe(
    at("2026-03-31T09:00:00.000Z"),
  );

  const never = accepted({
    ...text,
    kind: "cron",
    expression: "0 9 31 2 *",
    timezone: "UTC",
  });
  expect(nextRun(never, at("2026-01-01T00:00:00.000Z"))).toBeNull();
});

test("an interval counts real minutes from its anchor", () => {
  const schedule = accepted({
    ...text,
    kind: "interval",
    everyMinutes: 120,
    anchorAt: at("2026-03-08T05:30:00.000Z"),
    timezone: "America/New_York",
  });
  expect(nextRuns(schedule, at("2026-03-08T05:00:00.000Z"), 3)).toEqual([
    at("2026-03-08T05:30:00.000Z"),
    at("2026-03-08T07:30:00.000Z"),
    at("2026-03-08T09:30:00.000Z"),
  ]);
  expect(nextRun(schedule, at("2026-03-08T05:30:00.000Z"))).toBe(
    at("2026-03-08T07:30:00.000Z"),
  );
});

test("an interval keeps weekdays and a window in its timezone", () => {
  const saturdayMorning = at("2026-11-06T21:00:00.000Z");
  const kolkataSaturday = accepted({
    ...text,
    kind: "interval",
    everyMinutes: 1440,
    anchorAt: saturdayMorning,
    timezone: "Asia/Kolkata",
    weekdays: [6],
  });
  expect(nextRun(kolkataSaturday, saturdayMorning - 1)).toBe(saturdayMorning);

  const mondays = accepted({
    ...text,
    kind: "interval",
    everyMinutes: 1440,
    anchorAt: at("2026-11-09T03:30:00.000Z"),
    timezone: "Asia/Kolkata",
    weekdays: [6, 1, 1],
  });
  expect(nextRun(mondays, at("2026-11-08T03:30:00.000Z"))).toBe(
    at("2026-11-09T03:30:00.000Z"),
  );
  if (mondays.kind === "interval") expect(mondays.weekdays).toEqual([1, 6]);

  const office = accepted({
    ...text,
    kind: "interval",
    everyMinutes: 120,
    anchorAt: at("2026-01-01T00:00:00.000Z"),
    timezone: "UTC",
    window: { start: "09:00", end: "17:00" },
  });
  expect(nextRuns(office, at("2026-01-01T00:00:00.000Z") - 1, 2)).toEqual([
    at("2026-01-01T10:00:00.000Z"),
    at("2026-01-01T12:00:00.000Z"),
  ]);
});

test("an interval window follows the local clock through a spring-forward morning", () => {
  const schedule = accepted({
    ...text,
    kind: "interval",
    everyMinutes: 60,
    anchorAt: at("2026-03-08T05:00:00.000Z"),
    timezone: "America/New_York",
    window: { start: "01:00", end: "04:00" },
  });
  expect(
    nextRuns(schedule, at("2026-03-08T04:00:00.000Z"), 3).map((time) =>
      new Date(time).toISOString(),
    ),
  ).toEqual([
    "2026-03-08T06:00:00.000Z",
    "2026-03-08T07:00:00.000Z",
    "2026-03-09T05:00:00.000Z",
  ]);
});

test("an interval end is the last instant that still runs", () => {
  const ends = at("2026-01-01T02:00:00.000Z");
  const schedule = accepted({
    ...text,
    kind: "interval",
    everyMinutes: 60,
    anchorAt: at("2026-01-01T00:00:00.000Z"),
    timezone: "UTC",
    endsAt: ends,
  });
  expect(nextRun(schedule, ends - 1)).toBe(ends);
  expect(nextRun(schedule, ends)).toBeNull();
});

test("a one-time schedule runs at its instant and then never again", () => {
  const when = at("2026-11-09T09:00:00.000Z");
  const schedule = accepted({ ...text, kind: "once", at: when });
  expect(nextRun(schedule, when - 1)).toBe(when);
  expect(nextRun(schedule, when)).toBeNull();
  expect(nextRuns(schedule, when - 1, 3)).toEqual([when]);
});

test("validation rejects a schedule that cannot be run", () => {
  const cases: Array<[unknown, string]> = [
    [null, "A schedule must be an object."],
    [{ ...text, id: "  ", kind: "once", at: 0 }, "A schedule needs an id."],
    [{ ...text, botId: "", kind: "once", at: 0 }, "A schedule needs a bot."],
    [
      { ...text, prompt: " ", kind: "once", at: 0 },
      "A schedule needs a prompt.",
    ],
    [
      { ...text, kind: "hourly" },
      "A schedule kind must be cron, interval, or once.",
    ],
    [
      { ...text, kind: "cron", expression: "@daily", timezone: "UTC" },
      "A cron expression cannot use a macro such as @daily.",
    ],
    [
      { ...text, kind: "cron", expression: "0 0 9 * * *", timezone: "UTC" },
      "A cron expression needs five fields: minute, hour, day of month, month, and day of week.",
    ],
    [
      { ...text, kind: "cron", expression: "0 9 * * *", timezone: "IST" },
      "A cron timezone must be an IANA name such as Asia/Kolkata.",
    ],
    [
      { ...text, kind: "cron", expression: "0 9 * * *", timezone: "+05:30" },
      "A cron timezone must be an IANA name such as Asia/Kolkata.",
    ],
    [
      {
        ...text,
        kind: "cron",
        expression: "0 9 * * *",
        timezone: "Mars/Olympus",
      },
      "A cron timezone must be an IANA name such as Asia/Kolkata.",
    ],
    [
      { ...text, kind: "cron", expression: "99 9 * * *", timezone: "UTC" },
      "A cron expression is invalid.",
    ],
    [
      {
        ...text,
        kind: "interval",
        everyMinutes: 0,
        anchorAt: 0,
        timezone: "UTC",
      },
      "Interval minutes must be a whole number from 1 to 1440.",
    ],
    [
      {
        ...text,
        kind: "interval",
        everyMinutes: 1441,
        anchorAt: 0,
        timezone: "UTC",
      },
      "Interval minutes must be a whole number from 1 to 1440.",
    ],
    [
      {
        ...text,
        kind: "interval",
        everyMinutes: 5.5,
        anchorAt: 0,
        timezone: "UTC",
      },
      "Interval minutes must be a whole number from 1 to 1440.",
    ],
    [
      {
        ...text,
        kind: "interval",
        everyMinutes: 60,
        anchorAt: 1.5,
        timezone: "UTC",
      },
      "An interval needs a start time.",
    ],
    [
      {
        ...text,
        kind: "interval",
        everyMinutes: 60,
        anchorAt: 0,
        timezone: "UTC",
        weekdays: [],
      },
      "Interval weekdays must be between 0 (Sunday) and 6 (Saturday).",
    ],
    [
      {
        ...text,
        kind: "interval",
        everyMinutes: 60,
        anchorAt: 0,
        timezone: "UTC",
        weekdays: [7],
      },
      "Interval weekdays must be between 0 (Sunday) and 6 (Saturday).",
    ],
    [
      {
        ...text,
        kind: "interval",
        everyMinutes: 60,
        anchorAt: 0,
        timezone: "UTC",
        window: { start: "17:00", end: "09:00" },
      },
      "An interval window must end later on the same day.",
    ],
    [
      {
        ...text,
        kind: "interval",
        everyMinutes: 120,
        anchorAt: 0,
        timezone: "UTC",
        window: { start: "09:00", end: "10:00" },
      },
      "An interval window must be at least as long as the interval.",
    ],
    [
      {
        ...text,
        kind: "interval",
        everyMinutes: 60,
        anchorAt: 0,
        timezone: "UTC",
        window: { start: "9:00", end: "10:00" },
      },
      "An interval window must use 24-hour HH:MM.",
    ],
    [
      {
        ...text,
        kind: "interval",
        everyMinutes: 60,
        anchorAt: 100,
        timezone: "UTC",
        endsAt: 50,
      },
      "An interval end must not be before its start.",
    ],
    [
      { ...text, kind: "once", at: Number.NaN },
      "A one-time schedule needs a time.",
    ],
  ];

  for (const [input, reason] of cases) {
    const result = validateSchedule(input);
    expect(result, reason).toEqual({ ok: false, reason });
  }
});

test("a cron runs as often as croner allows, down to one minute", () => {
  const everyMinute = accepted({
    ...text,
    kind: "cron",
    expression: "* * * * *",
    timezone: "UTC",
  });
  expect(nextRun(everyMinute, at("2026-11-09T09:00:00.000Z"))).toBe(
    at("2026-11-09T09:01:00.000Z"),
  );
  const everyFour = accepted({
    ...text,
    kind: "cron",
    expression: "  */4 * * * *  ",
    timezone: "UTC",
  });
  if (everyFour.kind === "cron") {
    expect(everyFour.expression).toBe("*/4 * * * *");
  }
  expect(nextRun(everyFour, at("2026-11-09T09:00:00.000Z"))).toBe(
    at("2026-11-09T09:04:00.000Z"),
  );

  const everyOne = accepted({
    ...text,
    kind: "interval",
    everyMinutes: 1,
    anchorAt: at("2026-11-09T09:00:00.000Z"),
    timezone: "UTC",
  });
  expect(nextRun(everyOne, at("2026-11-09T09:00:00.000Z"))).toBe(
    at("2026-11-09T09:01:00.000Z"),
  );
});

test("nextRuns returns nothing when asked for no occurrences", () => {
  const schedule = accepted({ ...text, kind: "once", at: 10 });
  expect(nextRuns(schedule, 0, 0)).toEqual([]);
});
