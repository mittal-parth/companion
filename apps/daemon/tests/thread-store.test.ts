/**
 * Proves a restarted daemon reads the same thread back, including which
 * engine to start and the session updates OpenCode sent.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { RecordedSession } from "@companion/shared";
import { expect, test } from "vitest";
import {
  botConversation,
  openThreadStore,
  threadStorePath,
} from "../src/thread-store.js";

const recorded = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../fixtures/opencode-hello.json",
    ),
    "utf8",
  ),
) as RecordedSession;

test("restarting the daemon restores a thread exactly", () => {
  withDirectory((directory) => {
    const path = join(directory, "companion", "threads.db");
    const store = openThreadStore(path);
    const bot = store.createBot({ name: "Ada", engine: "opencode" });
    const thread = store.createThread({ botId: bot.id, cwd: "/bots/ada" });
    store.attachSession(thread.id, recorded.newSession.sessionId);
    for (const update of recorded.updates) {
      store.appendUpdate(thread.id, update);
    }
    const saved = store.getThread(thread.id);
    store.close();

    const restored = openThreadStore(path);
    expect(restored.listBots()).toEqual([bot]);
    expect(restored.getThread(thread.id)).toEqual(saved);
    expect(restored.getThread(thread.id).updates).toEqual(recorded.updates);
    expect(restored.resume(thread.id)).toEqual({
      engine: "opencode",
      sessionId: recorded.newSession.sessionId,
      cwd: "/bots/ada",
    });
    expect(restored.listThreads()).toEqual([
      {
        id: thread.id,
        botId: bot.id,
        engine: "opencode",
        sessionId: recorded.newSession.sessionId,
        cwd: "/bots/ada",
      },
    ]);
    restored.close();
  });
});

test("a thread keeps the engine it started with", () => {
  withDirectory((directory) => {
    const store = openThreadStore(join(directory, "threads.db"));
    const bot = store.createBot({ name: "Ada", engine: "opencode" });
    const first = store.createThread({ botId: bot.id, cwd: "/bots/ada" });
    store.attachSession(first.id, "ses_first");
    store.appendUpdate(first.id, recorded.updates[0]!);
    store.setBotEngine(bot.id, "claude");
    const second = store.createThread({ botId: bot.id, cwd: "/bots/ada" });
    const other = store.createBot({ name: "Bea", engine: "codex" });
    const elsewhere = store.createThread({
      botId: other.id,
      cwd: "/bots/bea",
    });

    expect(store.getBot(bot.id).engine).toBe("claude");
    expect(store.getThread(first.id).engine).toBe("opencode");
    expect(second.engine).toBe("claude");
    expect(store.listThreads(bot.id).map((thread) => thread.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(store.listThreads(other.id).map((thread) => thread.id)).toEqual([
      elsewhere.id,
    ]);

    store.attachSession(first.id, "ses_replacement");
    expect(store.resume(first.id)).toEqual({
      engine: "opencode",
      sessionId: "ses_replacement",
      cwd: "/bots/ada",
    });
    expect(store.getThread(first.id).updates).toEqual([recorded.updates[0]]);
    store.close();
  });
});

test("a bot has one conversation", () => {
  withDirectory((directory) => {
    const store = openThreadStore(join(directory, "threads.db"));
    const bot = store.createBot({ name: "Content", engine: "opencode" });
    expect(() => botConversation(store, bot.id)).toThrow(
      "A bot has one conversation.",
    );
    const thread = store.createThread({ botId: bot.id, cwd: "/bots/content" });
    expect(botConversation(store, bot.id).id).toBe(thread.id);
    store.createThread({ botId: bot.id, cwd: "/bots/content" });
    expect(() => botConversation(store, bot.id)).toThrow(
      "A bot has one conversation.",
    );
    store.close();
  });
});

test("a thread without a session cannot be resumed", () => {
  withDirectory((directory) => {
    const store = openThreadStore(join(directory, "threads.db"));
    expect(() => store.createBot({ name: "  ", engine: "opencode" })).toThrow(
      "A bot needs a name.",
    );
    const bot = store.createBot({ name: "Ada", engine: "opencode" });
    const thread = store.createThread({ botId: bot.id, cwd: "/bots/ada" });
    expect(() => store.resume(thread.id)).toThrow(
      "This thread has no session to resume.",
    );
    expect(() => store.getThread("missing")).toThrow("Unknown thread missing.");
    expect(() =>
      store.createThread({ botId: "missing", cwd: "/bots/ada" }),
    ).toThrow("Unknown bot missing.");
    store.close();
  });
});

test("the thread database is separate from the engine store", () => {
  expect(threadStorePath({ XDG_DATA_HOME: "/data" }, "/home/ada")).toBe(
    "/data/companion/threads.db",
  );
  expect(threadStorePath({ XDG_DATA_HOME: "  " }, "/home/ada")).toBe(
    "/home/ada/.local/share/companion/threads.db",
  );
  expect(threadStorePath({}, "/home/ada")).toBe(
    "/home/ada/.local/share/companion/threads.db",
  );
  expect(() => openThreadStore(":memory:")).toThrow(
    "The thread store needs a file so a restart can restore it.",
  );
});

test("a schedule and its finished occurrences survive a restart", () => {
  withDirectory((directory) => {
    const path = join(directory, "threads.db");
    const store = openThreadStore(path);
    const bot = store.createBot({ name: "Ada", engine: "opencode" });
    const schedule = {
      id: "weather",
      botId: bot.id,
      prompt: "Check the weather",
      kind: "once" as const,
      at: 1_700_000_000_000,
    };
    store.saveSchedule(schedule);
    store.recordReceipt(schedule.id, schedule.at, "ran");
    store.close();

    const restored = openThreadStore(path);
    expect(restored.listSchedules(bot.id)).toEqual([schedule]);
    expect(restored.receipts(schedule.id)).toEqual([
      { occurrence: schedule.at, outcome: "ran" },
    ]);
    expect(restored.latestReceipt(schedule.id)).toBe(schedule.at);
    restored.deleteSchedule(schedule.id);
    expect(restored.hasSchedule(schedule.id)).toBe(false);
    expect(restored.listSchedules()).toEqual([]);
    restored.close();
  });
});

test("a schedule starts unpaused and a pause survives a restart", () => {
  withDirectory((directory) => {
    const path = join(directory, "threads.db");
    const store = openThreadStore(path);
    const bot = store.createBot({ name: "Ada", engine: "opencode" });
    const schedule = {
      id: "weather",
      botId: bot.id,
      prompt: "Check the weather",
      kind: "once" as const,
      at: 1_700_000_000_000,
    };
    store.saveSchedule(schedule);
    expect(store.isSchedulePaused(schedule.id)).toBe(false);
    store.setSchedulePaused(schedule.id, true);
    store.close();

    const restored = openThreadStore(path);
    expect(restored.isSchedulePaused(schedule.id)).toBe(true);
    expect(restored.getSchedule(schedule.id)).toEqual(schedule);
    restored.setSchedulePaused(schedule.id, false);
    expect(restored.isSchedulePaused(schedule.id)).toBe(false);
    expect(() => restored.setSchedulePaused("missing", true)).toThrow(
      "Unknown schedule missing.",
    );
    expect(() => restored.isSchedulePaused("missing")).toThrow(
      "Unknown schedule missing.",
    );
    restored.close();
  });
});

test("a newer thread database is refused", () => {
  withDirectory((directory) => {
    const path = join(directory, "threads.db");
    const store = openThreadStore(path);
    store.close();
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version = 4");
    db.close();
    expect(() => openThreadStore(path)).toThrow(
      "Unsupported thread store version 4.",
    );
  });
});

function withDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "companion-threads-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
