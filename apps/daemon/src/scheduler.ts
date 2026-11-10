/**
 * Sends a schedule's prompt into the bot's conversation when its slot arrives.
 *
 * The schedule maths names the next occurrence. Croner only waits for that
 * instant. The receipt is written when the turn comes back, so a crash or a
 * thrown prompt leaves the slot unfinished for catch-up.
 */
import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import { nextRun, validateSchedule, type Schedule } from "@companion/shared";
import type { ThreadStore } from "./thread-store.js";

/** Stores schedules and fires the ones that are already saved. */
export type Scheduler = {
  /** Validates, stores, and arms a schedule. An omitted id is filled in. */
  create(input: unknown): Schedule;
  /** Schedules in the order they were stored. Omitting the bot lists them all. */
  list(botId?: string): Schedule[];
  /** Stops the wait and removes the schedule. */
  delete(id: string): void;
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
}): Scheduler {
  const jobs = new Map<string, Cron>();
  const firing = new Set<string>();
  let closed = false;

  function armAfter(schedule: Schedule, after: number): void {
    if (closed || !options.store.hasSchedule(schedule.id)) return;
    jobs.get(schedule.id)?.stop();
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

  async function deliver(
    schedule: Schedule,
    occurrence: number,
  ): Promise<void> {
    const key = `${schedule.id}:${occurrence}`;
    if (closed || firing.has(key) || !options.store.hasSchedule(schedule.id)) {
      return;
    }
    if (options.store.receipts(schedule.id).includes(occurrence)) {
      armAfter(schedule, occurrence);
      return;
    }
    firing.add(key);
    try {
      await options.send(schedule.botId, schedule.prompt);
      // The turn came back, including a denial or a limit. This slot is done.
      if (options.store.hasSchedule(schedule.id)) {
        options.store.recordReceipt(schedule.id, occurrence);
      }
    } catch {
      // A throw leaves no receipt. Catch-up retries the slot after a restart.
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
      armAfter(parsed.schedule, Date.now());
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
