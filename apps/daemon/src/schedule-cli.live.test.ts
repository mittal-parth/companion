/**
 * Proves a real bot creates, pauses and deletes a schedule by running the CLI.
 * Skipped unless COMPANION_LIVE=1, so CI does not call the provider.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BotTranscript,
  BotView,
  ScheduleLogEntry,
} from "@companion/shared";
import { expect, test } from "vitest";
import { hasToolCall } from "./acp-hello.js";
import { startDaemon, type Daemon } from "./api.js";

const opencodeBin = process.env.OPENCODE_BIN ?? "opencode";
const live = process.env.COMPANION_LIVE === "1";

function opencodeStarts(): boolean {
  return (
    spawnSync(opencodeBin, ["--version"], { encoding: "utf8" }).status === 0
  );
}

test.skipIf(!live)(
  "the bot creates, pauses and deletes a daily schedule through the CLI",
  async () => {
    if (!opencodeStarts()) {
      throw new Error(`COMPANION_LIVE=1 but ${opencodeBin} did not start.`);
    }
    const directory = mkdtempSync(join(tmpdir(), "companion-schedule-live-"));
    const entries: ScheduleLogEntry[] = [];
    const daemon = await startDaemon({
      storePath: join(directory, "threads.db"),
      opencodeBin,
      model: "sarvam/sarvam-105b",
      log: (entry) => entries.push(entry),
    });
    try {
      const bot = await createBot(daemon);
      const marker = `marigold-${randomUUID().slice(0, 8)}`;
      const created = await ask(
        daemon,
        bot.id,
        `My timezone is Asia/Kolkata. Every day at 9:00, run this task: reply with the word ${marker}.`,
      );
      expect(hasToolCall(created.updates), JSON.stringify(created.events)).toBe(
        true,
      );
      const schedules = daemon.listSchedules(bot.id);
      expect(schedules, JSON.stringify(schedules)).toHaveLength(1);
      expect(schedules[0]).toMatchObject({
        kind: "cron",
        expression: "0 9 * * *",
        timezone: "Asia/Kolkata",
      });
      expect(schedules[0]?.prompt).toContain(marker);

      const paused = await ask(daemon, bot.id, "Pause that schedule.");
      expect(
        daemon.listSchedules(bot.id),
        JSON.stringify(paused.events),
      ).toHaveLength(1);
      expect(entries.some((entry) => entry.event === "paused")).toBe(true);

      const removed = await ask(daemon, bot.id, "Delete that schedule.");
      expect(
        daemon.listSchedules(bot.id),
        JSON.stringify(removed.events),
      ).toEqual([]);
    } finally {
      await daemon.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  600_000,
);

async function createBot(daemon: Daemon): Promise<BotView> {
  const response = await fetch(`${daemon.url}/bots`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Scheduler" }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as BotView;
}

/**
 * Sends one message and reads the streamed turn.
 * `events` is the raw stream, kept so a failure shows what the bot did.
 */
async function ask(
  daemon: Daemon,
  botId: string,
  text: string,
): Promise<{ updates: BotTranscript["updates"]; events: unknown[] }> {
  const response = await fetch(`${daemon.url}/bots/${botId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  expect(response.status).toBe(200);
  const events = parseEvents(await response.text());
  const failure = events.find((event) => event.event === "error");
  expect(failure, JSON.stringify(events)).toBeUndefined();
  return {
    updates: events.flatMap((event) =>
      event.event === "update" ? [event.data] : [],
    ),
    events,
  };
}

type StreamEvent =
  | { event: "update"; data: BotTranscript["updates"][number] }
  | { event: "done"; data: { stopReason: string } }
  | { event: "error"; data: { error: string } };

function parseEvents(body: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const block of body.split("\n\n")) {
    const lines = block.split("\n");
    const name = lines.find((line) => line.startsWith("event: "))?.slice(7);
    const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
    if (name === undefined || data === undefined) continue;
    const parsed = JSON.parse(data) as StreamEvent["data"];
    if (name === "update")
      events.push({
        event: "update",
        data: parsed as BotTranscript["updates"][number],
      });
    else if (name === "done")
      events.push({ event: "done", data: parsed as { stopReason: string } });
    else if (name === "error")
      events.push({ event: "error", data: parsed as { error: string } });
  }
  return events;
}
