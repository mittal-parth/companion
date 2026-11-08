/**
 * Local API for one user's bots.
 * A bot is one long-lived conversation: create it, send a message, and read
 * the turn as server-sent events. The stored thread is that conversation.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  engineNames,
  type Bot,
  type BotTranscript,
  type BotView,
  type EngineName,
  type TurnEvent,
} from "@companion/shared";
import {
  defaultOpencodeModel,
  opencodeModelConfig,
  startOpencodeEngine,
  type Engine,
} from "./engine.js";
import {
  botConversation,
  openThreadStore,
  type ThreadStore,
} from "./thread-store.js";

/** A daemon listening on localhost. */
export type Daemon = {
  url: string;
  port: number;
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
  const server = createServer((req, res) => {
    void handle(req, res, {
      store,
      storePath: options.storePath,
      engine,
      model,
      busy,
    }).catch((error: unknown) => {
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

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    async close() {
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
      const bot = createBot(handler, body);
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
    sendJson(res, 200, transcript(handler.store, botId));
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

/** Creates the bot, its folder, and the single conversation row. */
function createBot(handler: Handler, body: Record<string, unknown>): BotView {
  const name = requiredString(body, "name", "A bot needs a name.");
  const engine = engineName(body.engine);
  const bot = handler.store.createBot({ name, engine });
  const directory = resolve(dirname(handler.storePath), "bots", bot.id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "opencode.json"),
    opencodeModelConfig(handler.model),
  );
  handler.store.createThread({ botId: bot.id, cwd: directory });
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

function transcript(store: ThreadStore, botId: string): BotTranscript {
  const bot = store.getBot(botId);
  const thread = botConversation(store, botId);
  return {
    ...view(store, bot),
    updates: store.getThread(thread.id).updates,
  };
}

/**
 * Streams one turn. A second message for the same bot is refused until this
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
  const bot = handler.store.getBot(botId);
  const thread = botConversation(handler.store, botId);
  if (bot.engine !== "opencode") {
    sendJson(res, 400, { error: "This daemon only runs OpenCode." });
    return;
  }
  if (handler.busy.has(botId)) {
    sendJson(res, 409, { error: "This bot is already working on a turn." });
    return;
  }
  handler.busy.add(botId);
  let started = false;
  try {
    const stopReason = await handler.engine.prompt(botId, text, (update) => {
      if (!started) {
        started = true;
        res.writeHead(200, sseHeaders);
      }
      handler.store.appendUpdate(thread.id, update);
      writeEvent(res, { event: "update", data: update });
    });
    if (!started) {
      started = true;
      res.writeHead(200, sseHeaders);
    }
    writeEvent(res, { event: "done", data: { stopReason } });
    res.end();
  } catch (error) {
    const message = httpStatus(error).message;
    if (!started) {
      sendJson(res, 500, { error: message });
      return;
    }
    if (!res.writableEnded) {
      writeEvent(res, { event: "error", data: { error: message } });
      res.end();
    }
  } finally {
    handler.busy.delete(botId);
  }
}

const sseHeaders = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive",
};

function writeEvent(res: ServerResponse, event: TurnEvent): void {
  if (res.destroyed || res.writableEnded) return;
  res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
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
    message.startsWith("A message needs")
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

function engineName(value: unknown): EngineName {
  if (value === undefined) return "opencode";
  if (typeof value !== "string") {
    throw new HttpError(400, "A bot's engine must be a name.");
  }
  for (const name of engineNames) {
    if (value === name) return name;
  }
  throw new HttpError(400, `Unknown engine ${value}.`);
}
