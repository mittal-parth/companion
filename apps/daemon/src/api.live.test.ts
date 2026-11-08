/**
 * Drives one full turn through the local API with a real OpenCode process.
 * Skipped unless COMPANION_LIVE=1. The free model refused on the last run.
 * docs/phase-2-1.md says how to point this at a keyed provider.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type { BotTranscript, BotView, TurnEvent } from "@companion/shared";
import { expect, test } from "vitest";
import { hasToolCall, replyText } from "./acp-hello.js";
import { startDaemon } from "./api.js";
import { openThreadStore } from "./thread-store.js";

const opencodeBin = process.env.OPENCODE_BIN ?? "opencode";
const live = process.env.COMPANION_LIVE === "1";

function opencodeStarts(): boolean {
  return (
    spawnSync(opencodeBin, ["--version"], { encoding: "utf8" }).status === 0
  );
}

test.skipIf(!live)(
  "a message streams a full OpenCode turn",
  async () => {
    if (!opencodeStarts()) {
      throw new Error(`COMPANION_LIVE=1 but ${opencodeBin} did not start.`);
    }
    const directory = mkdtempSync(join(tmpdir(), "companion-live-"));
    const storePath = join(directory, "threads.db");
    const daemon = await startDaemon({
      storePath,
      opencodeBin,
    });
    try {
      const created = await fetch(`${daemon.url}/bots`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Content" }),
      });
      expect(created.status).toBe(201);
      const bot = (await created.json()) as BotView;
      const word = `marigold-${randomUUID().slice(0, 8)}`;
      writeFileSync(join(bot.directory, "note.txt"), `${word}\n`, "utf8");

      const response = await fetch(`${daemon.url}/bots/${bot.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "Read note.txt in the working directory with a file-reading tool, then reply with only the exact word in that file.",
        }),
      });
      expect(response.status).toBe(200);
      const events = parseEvents(await response.text());
      const failure = events.find((event) => event.event === "error");
      expect(failure, JSON.stringify(events)).toBeUndefined();
      const updates = events.flatMap((event) =>
        event.event === "update" ? [event.data] : [],
      );
      const done = events.find((event) => event.event === "done");
      expect(replyText(updates), JSON.stringify(events)).toContain(word);
      expect(hasToolCall(updates), JSON.stringify(events)).toBe(true);
      expect(done, JSON.stringify(events)).toEqual({
        event: "done",
        data: { stopReason: "end_turn" },
      });

      const stored = await fetch(`${daemon.url}/bots/${bot.id}`);
      const transcript = (await stored.json()) as BotTranscript;
      expect(transcript.updates).toEqual(updates);
    } finally {
      await daemon.close();
    }

    const store = openThreadStore(storePath);
    try {
      const threads = store.listThreads();
      expect(threads).toHaveLength(1);
      expect(threads[0]?.sessionId).toEqual(expect.any(String));
      expect(threads[0]?.engine).toBe("opencode");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  150_000,
);

function parseEvents(body: string): TurnEvent[] {
  const events: TurnEvent[] = [];
  for (const block of body.split("\n\n")) {
    if (block.trim() === "") continue;
    let name = "";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) name = line.slice("event:".length).trim();
      if (line.startsWith("data:"))
        data.push(line.slice("data:".length).trim());
    }
    const payload: unknown = JSON.parse(data.join("\n"));
    if (name === "update") {
      events.push({ event: "update", data: payload as acp.SessionUpdate });
      continue;
    }
    if (name === "done") {
      events.push({
        event: "done",
        data: payload as { stopReason: acp.StopReason },
      });
      continue;
    }
    if (name === "error") {
      events.push({ event: "error", data: payload as { error: string } });
      continue;
    }
    throw new Error(`Unexpected event ${name}.`);
  }
  return events;
}
