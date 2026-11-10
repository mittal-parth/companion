/**
 * Local API for one user's bots.
 * A bot is one long-lived conversation: create it, and OpenCode takes the
 * first turn. Later messages stream as server-sent events while that client
 * stays connected. Closing the connection does not stop the turn. The stored
 * updates and the turn's state stay on the daemon for whatever client comes
 * back. The model keeps that bot's instructions and memory in its folder.
 * A schedule sends its prompt into that same conversation.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import {
  engineNames,
  engines,
  type Bot,
  type BotTranscript,
  type BotView,
  type EngineName,
  type Schedule,
  type ScheduleReceipt,
  type TurnEvent,
  type TurnState,
} from "@companion/shared";
import {
  defaultOpencodeModel,
  opencodeModelConfig,
  startOpencodeEngine,
  type Engine,
} from "./engine.js";
import { startScheduler } from "./scheduler.js";
import {
  botConversation,
  openThreadStore,
  type ThreadStore,
} from "./thread-store.js";

/** A daemon listening on localhost. */
export type Daemon = {
  url: string;
  port: number;
  /** Stores a schedule and arms its next slot. An omitted id is filled in. */
  createSchedule(input: unknown): Schedule;
  /** Schedules in the order they were stored. Omitting the bot lists them all. */
  listSchedules(botId?: string): Schedule[];
  /** Stops a schedule and removes it. */
  deleteSchedule(id: string): void;
  /** Slots the daemon has decided, oldest first. */
  receipts(scheduleId: string): ScheduleReceipt[];
  close(): Promise<void>;
};

/** Where the database lives, and which engine runs the turns. */
export type DaemonOptions = {
  /** SQLite file for bots and their conversations. */
  storePath: string;
  /** `0` asks the operating system for a free port. */
  port?: number;
  /** Replaces OpenCode. Tests pass one that scripts a turn. */
  engine?: Engine;
  opencodeBin?: string;
  /** OpenCode model id. Defaults to Sarvam GLM 5.3. */
  model?: string;
};

/**
 * Listens on 127.0.0.1.
 * Creating a bot also creates its folder and its one conversation.
 */
export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const store = openThreadStore(options.storePath);
  const model = options.model ?? defaultOpencodeModel;
  const root = dirname(options.storePath);
  let engine: Engine;
  try {
    engine =
      options.engine ??
      (await startOpencodeEngine({
        store,
        bin: options.opencodeBin ?? "opencode",
        model,
        dataHome: join(root, "opencode-data"),
        configHome: join(root, "opencode-config"),
      }));
  } catch (error) {
    store.close();
    throw error;
  }

  const busy = new Set<string>();
  const turns = new Map<string, TurnState>();
  const idleWaiters = new Map<string, Array<() => void>>();
  let stopping = false;

  function whenIdle(botId: string): Promise<void> {
    if (stopping || !busy.has(botId)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiting = idleWaiters.get(botId) ?? [];
      waiting.push(resolve);
      idleWaiters.set(botId, waiting);
    });
  }

  function release(botId: string): void {
    busy.delete(botId);
    const waiting = idleWaiters.get(botId) ?? [];
    idleWaiters.delete(botId);
    for (const resolve of waiting) resolve();
  }

  function stopTurns(): void {
    stopping = true;
    for (const waiting of idleWaiters.values()) {
      for (const resolve of waiting) resolve();
    }
    idleWaiters.clear();
  }

  const handler: Handler = {
    store,
    storePath: options.storePath,
    engine,
    model,
    busy,
    turns,
    whenIdle,
    release,
    stopping: () => stopping,
  };
  const server = createServer((req, res) => {
    void handle(req, res, handler).catch((error: unknown) => {
      if (res.headersSent || res.writableEnded) {
        res.destroy();
        return;
      }
      const mapped = httpStatus(error);
      sendJson(res, mapped.status, { error: mapped.message });
    });
  });

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(options.port ?? 0, "127.0.0.1", () => {
        resolveListen();
      });
    });
  } catch (error) {
    await engine.close();
    store.close();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    await engine.close();
    store.close();
    throw new Error("The daemon did not bind a local port.");
  }

  const scheduler = startScheduler({
    store,
    send: (botId, text) => runTurnWhenFree(handler, botId, text),
  });

  let closed = false;
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    createSchedule: (input) => scheduler.create(input),
    listSchedules: (botId) => scheduler.list(botId),
    deleteSchedule: (id) => scheduler.delete(id),
    receipts: (scheduleId) => scheduler.receipts(scheduleId),
    async close() {
      if (closed) return;
      closed = true;
      stopTurns();
      scheduler.stop();
      server.closeAllConnections();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (
            error &&
            (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
          ) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      });
      try {
        await engine.close();
      } finally {
        store.close();
      }
    },
  };
}

type Handler = {
  store: ThreadStore;
  storePath: string;
  engine: Engine;
  model: string;
  busy: Set<string>;
  turns: Map<string, TurnState>;
  whenIdle(botId: string): Promise<void>;
  release(botId: string): void;
  stopping(): boolean;
};

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  handler: Handler,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter((part) => part !== "");
  if (parts[0] !== "bots") {
    sendJson(res, 404, { error: "Unknown route." });
    return;
  }
  if (parts.length === 1) {
    if (req.method === "GET") {
      sendJson(
        res,
        200,
        handler.store.listBots().map((bot) => view(handler.store, bot)),
      );
      return;
    }
    if (req.method === "POST") {
      const body = await readObject(req);
      const bot = await createBot(handler, body);
      sendJson(res, 201, bot);
      return;
    }
    sendJson(res, 405, { error: "Use GET or POST." });
    return;
  }

  const botId = parts[1];
  if (botId === undefined) {
    sendJson(res, 404, { error: "Unknown route." });
    return;
  }
  if (parts.length === 2) {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Use GET." });
      return;
    }
    sendJson(res, 200, transcript(handler, botId));
    return;
  }
  if (parts.length === 3 && parts[2] === "messages") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Use POST." });
      return;
    }
    await sendMessage(req, res, handler, botId);
    return;
  }
  sendJson(res, 404, { error: "Unknown route." });
}

/**
 * The first turn of a bot's conversation.
 * A description is the role to keep. Without one, the bot asks what it is for.
 * The model writes AGENTS.md and MEMORY.md when the turn gives it something to keep.
 */
export function openingPrompt(name: string, description?: string): string {
  const named = `Your name is ${name}.`;
  if (description === undefined) {
    return `${named}\n\nThe person who created you did not say what you are for. Greet them and ask what they want you to do. Do not invent a role.`;
  }
  return [
    named,
    "",
    "The person who created you described you this way:",
    description,
    "",
    "Write that into AGENTS.md in your working directory, keeping the meaning, and record your name there. Put any fact worth keeping into MEMORY.md.",
    "Reply briefly as that bot. If one or two details would change how you do the work, ask those before you start. Otherwise begin.",
  ].join("\n");
}

/**
 * Creates the bot, its folder, and the single conversation.
 * An OpenCode bot then takes its first turn, so the chat already has a reply.
 */
async function createBot(
  handler: Handler,
  body: Record<string, unknown>,
): Promise<BotView> {
  const name = requiredString(body, "name", "A bot needs a name.");
  const engine = engineName(body.engine);
  const description = optionalDescription(body.description);
  const bot = handler.store.createBot({ name, engine });
  const directory = resolve(dirname(handler.storePath), "bots", bot.id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "opencode.json"),
    opencodeModelConfig(handler.model),
  );
  handler.store.createThread({ botId: bot.id, cwd: directory });
  switch (engine) {
    case engines.opencode:
      await runTurn(
        handler,
        bot.id,
        openingPrompt(name, description),
        () => {},
      );
      break;
    case engines.claude:
    case engines.codex:
      // Those engines are not started yet. The folder is ready for them.
      break;
    default: {
      const unexpected: never = engine;
      throw new Error(`Unexpected engine ${String(unexpected)}.`);
    }
  }
  return view(handler.store, bot);
}

function view(store: ThreadStore, bot: Bot): BotView {
  const thread = botConversation(store, bot.id);
  return {
    id: bot.id,
    name: bot.name,
    engine: bot.engine,
    directory: thread.cwd,
  };
}

function transcript(handler: Handler, botId: string): BotTranscript {
  const bot = handler.store.getBot(botId);
  const thread = botConversation(handler.store, botId);
  return {
    ...view(handler.store, bot),
    updates: handler.store.getThread(thread.id).updates,
    turn: handler.turns.get(botId) ?? { status: "idle" },
  };
}

/**
 * Streams one turn while the client stays connected.
 * If that connection closes, the turn keeps running. Its outcome is stored
 * for a later read. A second message for the same bot is refused until this
 * one finishes, so its session updates stay in order.
 */
async function sendMessage(
  req: IncomingMessage,
  res: ServerResponse,
  handler: Handler,
  botId: string,
): Promise<void> {
  const body = await readObject(req);
  const text = requiredString(body, "text", "A message needs text.");
  let started = false;
  let detached = false;
  const detach = () => {
    detached = true;
  };
  // A dropped socket is the client leaving. It is not a failed turn.
  req.on("error", detach);
  res.on("error", detach);
  res.on("close", () => {
    if (!res.writableFinished) detach();
  });
  const send = (event: TurnEvent) => {
    if (detached) return;
    try {
      if (!started) {
        started = true;
        res.writeHead(200, sseHeaders);
      }
      writeEvent(res, event);
    } catch {
      detach();
    }
  };
  try {
    const stopReason = await runTurn(handler, botId, text, (update) => {
      send({ event: "update", data: update });
    });
    send({ event: "done", data: { stopReason } });
    endStream(res);
  } catch (error) {
    if (detached) return;
    const message = httpStatus(error).message;
    if (!started) {
      sendJson(res, httpStatus(error).status, { error: message });
      return;
    }
    send({ event: "error", data: { error: message } });
    endStream(res);
  }
}

/**
 * Runs one turn and stores each update before the caller sees it.
 * Records the turn as running, then finished or failed, so a later read can
 * say what happened after the client has gone. The busy set is taken before
 * any wait, so two turns of one bot cannot overlap and two bots can.
 */
async function runTurn(
  handler: Handler,
  botId: string,
  text: string,
  onUpdate: (update: acp.SessionUpdate) => void,
): Promise<acp.StopReason> {
  const bot = handler.store.getBot(botId);
  if (bot.engine !== engines.opencode) {
    throw new HttpError(400, "This daemon only runs OpenCode.");
  }
  if (handler.busy.has(botId)) {
    throw new HttpError(409, "This bot is already working on a turn.");
  }
  handler.busy.add(botId);
  handler.turns.set(botId, { status: "running" });
  const thread = botConversation(handler.store, botId);
  try {
    const stopReason = await handler.engine.prompt(botId, text, (update) => {
      handler.store.appendUpdate(thread.id, update);
      onUpdate(update);
    });
    handler.turns.set(botId, { status: "finished", stopReason });
    return stopReason;
  } catch (error) {
    handler.turns.set(botId, {
      status: "failed",
      error: httpStatus(error).message,
    });
    throw error;
  } finally {
    handler.release(botId);
  }
}

/**
 * Sends a prompt once this bot's current turn has finished.
 * A person's second message is still refused. A schedule waits instead.
 */
async function runTurnWhenFree(
  handler: Handler,
  botId: string,
  text: string,
): Promise<acp.StopReason> {
  for (;;) {
    if (handler.stopping()) throw new Error("The daemon is stopping.");
    try {
      return await runTurn(handler, botId, text, () => {
        // The update is already stored. A schedule has no open response.
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) {
        await handler.whenIdle(botId);
        continue;
      }
      throw error;
    }
  }
}

const sseHeaders = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive",
};

function writeEvent(res: ServerResponse, event: TurnEvent): void {
  if (res.destroyed || res.writableEnded || !res.writable) return;
  res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

/** Ends the stream. A client that has already gone is left alone. */
function endStream(res: ServerResponse): void {
  if (res.destroyed || res.writableEnded) return;
  try {
    res.end();
  } catch {
    // The client closed the connection. The turn has already been recorded.
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function httpStatus(error: unknown): { status: number; message: string } {
  if (error instanceof HttpError) {
    return { status: error.status, message: error.message };
  }
  const message = error instanceof Error ? error.message : "The daemon failed.";
  if (message.startsWith("Unknown bot")) return { status: 404, message };
  if (
    message.startsWith("A bot needs") ||
    message.startsWith("Unknown engine") ||
    message.startsWith("The request") ||
    message.startsWith("A message needs") ||
    message.startsWith("A description must")
  ) {
    return { status: 400, message };
  }
  return { status: 500, message };
}

async function readObject(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const body = await readBody(req);
  if (body.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new HttpError(400, "The request body must be JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "The request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        rejectBody(new HttpError(400, "The request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolveBody(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", () => {
      rejectBody(new HttpError(400, "The request body must be JSON."));
    });
  });
}

function requiredString(
  body: Record<string, unknown>,
  key: string,
  message: string,
): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, message);
  }
  return value.trim();
}

/** A description is optional. Blank text is the same as leaving it out. */
function optionalDescription(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new HttpError(400, "A description must be text.");
  }
  const description = value.trim();
  if (description === "") return undefined;
  return description;
}

function engineName(value: unknown): EngineName {
  if (value === undefined) return engines.opencode;
  if (typeof value !== "string") {
    throw new HttpError(400, "A bot's engine must be a name.");
  }
  for (const name of engineNames) {
    if (value === name) return name;
  }
  throw new HttpError(400, `Unknown engine ${value}.`);
}
