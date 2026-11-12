/**
 * The schedule list the page shows.
 * The cadence is words. The expression stays on the daemon, so the page
 * has no cron field and no way to write a schedule.
 */
import { daemonError, daemonFetch } from "@/lib/daemon";
import { describeSchedule, type Schedule } from "@companion/shared/schedule";

/** One schedule as the panel reads it. */
export type ScheduleView = {
  id: string;
  prompt: string;
  paused: boolean;
  cadence: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  /** The zone the next and last times are shown in. A one-time schedule has none. */
  timeZone: string | null;
};

/** The bot's schedules, oldest first. */
export async function listScheduleViews(
  botId: string,
): Promise<ScheduleView[]> {
  const daemon = await daemonFetch(
    `/bots/${encodeURIComponent(botId)}/schedules`,
  );
  if (!daemon.ok) {
    throw new ScheduleRequestError(
      daemon.status || 502,
      await daemonError(daemon),
    );
  }
  const body: unknown = await daemon.json();
  if (!Array.isArray(body)) {
    throw new ScheduleRequestError(502, "The schedules could not be read.");
  }
  return body.map((item) => scheduleView(item as ScheduleListing));
}

/** A schedule plus the pause state and run times the daemon lists. */
type ScheduleListing = Schedule & {
  paused: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
};

/**
 * Turns one schedule on or off.
 * Off skips future slots. On waits for the next slot and does not catch up.
 */
export async function setScheduleEnabled(
  botId: string,
  scheduleId: string,
  enabled: boolean,
): Promise<ScheduleView> {
  const action = enabled ? "resume" : "pause";
  const daemon = await daemonFetch(
    `/bots/${encodeURIComponent(botId)}/schedules/${encodeURIComponent(scheduleId)}/${action}`,
    { method: "POST" },
  );
  if (!daemon.ok) {
    throw new ScheduleRequestError(
      daemon.status || 502,
      await daemonError(daemon),
    );
  }
  return scheduleView((await daemon.json()) as ScheduleListing);
}

/** A daemon answer the route can send on with the same status. */
export class ScheduleRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function scheduleView(schedule: ScheduleListing): ScheduleView {
  return {
    id: schedule.id,
    prompt: schedule.prompt,
    paused: schedule.paused,
    cadence: describeSchedule(schedule),
    nextRunAt: schedule.nextRunAt,
    lastRunAt: schedule.lastRunAt,
    timeZone: scheduleTimeZone(schedule),
  };
}

function scheduleTimeZone(schedule: ScheduleListing): string | null {
  switch (schedule.kind) {
    case "cron":
    case "interval":
      return schedule.timezone;
    case "once":
      return null;
    default: {
      const unexpected: never = schedule;
      return unexpected;
    }
  }
}
