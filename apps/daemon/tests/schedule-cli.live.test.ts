/**
 * Proves a real bot creates, pauses and deletes a schedule by running the CLI.
 * Skipped unless COMPANION_LIVE=1, so CI does not call the provider.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScheduleLogEntry } from "@companion/shared";
import { expect, test } from "vitest";
import { hasToolCall } from "../src/acp-hello.js";
import { startDaemon } from "../src/api.js";
import {
  askBot,
  createLiveBot,
  opencodeBin,
  requireOpencode,
} from "./helpers.js";

const live = process.env.COMPANION_LIVE === "1";

test.skipIf(!live)(
  "the bot creates, pauses and deletes a daily schedule through the CLI",
  async () => {
    requireOpencode();
    const directory = mkdtempSync(join(tmpdir(), "companion-schedule-live-"));
    const entries: ScheduleLogEntry[] = [];
    const daemon = await startDaemon({
      storePath: join(directory, "threads.db"),
      opencodeBin,
      log: (entry) => entries.push(entry),
    });
    try {
      const bot = await createLiveBot(daemon, "Scheduler");
      const marker = `marigold-${randomUUID().slice(0, 8)}`;
      const created = await askBot(
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

      const paused = await askBot(daemon, bot.id, "Pause that schedule.");
      expect(
        daemon.listSchedules(bot.id),
        JSON.stringify(paused.events),
      ).toHaveLength(1);
      expect(entries.some((entry) => entry.event === "paused")).toBe(true);

      const removed = await askBot(daemon, bot.id, "Delete that schedule.");
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
