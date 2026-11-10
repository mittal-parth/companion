/**
 * Sends a schedule's prompt into the bot's conversation when its slot arrives.
 *
 * After downtime, or when slots pass while the bot is already in a turn, the
 * latest missed slot is sent once if it is still inside the catch-up window.
 * Older missed slots are recorded as skipped. A thrown prompt leaves no
 * receipt, so the next start can decide that slot. While this process stays
 * up, that throw is not tried again.
 */
import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import {
  nextRun,
  validateSchedule,
  type Schedule,
  type ScheduleReceipt,
} from "@companion/shared";
import type { ThreadStore } from "./thread-store.js";

/** Half a gap shorter than this is still worth this long. One-time slots use it. */
const minimumCatchUpMs = 2 * 60 * 1000;
/** Half a gap longer than this is not worth longer than this. */
const maximumCatchUpMs = 2 * 60 * 60 * 1000;

/** Stores schedules and fires the ones that are already saved. */
export type Scheduler = {
  /** Validates, stores, and arms a schedule. An omitted id is filled in. */
  create(input: unknown): Schedule;
  /** Schedules in the order they were stored. Omitting the bot lists them all. */
  list(botId?: string): Schedule[];
  /** Stops the wait and removes the schedule. */
  delete(id: string): void;
  /** Slots the daemon has decided, oldest first. */
  receipts(id: string): ScheduleReceipt[];
  /** Drops the waits. An in-flight turn is left to finish or fail on its own. */
  stop(): void;
};

/**
 * Arms every stored schedule, and accepts new ones.
 * `send` resolves when the bot's turn comes back and rejects when it throws.
 * A bot that is already talking makes `send` wait, then the prompt goes out.
 */
export function startScheduler(options: {
  store: ThreadStore;
  send(botId: string, text: string): Promise<unknown>;
}): Scheduler {
  const jobs = new Map<string, Cron>();
  const firing = new Set<string>();
  let closed = false;

  /**
   * How late this missed slot may be and still be sent.
   * Half the gap until the following slot, clamped to 2 minutes through 2 hours.
   * A slot with no following one, including a one-time schedule, gets 2 minutes.
   */
  function catchUpWindowMs(schedule: Schedule, occurrence: number): number {
    const following = nextRun(schedule, occurrence);
    if (following === null) return minimumCatchUpMs;
    const half = (following - occurrence) / 2;
    if (half < minimumCatchUpMs) return minimumCatchUpMs;
    if (half > maximumCatchUpMs) return maximumCatchUpMs;
    return half;
  }

  /** Slots strictly after `after` that are already due at `now`, in order. */
  function occurrencesThrough(
    schedule: Schedule,
    after: number,
    now: number,
  ): number[] {
    const due: number[] = [];
    let cursor = after;
    for (;;) {
      const at = nextRun(schedule, cursor);
      if (at === null || at > now || at <= cursor) return due;
      due.push(at);
      cursor = at;
    }
  }

  /**
   * Decides every slot after `after` that is already due.
   * The latest one is sent when it is still inside the window. The others are
   * recorded as skipped. A future slot is armed when nothing remains to send.
   */
  function reconcile(schedule: Schedule, after: number): void {
    if (closed || !options.store.hasSchedule(schedule.id)) return;
    const now = Date.now();
    const due = occurrencesThrough(schedule, after, now);
    if (due.length === 0) {
      armFuture(schedule, after);
      return;
    }
    const latest = due.at(-1);
    if (latest === undefined) {
      armFuture(schedule, after);
      return;
    }
    for (const at of due) {
      if (at === latest) break;
      options.store.recordReceipt(schedule.id, at, "skipped");
    }
    if (now - latest <= catchUpWindowMs(schedule, latest)) {
      void deliver(schedule, latest);
      return;
    }
    options.store.recordReceipt(schedule.id, latest, "skipped");
    armFuture(schedule, latest);
  }

  /** Waits for the next slot that is still in the future. */
  function armFuture(schedule: Schedule, after: number): void {
    if (closed || !options.store.hasSchedule(schedule.id)) return;
    jobs.get(schedule.id)?.stop();
    const now = Date.now();
    let cursor = after;
    let at = nextRun(schedule, cursor);
    while (at !== null && at <= now) {
      const next = nextRun(schedule, at);
      if (next === null || next <= at) {
        at = null;
        break;
      }
      cursor = at;
      at = next;
    }
    if (at === null) {
      jobs.delete(schedule.id);
      return;
    }
    const occurrence = at;
    const job = new Cron(new Date(occurrence), { unref: true }, () => {
      void deliver(schedule, occurrence);
    });
    jobs.set(schedule.id, job);
  }

  /**
   * Sends the prompt for a slot that already came due.
   * The person may be talking. The send waits for that turn, then runs.
   * This slot already fired while the daemon was up, so the window does not cancel it.
   */
  async function deliver(
    schedule: Schedule,
    occurrence: number,
  ): Promise<void> {
    const key = `${schedule.id}:${occurrence}`;
    if (closed || firing.has(key) || !options.store.hasSchedule(schedule.id)) {
      return;
    }
    if (hasReceipt(schedule.id, occurrence)) {
      reconcile(schedule, occurrence);
      return;
    }
    firing.add(key);
    let failed = false;
    try {
      await options.send(schedule.botId, schedule.prompt);
      if (options.store.hasSchedule(schedule.id)) {
        options.store.recordReceipt(schedule.id, occurrence, "ran");
      }
    } catch {
      // No receipt. The next start decides this slot if it is still in the window.
      failed = true;
    } finally {
      firing.delete(key);
    }
    if (closed || !options.store.hasSchedule(schedule.id)) return;
    if (failed) {
      armFuture(schedule, occurrence);
      return;
    }
    reconcile(schedule, occurrence);
  }

  function hasReceipt(scheduleId: string, occurrence: number): boolean {
    return options.store
      .receipts(scheduleId)
      .some((receipt) => receipt.occurrence === occurrence);
  }

  function floor(schedule: Schedule): number {
    return (
      options.store.latestReceipt(schedule.id) ??
      options.store.scheduleCreatedAt(schedule.id)
    );
  }

  for (const schedule of options.store.listSchedules()) {
    reconcile(schedule, floor(schedule));
  }

  return {
    create(input) {
      if (closed) throw new Error("The daemon is stopping.");
      const parsed = validateSchedule(withId(input));
      if (!parsed.ok) throw new Error(parsed.reason);
      options.store.saveSchedule(parsed.schedule);
      armFuture(
        parsed.schedule,
        options.store.scheduleCreatedAt(parsed.schedule.id),
      );
      return parsed.schedule;
    },

    list(botId) {
      return options.store.listSchedules(botId);
    },

    delete(id) {
      jobs.get(id)?.stop();
      jobs.delete(id);
      options.store.deleteSchedule(id);
    },

    receipts(id) {
      return options.store.receipts(id);
    },

    stop() {
      closed = true;
      for (const job of jobs.values()) job.stop();
      jobs.clear();
    },
  };
}

function withId(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return input;
  }
  const record = input as Record<string, unknown>;
  if (typeof record.id === "string" && record.id.trim() !== "") return input;
  return { ...record, id: randomUUID() };
}
