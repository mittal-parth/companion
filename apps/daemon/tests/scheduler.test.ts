/**
 * Proves a schedule fires once into the bot's conversation on a real clock.
 * The engine is scripted. A cron and an interval wait for the next minute.
 * Catch-up uses that same clock: a missed slot is one that is already in the past.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type * as acp from "@agentclientprotocol/sdk";
import {
  nextRun,
  type BotView,
  type ScheduleLogEntry,
} from "@companion/shared";
import { expect, test } from "vitest";
import { startDaemon, type Daemon } from "../src/api.js";
import type { Engine } from "../src/engine.js";
import { openThreadStore } from "../src/thread-store.js";

const weather = "Check the weather and tell me if I need an umbrella.";
const umbrella: acp.SessionUpdate = {
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text: "Bring an umbrella." },
};

test("a one-time schedule fires once and a restart does not repeat it", async () => {
  const prompts: string[] = [];
  const directory = mkdtempSync(join(tmpdir(), "companion-schedule-"));
  const storePath = join(directory, "threads.db");
  let daemon: Daemon | undefined;
  try {
    daemon = await startDaemon({ storePath, engine: recording(prompts) });
    const bot = await createBot(daemon, "Ada");
    const at = Date.now() + 400;
    const schedule = daemon.createSchedule({
      botId: bot.id,
      prompt: weather,
      kind: "once",
      at,
    });
    expect(schedule.id).not.toBe("");
    await waitFor(
      () => prompts.filter((prompt) => prompt === weather).length === 1,
    );
    expect(daemon.receipts(schedule.id)).toEqual([
      { occurrence: at, outcome: "ran" },
    ]);
    const stored = await fetch(`${daemon.url}/bots/${bot.id}`);
    expect(await stored.json()).toMatchObject({ updates: [umbrella] });

    await daemon.close();
    daemon = await startDaemon({ storePath, engine: recording(prompts) });
    await delay(500);
    expect(prompts.filter((prompt) => prompt === weather)).toEqual([weather]);
    expect(daemon.receipts(schedule.id)).toEqual([
      { occurrence: at, outcome: "ran" },
    ]);
    expect(daemon.listSchedules(bot.id)).toEqual([schedule]);
  } finally {
    await daemon?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a thrown prompt is not retried until the next start, and then only inside the window", async () => {
  const prompts: string[] = [];
  let attempts = 0;
  const engine: Engine = {
    async prompt(_botId, text) {
      if (text.startsWith("Your name is")) return "end_turn";
      prompts.push(text);
      attempts += 1;
      if (attempts === 1) throw new Error("OpenCode exploded.");
      return "end_turn";
    },
    async close() {},
  };
  const directory = mkdtempSync(join(tmpdir(), "companion-schedule-"));
  const storePath = join(directory, "threads.db");
  let daemon: Daemon | undefined;
  try {
    daemon = await startDaemon({ storePath, engine });
    const bot = await createBot(daemon, "Ada");
    const at = Date.now() + 400;
    const schedule = daemon.createSchedule({
      botId: bot.id,
      prompt: weather,
      kind: "once",
      at,
    });
    await waitFor(() => prompts.includes(weather));
    await delay(Math.max(0, at + 400 - Date.now()));
    expect(prompts.filter((prompt) => prompt === weather)).toEqual([weather]);
    expect(daemon.receipts(schedule.id)).toEqual([]);

    await daemon.close();
    const restarted = await startDaemon({ storePath, engine });
    daemon = restarted;
    await waitFor(
      () =>
        prompts.filter((prompt) => prompt === weather).length === 2 &&
        restarted.receipts(schedule.id).length === 1,
    );
    expect(prompts.filter((prompt) => prompt === weather)).toEqual([
      weather,
      weather,
    ]);
    expect(daemon.receipts(schedule.id)).toEqual([
      { occurrence: at, outcome: "ran" },
    ]);
  } finally {
    await daemon?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a schedule waits until the bot's turn finishes", async () => {
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => {};
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  let sentAt = 0;
  const engine: Engine = {
    async prompt(_botId, text, onUpdate) {
      if (text.startsWith("Your name is")) return "end_turn";
      if (text === "hold") {
        started();
        await hold;
        onUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "done holding" },
        });
        return "end_turn";
      }
      sentAt = Date.now();
      onUpdate(umbrella);
      return "end_turn";
    },
    async close() {},
  };
  const directory = mkdtempSync(join(tmpdir(), "companion-schedule-"));
  let daemon: Daemon | undefined;
  let pending: Promise<Response> | undefined;
  try {
    daemon = await startDaemon({
      storePath: join(directory, "threads.db"),
      engine,
    });
    const bot = await createBot(daemon, "Ada");
    pending = postJson(daemon, `/bots/${bot.id}/messages`, { text: "hold" });
    await running;
    const at = Date.now() + 300;
    const schedule = daemon.createSchedule({
      botId: bot.id,
      prompt: weather,
      kind: "once",
      at,
    });
    await delay(Math.max(0, at + 400 - Date.now()));
    expect(sentAt).toBe(0);
    const releasedAt = Date.now();
    release();
    expect((await pending).status).toBe(200);
    await waitFor(() => sentAt !== 0);
    expect(sentAt).toBeGreaterThanOrEqual(releasedAt);
    expect(daemon.receipts(schedule.id)).toEqual([
      { occurrence: at, outcome: "ran" },
    ]);
    const stored = await fetch(`${daemon.url}/bots/${bot.id}`);
    const body = JSON.stringify(await stored.json());
    expect(body).toContain("Bring an umbrella.");
    expect(body).not.toContain(weather);
  } finally {
    release();
    await pending?.catch(() => undefined);
    await daemon?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a removed schedule does not fire", async () => {
  const prompts: string[] = [];
  const directory = mkdtempSync(join(tmpdir(), "companion-schedule-"));
  let daemon: Daemon | undefined;
  try {
    daemon = await startDaemon({
      storePath: join(directory, "threads.db"),
      engine: recording(prompts),
    });
    const bot = await createBot(daemon, "Ada");
    const at = Date.now() + 400;
    const schedule = daemon.createSchedule({
      botId: bot.id,
      prompt: weather,
      kind: "once",
      at,
    });
    daemon.deleteSchedule(schedule.id);
    await delay(700);
    expect(prompts.filter((prompt) => prompt === weather)).toEqual([]);
    expect(() => daemon?.receipts(schedule.id)).toThrow(
      `Unknown schedule ${schedule.id}.`,
    );
  } finally {
    await daemon?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a paused schedule does not fire and a missed slot is not caught up", async () => {
  const prompts: string[] = [];
  const entries: ScheduleLogEntry[] = [];
  const directory = mkdtempSync(join(tmpdir(), "companion-schedule-"));
  let daemon: Daemon | undefined;
  try {
    daemon = await startDaemon({
      storePath: join(directory, "threads.db"),
      engine: recording(prompts),
      log: (entry) => entries.push(entry),
    });
    const bot = await createBot(daemon, "Ada");
    const schedule = daemon.createSchedule({
      botId: bot.id,
      prompt: weather,
      kind: "once",
      at: Date.now() + 400,
    });
    daemon.pauseSchedule(schedule.id);
    await delay(700);
    daemon.resumeSchedule(schedule.id);
    await delay(300);
    expect(prompts.filter((prompt) => prompt === weather)).toEqual([]);
    expect(daemon.receipts(schedule.id)).toEqual([]);
    expect(entries.map((entry) => entry.event)).toEqual([
      "created",
      "armed",
      "paused",
      "resumed",
    ]);
  } finally {
    await daemon?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a resumed schedule fires once at its next slot and logs the trace", async () => {
  const prompts: string[] = [];
  const entries: ScheduleLogEntry[] = [];
  const directory = mkdtempSync(join(tmpdir(), "companion-schedule-"));
  let daemon: Daemon | undefined;
  try {
    daemon = await startDaemon({
      storePath: join(directory, "threads.db"),
      engine: recording(prompts),
      log: (entry) => entries.push(entry),
    });
    const bot = await createBot(daemon, "Ada");
    const at = Date.now() + 1_000;
    const schedule = daemon.createSchedule({
      botId: bot.id,
      prompt: weather,
      kind: "once",
      at,
    });
    daemon.pauseSchedule(schedule.id);
    daemon.resumeSchedule(schedule.id);
    await waitFor(() => daemon?.receipts(schedule.id).length === 1);
    expect(prompts.filter((prompt) => prompt === weather)).toEqual([weather]);
    expect(daemon.receipts(schedule.id)).toEqual([
      { occurrence: at, outcome: "ran" },
    ]);
    expect(entries.map((entry) => entry.event)).toEqual([
      "created",
      "armed",
      "paused",
      "resumed",
      "armed",
      "fired",
      "completed",
    ]);
    expect(entries.every((entry) => entry.scheduleId === schedule.id)).toBe(
      true,
    );
    expect(entries.every((entry) => entry.botId === bot.id)).toBe(true);
    expect(entries.at(-1)).toMatchObject({
      event: "completed",
      occurrence: at,
      detail: "end_turn",
    });
  } finally {
    await daemon?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a schedule stays paused after a restart", async () => {
  const prompts: string[] = [];
  const directory = mkdtempSync(join(tmpdir(), "companion-schedule-"));
  const storePath = join(directory, "threads.db");
  let daemon: Daemon | undefined;
  try {
    daemon = await startDaemon({ storePath, engine: recording(prompts) });
    const bot = await createBot(daemon, "Ada");
    const schedule = daemon.createSchedule({
      botId: bot.id,
      prompt: weather,
      kind: "once",
      at: Date.now() + 1_500,
    });
    daemon.pauseSchedule(schedule.id);
    await daemon.close();

    daemon = await startDaemon({ storePath, engine: recording(prompts) });
    await delay(2_000);
    expect(prompts.filter((prompt) => prompt === weather)).toEqual([]);
    expect(daemon.receipts(schedule.id)).toEqual([]);
  } finally {
    await daemon?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed prompt is logged with its message", async () => {
  const entries: ScheduleLogEntry[] = [];
  const engine: Engine = {
    async prompt(_botId, text) {
      if (text === weather) throw new Error("OpenCode exploded.");
      return "end_turn";
    },
    async close() {},
  };
  const directory = mkdtempSync(join(tmpdir(), "companion-schedule-"));
  let daemon: Daemon | undefined;
  try {
    daemon = await startDaemon({
      storePath: join(directory, "threads.db"),
      engine,
      log: (entry) => entries.push(entry),
    });
    const bot = await createBot(daemon, "Ada");
    daemon.createSchedule({
      botId: bot.id,
      prompt: weather,
      kind: "once",
      at: Date.now() + 400,
    });
    await waitFor(() => entries.some((entry) => entry.event === "failed"));
    expect(entries.find((entry) => entry.event === "failed")).toMatchObject({
      detail: "OpenCode exploded.",
    });
  } finally {
    await daemon?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a schedule names a bad expression or a missing bot", async () => {
  const directory = mkdtempSync(join(tmpdir(), "companion-schedule-"));
  const daemon = await startDaemon({
    storePath: join(directory, "threads.db"),
    engine: recording([]),
  });
  try {
    const bot = await createBot(daemon, "Ada");
    expect(() =>
      daemon.createSchedule({
        botId: bot.id,
        prompt: weather,
        kind: "cron",
        expression: "nope",
        timezone: "UTC",
      }),
    ).toThrow(
      "A cron expression needs five fields: minute, hour, day of month, month, and day of week.",
    );
    expect(() =>
      daemon.createSchedule({
        botId: "missing",
        prompt: weather,
        kind: "once",
        at: Date.now() + 60_000,
      }),
    ).toThrow("Unknown bot missing.");
  } finally {
    await daemon.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a cron and an interval fire once on the next real minute", async () => {
  const prompts: string[] = [];
  const directory = mkdtempSync(join(tmpdir(), "companion-schedule-"));
  const storePath = join(directory, "threads.db");
  let daemon: Daemon | undefined;
  try {
    daemon = await startDaemon({ storePath, engine: recording(prompts) });
    const daily = await createBot(daemon, "Daily");
    const paced = await createBot(daemon, "Paced");
    const slot = await upcomingMinute();
    const cron = daemon.createSchedule({
      botId: daily.id,
      prompt: "Daily weather",
      kind: "cron",
      expression: "* * * * *",
      timezone: "UTC",
    });
    const interval = daemon.createSchedule({
      botId: paced.id,
      prompt: "Interval weather",
      kind: "interval",
      everyMinutes: 1,
      anchorAt: slot,
      timezone: "UTC",
    });
    expect(nextRun(cron, Date.now())).toBe(slot);
    expect(nextRun(interval, Date.now())).toBe(slot);
    await waitFor(
      () =>
        prompts.includes("Daily weather") &&
        prompts.includes("Interval weather"),
      75_000,
    );
    const fired = daemon.receipts(cron.id);
    expect(fired).toHaveLength(1);
    const occurrence = fired[0]?.occurrence;
    expect(occurrence).toBeTypeOf("number");
    expect(fired[0]?.outcome).toBe("ran");
    expect(daemon.receipts(interval.id)).toEqual(fired);
    expect(prompts.filter((prompt) => prompt === "Daily weather")).toEqual([
      "Daily weather",
    ]);
    expect(prompts.filter((prompt) => prompt === "Interval weather")).toEqual([
      "Interval weather",
    ]);

    await daemon.close();
    daemon = await startDaemon({ storePath, engine: recording(prompts) });
    await delay(2_000);
    expect(prompts.filter((prompt) => prompt === "Daily weather")).toEqual([
      "Daily weather",
    ]);
    expect(prompts.filter((prompt) => prompt === "Interval weather")).toEqual([
      "Interval weather",
    ]);
    expect(daemon.receipts(cron.id)).toEqual(fired);
  } finally {
    await daemon?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 90_000);

test("downtime runs the latest slot still inside the window and skips the older ones", async () => {
  const prompts: string[] = [];
  const directory = mkdtempSync(join(tmpdir(), "companion-schedule-"));
  const storePath = join(directory, "threads.db");
  let daemon: Daemon | undefined;
  try {
    daemon = await startDaemon({ storePath, engine: recording(prompts) });
    const bot = await createBot(daemon, "Ada");
    await daemon.close();
    daemon = undefined;

    const now = Date.now();
    const minute = 60_000;
    const hour = 60 * minute;
    const dailyMiss = now - 3 * hour;
    const recent = now - 20 * minute;
    const earlier = recent - 60 * minute;
    const staleOnce = now - 3 * minute;
    const freshOnce = now - 30_000;
    const store = openThreadStore(storePath);
    store.saveSchedule({
      id: "daily",
      botId: bot.id,
      prompt: "Daily weather",
      kind: "interval",
      everyMinutes: 1440,
      anchorAt: dailyMiss,
      timezone: "UTC",
    });
    store.saveSchedule({
      id: "hourly",
      botId: bot.id,
      prompt: "Hourly weather",
      kind: "interval",
      everyMinutes: 60,
      anchorAt: earlier,
      timezone: "UTC",
    });
    store.saveSchedule({
      id: "stale",
      botId: bot.id,
      prompt: "Stale once",
      kind: "once",
      at: staleOnce,
    });
    store.saveSchedule({
      id: "fresh",
      botId: bot.id,
      prompt: "Fresh once",
      kind: "once",
      at: freshOnce,
    });
    store.close();
    const db = new DatabaseSync(storePath);
    const setCreated = db.prepare(
      "UPDATE schedules SET created_at = ? WHERE id = ?",
    );
    setCreated.run(dailyMiss - 1000, "daily");
    setCreated.run(earlier - 1000, "hourly");
    setCreated.run(staleOnce - 1000, "stale");
    setCreated.run(freshOnce - 1000, "fresh");
    db.close();

    const caughtUp = await startDaemon({
      storePath,
      engine: recording(prompts),
    });
    daemon = caughtUp;
    await waitFor(
      () =>
        caughtUp
          .receipts("hourly")
          .some((receipt) => receipt.outcome === "ran") &&
        caughtUp.receipts("fresh").some((receipt) => receipt.outcome === "ran"),
    );
    expect(prompts.filter((prompt) => prompt === "Daily weather")).toEqual([]);
    expect(prompts.filter((prompt) => prompt === "Stale once")).toEqual([]);
    expect(prompts.filter((prompt) => prompt === "Hourly weather")).toEqual([
      "Hourly weather",
    ]);
    expect(prompts.filter((prompt) => prompt === "Fresh once")).toEqual([
      "Fresh once",
    ]);
    expect(daemon.receipts("daily")).toEqual([
      { occurrence: dailyMiss, outcome: "skipped" },
    ]);
    expect(daemon.receipts("hourly")).toEqual([
      { occurrence: earlier, outcome: "skipped" },
      { occurrence: recent, outcome: "ran" },
    ]);
    expect(daemon.receipts("stale")).toEqual([
      { occurrence: staleOnce, outcome: "skipped" },
    ]);
    expect(daemon.receipts("fresh")).toEqual([
      { occurrence: freshOnce, outcome: "ran" },
    ]);
  } finally {
    await daemon?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("slots that pass while a person is talking still run", async () => {
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => {};
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const prompts: string[] = [];
  const engine: Engine = {
    async prompt(_botId, text, onUpdate) {
      if (text.startsWith("Your name is")) return "end_turn";
      if (text === "hold") {
        started();
        await hold;
        return "end_turn";
      }
      prompts.push(text);
      onUpdate(umbrella);
      return "end_turn";
    },
    async close() {},
  };
  const directory = mkdtempSync(join(tmpdir(), "companion-schedule-"));
  let daemon: Daemon | undefined;
  let pending: Promise<Response> | undefined;
  try {
    daemon = await startDaemon({
      storePath: join(directory, "threads.db"),
      engine,
    });
    const bot = await createBot(daemon, "Ada");
    pending = postJson(daemon, `/bots/${bot.id}/messages`, { text: "hold" });
    await running;
    const slot = await upcomingMinute();
    const schedule = daemon.createSchedule({
      botId: bot.id,
      prompt: "Interval weather",
      kind: "interval",
      everyMinutes: 1,
      anchorAt: slot,
      timezone: "UTC",
    });
    await delay(Math.max(0, slot + 60_000 + 300 - Date.now()));
    release();
    expect((await pending).status).toBe(200);
    const live = daemon;
    await waitFor(() => {
      const decided = live.receipts(schedule.id);
      const last = decided[decided.length - 1];
      return (
        decided.length >= 2 && last?.outcome === "ran" && last.occurrence > slot
      );
    }, 10_000);
    const receipts = daemon.receipts(schedule.id);
    expect(receipts[0]).toEqual({ occurrence: slot, outcome: "ran" });
    const last = receipts[receipts.length - 1];
    expect(last?.outcome).toBe("ran");
    expect(last?.occurrence).toBeGreaterThan(slot);
    for (const receipt of receipts.slice(1, -1)) {
      expect(receipt.outcome).toBe("skipped");
    }
    expect(
      prompts.filter((prompt) => prompt === "Interval weather"),
    ).toHaveLength(
      receipts.filter((receipt) => receipt.outcome === "ran").length,
    );
  } finally {
    release();
    await pending?.catch(() => undefined);
    await daemon?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);

/**
 * The next UTC minute, at least two seconds away.
 * Cron `* * * * *` and a one-minute interval anchored there share that instant.
 */
async function upcomingMinute(): Promise<number> {
  let slot = Math.floor(Date.now() / 60_000) * 60_000 + 60_000;
  if (slot - Date.now() < 2_000) {
    await delay(slot - Date.now() + 50);
    slot += 60_000;
  }
  return slot;
}

function recording(prompts: string[]): Engine {
  return {
    async prompt(_botId, text, onUpdate) {
      prompts.push(text);
      if (text.startsWith("Your name is")) return "end_turn";
      onUpdate(umbrella);
      return "end_turn";
    },
    async close() {},
  };
}

async function createBot(daemon: Daemon, name: string): Promise<BotView> {
  const response = await postJson(daemon, "/bots", { name });
  expect(response.status).toBe(201);
  return (await response.json()) as BotView;
}

function postJson(
  daemon: Daemon,
  path: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${daemon.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function waitFor(ready: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() >= deadline) {
      throw new Error("The schedule did not fire.");
    }
    await delay(20);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
