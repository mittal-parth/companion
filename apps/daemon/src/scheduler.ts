/**
 * Sends a schedule's prompt into the bot's conversation when its slot arrives.
 *
 * The schedule maths names the next occurrence. Croner only waits for that
 * instant. The receipt is written when the turn comes back, so a crash or a
 * thrown prompt leaves the slot unfinished for catch-up.
 *
 * A paused schedule is never armed and never fires. Pausing writes no receipt
 * and nothing catches up what was missed: resuming waits for the next slot.
 * Every step is logged so a firing can be traced afterwards.
 */
import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import {
  nextRun,
  validateSchedule,
  type Schedule,
  type ScheduleLogEntry,
} from "@companion/shared";
import type { ThreadStore } from "./thread-store.js";

/** Stores schedules and fires the ones that are already saved. */
export type Scheduler = {
  /** Validates, stores, and arms a schedule. An omitted id is filled in. */
  create(input: unknown): Schedule;
  /** Schedules in the order they were stored. Omitting the bot lists them all. */
  list(botId?: string): Schedule[];
  /** Stops the wait and removes the schedule. */
  delete(id: string): void;
  /** Stops the wait. The schedule stays stored and does not fire until resumed. */
  pause(id: string): void;
  /** Waits for the next slot after now. Slots missed while paused are skipped. */
  resume(id: string): void;
  /** Whether the schedule is paused. */
  isPaused(id: string): boolean;
  /** Occurrences whose turns came back, oldest first. */
  receipts(id: string): number[];
  /** Drops the waits. An in-flight turn is left to finish or fail on its own. */
  stop(): void;
};

/**
 * Arms every stored schedule, and accepts new ones.
 * `send` resolves when the bot's turn comes back and rejects when it throws.
 */
export function startScheduler(options: {
  store: ThreadStore;
  send(botId: string, text: string): Promise<unknown>;
  /** Receives each schedule event. Omitted, events are dropped. */
  log?: (entry: ScheduleLogEntry) => void;
}): Scheduler {
  const jobs = new Map<string, Cron>();
  const firing = new Set<string>();
  let closed = false;

  function log(
    event: ScheduleLogEntry["event"],
    schedule: Schedule,
    extra: { occurrence?: number; detail?: string } = {},
  ): void {
    options.log?.({
      event,
      scheduleId: schedule.id,
      botId: schedule.botId,
      at: Date.now(),
      ...extra,
    });
  }

  function disarm(id: string): void {
    jobs.get(id)?.stop();
    jobs.delete(id);
  }

  function armAfter(schedule: Schedule, after: number): void {
    if (closed || !options.store.hasSchedule(schedule.id)) return;
    disarm(schedule.id);
    if (options.store.isSchedulePaused(schedule.id)) return;
    const now = Date.now();
    let at = nextRun(schedule, after);
    // A slot that already passed stays unfinished so catch-up can decide it.
    while (at !== null && at <= now) {
      const next = nextRun(schedule, at);
      if (next === null || next <= at) {
        at = null;
        break;
      }
      at = next;
    }
    if (at === null) return;
    const occurrence = at;
    const job = new Cron(new Date(occurrence), { unref: true }, () => {
      void deliver(schedule, occurrence);
    });
    jobs.set(schedule.id, job);
    log("armed", schedule, { occurrence });
  }

  async function deliver(
    schedule: Schedule,
    occurrence: number,
  ): Promise<void> {
    const key = `${schedule.id}:${occurrence}`;
    if (closed || firing.has(key) || !options.store.hasSchedule(schedule.id)) {
      return;
    }
    if (options.store.isSchedulePaused(schedule.id)) {
      log("skipped_paused", schedule, { occurrence });
      return;
    }
    if (options.store.receipts(schedule.id).includes(occurrence)) {
      log("skipped_duplicate", schedule, { occurrence });
      armAfter(schedule, occurrence);
      return;
    }
    firing.add(key);
    log("fired", schedule, { occurrence });
    try {
      const result = await options.send(schedule.botId, schedule.prompt);
      // The turn came back, including a denial or a limit. This slot is done.
      if (options.store.hasSchedule(schedule.id)) {
        options.store.recordReceipt(schedule.id, occurrence);
      }
      log("completed", schedule, {
        occurrence,
        ...(typeof result === "string" ? { detail: result } : {}),
      });
    } catch (error) {
      // A throw leaves no receipt. Catch-up retries the slot after a restart.
      log("failed", schedule, {
        occurrence,
        detail: error instanceof Error ? error.message : "The prompt failed.",
      });
    } finally {
      firing.delete(key);
      if (!closed && options.store.hasSchedule(schedule.id)) {
        armAfter(schedule, occurrence);
      }
    }
  }

  for (const schedule of options.store.listSchedules()) {
    const last = options.store.latestReceipt(schedule.id);
    armAfter(schedule, last ?? Date.now());
  }

  return {
    create(input) {
      if (closed) throw new Error("The daemon is stopping.");
      const parsed = validateSchedule(withId(input));
      if (!parsed.ok) throw new Error(parsed.reason);
      options.store.saveSchedule(parsed.schedule);
      log("created", parsed.schedule);
      armAfter(parsed.schedule, Date.now());
      return parsed.schedule;
    },

    list(botId) {
      return options.store.listSchedules(botId);
    },

    delete(id) {
      const schedule = options.store.getSchedule(id);
      disarm(id);
      options.store.deleteSchedule(id);
      log("deleted", schedule);
    },

    pause(id) {
      const schedule = options.store.getSchedule(id);
      options.store.setSchedulePaused(id, true);
      disarm(id);
      log("paused", schedule);
    },

    resume(id) {
      const schedule = options.store.getSchedule(id);
      options.store.setSchedulePaused(id, false);
      log("resumed", schedule);
      armAfter(schedule, Date.now());
    },

    isPaused(id) {
      return options.store.isSchedulePaused(id);
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
