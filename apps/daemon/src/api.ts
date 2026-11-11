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
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import {
  engineNames,
  engines,
  isImageMime,
  nextRun,
  type AttachedImage,
  type Bot,
  type BotTranscript,
  type BotView,
  type BrowserLease,
  type EngineName,
  type Schedule,
  type ScheduleAccess,
  type ScheduleListing,
  type ScheduleLogEntry,
  type ScheduleReceipt,
  type TurnEvent,
  type TurnState,
} from "@companion/shared";
import { createBrowserHost, type BrowserHost } from "./browser.js";
import {
  defaultOpencodeModel,
  delegatePastedImages,
  imageBytes,
  modelReadsImages,
  opencodeModelConfig,
  startOpencodeEngine,
  type Engine,
} from "./engine.js";
import { startScheduler, type Scheduler } from "./scheduler.js";
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
  /** Stops a schedule from firing until it is resumed. */
  pauseSchedule(id: string): void;
  /** Lets a paused schedule fire at its next slot. Missed slots are skipped. */
  resumeSchedule(id: string): void;
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
  /** Receives each schedule event. Defaults to one JSON line per event on stderr. */
  log?: (entry: ScheduleLogEntry) => void;
  /** The shared Chrome. Defaults to one that keeps its profile beside the database. */
  browser?: BrowserHost;
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
        binDir: join(root, "bin"),
      }));
  } catch (error) {
    store.close();
    throw error;
  }

  const browser =
    options.browser ?? createBrowserHost({ directory: join(root, "browser") });
  const busy = new Set<string>();
  const turns = new Map<string, TurnState>();
  const followers = new Map<string, Set<(event: TurnEvent) => void>>();
  const idleWaiters = new Map<string, Array<() => void>>();
  let stopping = false;
  const schedulerHolder: { current?: Scheduler } = {};

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
    followers,
    whenIdle,
    release,
    stopping: () => stopping,
    browser,
    access: { url: "", tokens: new Map() },
    scheduler: () => {
      if (schedulerHolder.current === undefined) {
        throw new Error("The daemon is starting.");
      }
      return schedulerHolder.current;
    },
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
    await browser.close();
    store.close();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    await engine.close();
    await browser.close();
    store.close();
    throw new Error("The daemon did not bind a local port.");
  }

  const url = `http://127.0.0.1:${address.port}`;
  handler.access.url = url;
  // Every bot, old or new, gets the address and token its CLI needs.
  for (const bot of store.listBots()) {
    grantScheduleAccess(handler, bot.id);
  }
  const started = startScheduler({
    store,
    send: (botId, text) => runTurnWhenFree(handler, botId, text),
    log: options.log ?? logToStderr,
  });
  schedulerHolder.current = started;

  let closed = false;
  return {
    url,
    port: address.port,
    createSchedule: (input) => started.create(input),
    listSchedules: (botId) => started.list(botId),
    deleteSchedule: (id) => started.delete(id),
    pauseSchedule: (id) => started.pause(id),
    resumeSchedule: (id) => started.resume(id),
    receipts: (scheduleId) => started.receipts(scheduleId),
    async close() {
      if (closed) return;
      closed = true;
      stopTurns();
      started.stop();
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
        try {
          await browser.close();
        } finally {
          store.close();
        }
      }
    },
  };
}

/** The default schedule log: one JSON line per event, easy to search later. */
function logToStderr(entry: ScheduleLogEntry): void {
  process.stderr.write(`${JSON.stringify({ scope: "schedule", ...entry })}\n`);
}

type Handler = {
  store: ThreadStore;
  storePath: string;
  engine: Engine;
  model: string;
  busy: Set<string>;
  turns: Map<string, TurnState>;
  /** Clients following a bot's running turn, each told every event as it is stored. */
  followers: Map<string, Set<(event: TurnEvent) => void>>;
  whenIdle(botId: string): Promise<void>;
  release(botId: string): void;
  stopping(): boolean;
  /** The Chrome every bot's `browser` command shares. */
  browser: BrowserHost;
  /** Where the schedule CLI finds the daemon, and which token belongs to which bot. */
  access: { url: string; tokens: Map<string, string> };
  /** The scheduler, available once the daemon is listening. */
  scheduler(): Scheduler;
};

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  handler: Handler,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter((part) => part !== "");
  if (parts[0] === "agent" && parts[1] === "schedules") {
    await handleAgentSchedules(req, res, handler, parts.slice(2));
    return;
  }
  if (parts[0] === "agent" && parts[1] === "browser") {
    await handleAgentBrowser(req, res, handler, parts.slice(2));
    return;
  }
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
  if (parts.length === 3 && parts[2] === "events") {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Use GET." });
      return;
    }
    followTurn(res, handler, botId, url.searchParams.get("from"));
    return;
  }
  sendJson(res, 404, { error: "Unknown route." });
}

/**
 * Lets a client that left come back to a turn: the reply so far, then each
 * new update as it arrives, ending with how the turn finished.
 * `from` is where to start in the transcript, defaulting to the running
 * turn's reply. With nothing to replay and no turn running, the answer is 204.
 */
function followTurn(
  res: ServerResponse,
  handler: Handler,
  botId: string,
  fromParam: string | null,
): void {
  const thread = botConversation(handler.store, botId);
  const turn = handler.turns.get(botId) ?? { status: "idle" };
  const from = fromParam === null ? undefined : Number(fromParam);
  if (from !== undefined && (!Number.isInteger(from) || from < 0)) {
    throw new HttpError(400, "The request's from must be a whole number.");
  }
  // Reading the stored reply and joining the live one happen in one tick,
  // so no update can land between them.
  const updates = handler.store.getThread(thread.id).updates;
  const start =
    from ?? (turn.status === "running" ? turn.replyFrom : updates.length);
  const ending = turnEnding(turn);
  if (turn.status !== "running" && (start >= updates.length || !ending)) {
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(200, sseHeaders);
  for (const update of updates.slice(start)) {
    writeEvent(res, { event: "update", data: update });
  }
  if (ending) {
    writeEvent(res, ending);
    res.end();
    return;
  }
  const listeners = handler.followers.get(botId) ?? new Set();
  handler.followers.set(botId, listeners);
  const listener = (event: TurnEvent) => {
    writeEvent(res, event);
    if (event.event !== "update") {
      listeners.delete(listener);
      res.end();
    }
  };
  listeners.add(listener);
  res.on("close", () => {
    listeners.delete(listener);
  });
}

/** The closing event for a turn that has ended, or undefined while it runs or before any. */
function turnEnding(turn: TurnState): TurnEvent | undefined {
  switch (turn.status) {
    case "idle":
    case "running":
      return undefined;
    case "finished":
      return { event: "done", data: { stopReason: turn.stopReason } };
    case "failed":
      return { event: "error", data: { error: turn.error } };
    default: {
      const unexpected: never = turn;
      throw new Error(`Unexpected turn ${JSON.stringify(unexpected)}.`);
    }
  }
}

/**
 * Lets a bot's `schedule` CLI reach the daemon as that bot.
 * The address and a secret token go into a file in the bot's folder, which is
 * where the CLI looks. The daemon remembers which bot owns the token, so the
 * CLI never says who it is. A restart issues new tokens and rewrites the files.
 */
function grantScheduleAccess(handler: Handler, botId: string): void {
  let token = [...handler.access.tokens].find(
    ([, owner]) => owner === botId,
  )?.[0];
  if (token === undefined) {
    token = randomBytes(24).toString("hex");
    handler.access.tokens.set(token, botId);
  }
  const folder = join(botConversation(handler.store, botId).cwd, ".companion");
  mkdirSync(folder, { recursive: true });
  const access: ScheduleAccess = { url: handler.access.url, token };
  writeFileSync(
    join(folder, "schedule.json"),
    `${JSON.stringify(access, null, 2)}\n`,
    { mode: 0o600 },
  );
}

/** The bot a bearer token was issued to, or undefined when it was not issued. */
function tokenBot(req: IncomingMessage, handler: Handler): string | undefined {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ")
    ? handler.access.tokens.get(header.slice("Bearer ".length).trim())
    : undefined;
}

/**
 * The routes behind the `browser` CLI. `POST /agent/browser` starts the shared
 * Chrome if needed and tells the calling bot where it listens and what its
 * session is called. `POST /agent/browser/window` opens that bot a window.
 */
async function handleAgentBrowser(
  req: IncomingMessage,
  res: ServerResponse,
  handler: Handler,
  rest: string[],
): Promise<void> {
  const botId = tokenBot(req, handler);
  if (botId === undefined) {
    sendJson(res, 401, { error: "Unknown or missing token." });
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Use POST." });
    return;
  }
  const browserFailed = (error: unknown) =>
    new HttpError(
      503,
      `The browser could not start: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  if (rest.length === 0) {
    let endpoint;
    try {
      endpoint = await handler.browser.endpoint();
    } catch (error) {
      throw browserFailed(error);
    }
    const lease: BrowserLease = {
      ...endpoint,
      session: `bot-${botId.replace(/[^A-Za-z0-9-]/g, "-")}`,
    };
    sendJson(res, 200, lease);
    return;
  }
  if (rest.length === 1 && rest[0] === "window") {
    try {
      sendJson(res, 200, { targetId: await handler.browser.openWindow() });
    } catch (error) {
      throw browserFailed(error);
    }
    return;
  }
  sendJson(res, 404, { error: "Unknown route." });
}

/**
 * The routes behind the `schedule` CLI: list, create, pause, resume, delete.
 * The bot is the one the bearer token belongs to. A schedule that is missing
 * and one that belongs to another bot look the same, so ids do not leak.
 */
async function handleAgentSchedules(
  req: IncomingMessage,
  res: ServerResponse,
  handler: Handler,
  rest: string[],
): Promise<void> {
  const botId = tokenBot(req, handler);
  if (botId === undefined) {
    sendJson(res, 401, { error: "Unknown or missing schedule token." });
    return;
  }
  const scheduler = handler.scheduler();

  if (rest.length === 0) {
    if (req.method === "GET") {
      sendJson(
        res,
        200,
        scheduler.list(botId).map((schedule) => listing(handler, schedule)),
      );
      return;
    }
    if (req.method === "POST") {
      const body = await readObject(req);
      // The bot and the id are the daemon's to choose, whatever the body says.
      const input: Record<string, unknown> = {
        ...body,
        botId,
        id: randomUUID(),
      };
      if (input.kind === "interval" && input.anchorAt === undefined) {
        input.anchorAt = Date.now();
      }
      if (
        input.kind === "once" &&
        typeof input.at === "number" &&
        input.at <= Date.now()
      ) {
        throw new HttpError(400, "A one-time schedule must be in the future.");
      }
      let schedule: Schedule;
      try {
        schedule = scheduler.create(input);
      } catch (error) {
        throw new HttpError(
          400,
          error instanceof Error ? error.message : "The schedule is invalid.",
        );
      }
      sendJson(res, 201, listing(handler, schedule));
      return;
    }
    sendJson(res, 405, { error: "Use GET or POST." });
    return;
  }

  const id = decodeId(rest[0]);
  const schedule = ownedSchedule(handler, botId, id);
  if (rest.length === 1) {
    if (req.method !== "DELETE") {
      sendJson(res, 405, { error: "Use DELETE." });
      return;
    }
    scheduler.delete(schedule.id);
    sendJson(res, 200, { deleted: schedule.id });
    return;
  }
  const action = rest[1];
  if (rest.length === 2 && (action === "pause" || action === "resume")) {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Use POST." });
      return;
    }
    if (action === "pause") scheduler.pause(schedule.id);
    else scheduler.resume(schedule.id);
    sendJson(res, 200, listing(handler, schedule));
    return;
  }
  sendJson(res, 404, { error: "Unknown route." });
}

function decodeId(raw: string | undefined): string {
  try {
    return decodeURIComponent(raw ?? "");
  } catch {
    return raw ?? "";
  }
}

function ownedSchedule(handler: Handler, botId: string, id: string): Schedule {
  if (handler.store.hasSchedule(id)) {
    const schedule = handler.store.getSchedule(id);
    if (schedule.botId === botId) return schedule;
  }
  throw new HttpError(404, `Unknown schedule ${id}.`);
}

/** A schedule with its pause state and its next and last run, for the CLI. */
function listing(handler: Handler, schedule: Schedule): ScheduleListing {
  const paused = handler.store.isSchedulePaused(schedule.id);
  const next = paused ? null : nextRun(schedule, Date.now());
  const last = handler.store.latestReceipt(schedule.id);
  return {
    ...schedule,
    paused,
    nextRunAt: next === null ? null : new Date(next).toISOString(),
    lastRunAt: last === null ? null : new Date(last).toISOString(),
  };
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
  grantScheduleAccess(handler, bot.id);
  switch (engine) {
    case engines.opencode:
      await runTurn(
        handler,
        bot.id,
        openingPrompt(name, description),
        [],
        () => {},
        "hide",
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
  const images = attachedImages(body.images);
  let started = false;
  // A closed connection is the client leaving. It is not a failed turn.
  let detached = false;
  const detach = () => {
    detached = true;
  };
  res.on("close", detach);
  res.on("error", detach);
  const send = (event: TurnEvent) => {
    if (detached) return;
    if (!started) {
      started = true;
      res.writeHead(200, sseHeaders);
    }
    writeEvent(res, event);
  };
  try {
    const stopReason = await runTurn(
      handler,
      botId,
      text,
      images,
      (update) => {
        send({ event: "update", data: update });
      },
      "keep",
    );
    send({ event: "done", data: { stopReason } });
    res.end();
  } catch (error) {
    if (detached) return;
    const message = httpStatus(error).message;
    if (!started) {
      sendJson(res, httpStatus(error).status, { error: message });
      return;
    }
    send({ event: "error", data: { error: message } });
    res.end();
  }
}

/**
 * Runs one turn and stores each update before the caller sees it.
 * Records the turn as running, then finished or failed, so a later read can
 * say what happened after the client has gone. The busy set is taken before
 * any wait, so two turns of one bot cannot overlap and two bots can.
 * `said` keeps the message in the transcript as the person wrote it, so a chat
 * shows it again later. The opening prompt and a schedule's prompt are the
 * daemon's own and are not kept.
 */
async function runTurn(
  handler: Handler,
  botId: string,
  text: string,
  images: readonly AttachedImage[],
  onUpdate: (update: acp.SessionUpdate) => void,
  said: "keep" | "hide",
): Promise<acp.StopReason> {
  const bot = handler.store.getBot(botId);
  if (bot.engine !== engines.opencode) {
    throw new HttpError(400, "This daemon only runs OpenCode.");
  }
  if (handler.busy.has(botId)) {
    throw new HttpError(409, "This bot is already working on a turn.");
  }
  handler.busy.add(botId);
  const thread = botConversation(handler.store, botId);
  if (said === "keep") {
    for (const update of userMessage(text, images)) {
      handler.store.appendUpdate(thread.id, update);
    }
  }
  handler.turns.set(botId, {
    status: "running",
    replyFrom: handler.store.countUpdates(thread.id),
  });
  const publish = (event: TurnEvent) => {
    for (const listener of handler.followers.get(botId) ?? []) listener(event);
  };
  // A text-only model is told where the file is. The bytes stay on disk.
  const prompt = modelReadsImages(handler.model)
    ? text
    : delegatePastedImages(thread.cwd, text, images);
  const seen = modelReadsImages(handler.model) ? images : [];
  try {
    const stopReason = await handler.engine.prompt(
      botId,
      prompt,
      (update) => {
        handler.store.appendUpdate(thread.id, update);
        onUpdate(update);
        publish({ event: "update", data: update });
      },
      seen,
    );
    handler.turns.set(botId, { status: "finished", stopReason });
    publish({ event: "done", data: { stopReason } });
    return stopReason;
  } catch (error) {
    const message = httpStatus(error).message;
    handler.turns.set(botId, { status: "failed", error: message });
    publish({ event: "error", data: { error: message } });
    throw error;
  } finally {
    handler.release(botId);
  }
}

/** The person's message as ACP user chunks: the text, then each image. */
function userMessage(
  text: string,
  images: readonly AttachedImage[],
): acp.SessionUpdate[] {
  return [
    { sessionUpdate: "user_message_chunk", content: { type: "text", text } },
    ...images.map((image): acp.SessionUpdate => ({
      sessionUpdate: "user_message_chunk",
      content: { type: "image", mimeType: image.mimeType, data: image.data },
    })),
  ];
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
      return await runTurn(
        handler,
        botId,
        text,
        [],
        () => {
          // The update is already stored. A schedule has no open response.
        },
        "hide",
      );
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
    message.startsWith("A message needs") ||
    message.startsWith("A description must") ||
    message.startsWith("An image")
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
      if (size > 8_000_000) {
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

/**
 * Images on a message, if the caller sent any.
 * Each one is checked here so a bad file is a 400 before a turn starts.
 */
function attachedImages(value: unknown): AttachedImage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new HttpError(400, "An image must be listed.");
  return value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new HttpError(400, "An image must be an object.");
    }
    const mimeType = (item as { mimeType?: unknown }).mimeType;
    const data = (item as { data?: unknown }).data;
    if (typeof mimeType !== "string" || typeof data !== "string") {
      throw new HttpError(400, "An image needs a type and base64 data.");
    }
    if (!isImageMime(mimeType)) {
      throw new HttpError(
        400,
        "An image needs a png, jpeg, gif, or webp type.",
      );
    }
    try {
      imageBytes({ mimeType, data });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "An image is not valid.";
      throw new HttpError(400, message);
    }
    return { mimeType, data };
  });
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
