/**
 * The daemon's copy of each thread: its transcript, and how to resume it.
 * OpenCode keeps its own session. This file is what a restart lists and loads.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type * as acp from "@agentclientprotocol/sdk";
import {
  engineNames,
  type Bot,
  type EngineName,
  type Thread,
  type ThreadResume,
  type ThreadSummary,
} from "@companion/shared";

const schemaVersion = 1;

/**
 * Bots, the threads they own, and the session updates that form each transcript.
 * A newer file is refused so an old daemon does not misread it.
 */
const schema = `
  CREATE TABLE IF NOT EXISTS bots (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    engine TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots(id),
    engine TEXT NOT NULL,
    session_id TEXT,
    cwd TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS updates (
    thread_id TEXT NOT NULL REFERENCES threads(id),
    seq INTEGER NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (thread_id, seq)
  ) STRICT;
`;

/** The daemon's threads, opened on one database file. */
export type ThreadStore = {
  /** Records a bot and the engine its new threads start on. */
  createBot(input: { name: string; engine: EngineName }): Bot;
  /** Reads one bot back. */
  getBot(id: string): Bot;
  /** Lists every bot, in the order they were created. */
  listBots(): Bot[];
  /** Changes the engine new threads copy. Existing threads keep theirs. */
  setBotEngine(id: string, engine: EngineName): Bot;
  /** Starts a thread for a bot, copying that bot's engine. */
  createThread(input: { botId: string; cwd: string }): Thread;
  /** Stores the engine session a restart passes to session/load. */
  attachSession(threadId: string, sessionId: string): void;
  /** Appends one session update, in the order the engine sent it. */
  appendUpdate(threadId: string, update: acp.SessionUpdate): void;
  /** Reads a thread and its transcript back. */
  getThread(id: string): Thread;
  /** Lists threads without their transcripts. Omitting the bot lists them all. */
  listThreads(botId?: string): ThreadSummary[];
  /** The engine to start, and the session and directory to load. */
  resume(threadId: string): ThreadResume;
  /** Closes the database so a later open sees every write. */
  close(): void;
};

/**
 * The one conversation stored for a bot.
 * The local API creates that row with the bot and never adds a second.
 */
export function botConversation(
  store: ThreadStore,
  botId: string,
): ThreadSummary {
  const threads = store.listThreads(botId);
  const thread = threads[0];
  if (threads.length !== 1 || thread === undefined) {
    throw new Error("A bot has one conversation.");
  }
  return thread;
}

/**
 * Where this machine keeps the daemon's thread database.
 * `XDG_DATA_HOME` moves it. Otherwise it is `~/.local/share/companion/threads.db`.
 */
export function threadStorePath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configured = env.XDG_DATA_HOME?.trim();
  const root = configured ? configured : join(home, ".local", "share");
  return join(root, "companion", "threads.db");
}

/** Opens the thread database, creating the file and its folder when missing. */
export function openThreadStore(path: string): ThreadStore {
  if (path === ":memory:") {
    throw new Error(
      "The thread store needs a file so a restart can restore it.",
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  try {
    db.exec("PRAGMA journal_mode = WAL");
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return store(db);
}

function migrate(db: DatabaseSync): void {
  const version = readVersion(db);
  if (version > schemaVersion) {
    throw new Error(`Unsupported thread store version ${version}.`);
  }
  db.exec(schema);
  if (version === 0) {
    db.exec(`PRAGMA user_version = ${schemaVersion}`);
  }
}

function readVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get();
  const value = row?.user_version;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error("The thread store did not report its version.");
}

function store(db: DatabaseSync): ThreadStore {
  const insertBot = db.prepare(
    "INSERT INTO bots (id, name, engine) VALUES (?, ?, ?)",
  );
  const selectBot = db.prepare(
    "SELECT id, name, engine FROM bots WHERE id = ?",
  );
  const selectBots = db.prepare(
    "SELECT id, name, engine FROM bots ORDER BY rowid",
  );
  const updateBotEngine = db.prepare("UPDATE bots SET engine = ? WHERE id = ?");
  const insertThread = db.prepare(
    "INSERT INTO threads (id, bot_id, engine, cwd) VALUES (?, ?, ?, ?)",
  );
  const selectThread = db.prepare(
    "SELECT id, bot_id, engine, session_id, cwd FROM threads WHERE id = ?",
  );
  const selectThreads = db.prepare(
    "SELECT id, bot_id, engine, session_id, cwd FROM threads ORDER BY rowid",
  );
  const selectBotThreads = db.prepare(
    "SELECT id, bot_id, engine, session_id, cwd FROM threads WHERE bot_id = ? ORDER BY rowid",
  );
  const updateSession = db.prepare(
    "UPDATE threads SET session_id = ? WHERE id = ?",
  );
  const insertUpdate = db.prepare(
    `INSERT INTO updates (thread_id, seq, body)
     VALUES (?, COALESCE((SELECT MAX(seq) FROM updates WHERE thread_id = ?), 0) + 1, ?)`,
  );
  const selectUpdates = db.prepare(
    "SELECT body FROM updates WHERE thread_id = ? ORDER BY seq",
  );

  function requireBot(id: string): Bot {
    const row = selectBot.get(id);
    if (row === undefined) throw new Error(`Unknown bot ${id}.`);
    return botFrom(row);
  }

  function requireThread(id: string): ThreadSummary {
    const row = selectThread.get(id);
    if (row === undefined) throw new Error(`Unknown thread ${id}.`);
    return summaryFrom(row);
  }

  return {
    createBot(input) {
      const bot: Bot = {
        id: randomUUID(),
        name: required(input.name.trim(), "A bot needs a name."),
        engine: readEngine(input.engine),
      };
      insertBot.run(bot.id, bot.name, bot.engine);
      return bot;
    },

    getBot(id) {
      return requireBot(id);
    },

    listBots() {
      return selectBots.all().map((row) => botFrom(row));
    },

    setBotEngine(id, engine) {
      const next = readEngine(engine);
      requireBot(id);
      updateBotEngine.run(next, id);
      return requireBot(id);
    },

    createThread(input) {
      const bot = requireBot(input.botId);
      const thread: Thread = {
        id: randomUUID(),
        botId: bot.id,
        // The thread keeps this engine if the bot's default changes later.
        engine: bot.engine,
        sessionId: null,
        cwd: required(input.cwd, "A thread needs a working directory."),
        updates: [],
      };
      insertThread.run(thread.id, thread.botId, thread.engine, thread.cwd);
      return thread;
    },

    attachSession(threadId, sessionId) {
      requireThread(threadId);
      updateSession.run(
        required(sessionId, "A session id is required."),
        threadId,
      );
    },

    appendUpdate(threadId, update) {
      requireThread(threadId);
      // Sequence numbers keep the transcript in arrival order across a restart.
      insertUpdate.run(threadId, threadId, JSON.stringify(update));
    },

    getThread(id) {
      const summary = requireThread(id);
      const updates = selectUpdates.all(id).map((row) => readUpdate(row.body));
      return { ...summary, updates };
    },

    listThreads(botId) {
      if (botId !== undefined) requireBot(botId);
      const rows =
        botId === undefined ? selectThreads.all() : selectBotThreads.all(botId);
      return rows.map((row) => summaryFrom(row));
    },

    resume(threadId) {
      const thread = requireThread(threadId);
      if (thread.sessionId === null) {
        throw new Error("This thread has no session to resume.");
      }
      return {
        engine: thread.engine,
        sessionId: thread.sessionId,
        cwd: thread.cwd,
      };
    },

    close() {
      db.close();
    },
  };
}

type SqlValue = string | number | bigint | null | Uint8Array;
type SqlRow = Record<string, SqlValue>;

function botFrom(row: SqlRow): Bot {
  return {
    id: text(row, "id"),
    name: text(row, "name"),
    engine: readEngine(text(row, "engine")),
  };
}

function summaryFrom(row: SqlRow): ThreadSummary {
  return {
    id: text(row, "id"),
    botId: text(row, "bot_id"),
    engine: readEngine(text(row, "engine")),
    sessionId: textOrNull(row, "session_id"),
    cwd: text(row, "cwd"),
  };
}

function readUpdate(body: SqlValue): acp.SessionUpdate {
  if (typeof body !== "string") {
    throw new Error("A stored session update could not be read.");
  }
  const value: unknown = JSON.parse(body);
  if (
    typeof value === "object" &&
    value !== null &&
    "sessionUpdate" in value &&
    typeof value.sessionUpdate === "string"
  ) {
    return value as acp.SessionUpdate;
  }
  throw new Error("A stored session update could not be read.");
}

function readEngine(value: string): EngineName {
  for (const engine of engineNames) {
    if (value === engine) return engine;
  }
  throw new Error(`Unknown engine ${value}.`);
}

function required(value: string, message: string): string {
  if (value.trim() === "") throw new Error(message);
  return value;
}

function text(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value === "string") return value;
  throw new Error(`The thread store row is missing ${key}.`);
}

function textOrNull(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  return text(row, key);
}
