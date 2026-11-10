/**
 * Proves the local API creates a bot as one conversation and streams a turn.
 * The real OpenCode turn lives in api.live.test.ts.
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type {
  AttachedImage,
  BotView,
  ScheduleAccess,
  TurnEvent,
} from "@companion/shared";
import { expect, test } from "vitest";
import { startDaemon, openingPrompt, type Daemon } from "./api.js";
import { defaultOpencodeModel, visionOpencodeModel } from "./engine.js";
import type { Engine } from "./engine.js";

const hello: acp.SessionUpdate = {
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text: "hello" },
};

test("creating a bot starts its one conversation", async () => {
  await withDaemon(
    scripted([{ updates: [hello], stopReason: "end_turn" }]),
    async (daemon) => {
      const created = await postJson(daemon, "/bots", { name: "  Content  " });
      expect(created.status).toBe(201);
      const bot = (await created.json()) as BotView;
      expect(bot.name).toBe("Content");
      expect(bot.engine).toBe("opencode");
      expect(existsSync(join(bot.directory, "AGENTS.md"))).toBe(false);
      expect(existsSync(join(bot.directory, "MEMORY.md"))).toBe(false);
      const config = JSON.parse(
        readFileSync(join(bot.directory, "opencode.json"), "utf8"),
      ) as {
        model: string;
        providers: {
          sarvam: {
            package: string;
            env: string[];
            settings: { baseURL: string };
            headers: { "api-subscription-key": string };
            models: { "glm5.3": { capabilities: { tools: boolean } } };
          };
        };
      };
      expect(config.model).toBe(defaultOpencodeModel);
      expect(config.providers.sarvam).toMatchObject({
        package: "@opencode/ai/providers/openai-compatible",
        env: ["SARVAM_API_KEY"],
        settings: { baseURL: "https://api.sarvam.ai/v2" },
        headers: { "api-subscription-key": "{env:SARVAM_API_KEY}" },
        models: { "glm5.3": { capabilities: { tools: true } } },
      });
      const key = process.env.SARVAM_API_KEY;
      if (key !== undefined && key.length >= 16) {
        expect(JSON.stringify(config)).not.toContain(key);
      }

      const listed = await fetch(`${daemon.url}/bots`);
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual([bot]);

      const read = await fetch(`${daemon.url}/bots/${bot.id}`);
      expect(await read.json()).toEqual({ ...bot, updates: [hello] });
    },
  );
});

test("a message streams session updates and stores them", async () => {
  const second: acp.SessionUpdate = {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "again" },
  };
  await withDaemon(
    scripted([
      { updates: [], stopReason: "end_turn" },
      { updates: [hello], stopReason: "end_turn" },
      { updates: [second], stopReason: "end_turn" },
    ]),
    async (daemon) => {
      const bot = await createBot(daemon, "Content");
      const first = await readTurn(daemon, bot.id, "Say hello");
      const next = await readTurn(daemon, bot.id, "Say it again");
      expect(first).toEqual([
        { event: "update", data: hello },
        { event: "done", data: { stopReason: "end_turn" } },
      ]);
      expect(next.at(-1)).toEqual({
        event: "done",
        data: { stopReason: "end_turn" },
      });

      const stored = await fetch(`${daemon.url}/bots/${bot.id}`);
      expect(await stored.json()).toMatchObject({ updates: [hello, second] });
    },
  );
});

test("a second message is refused while a turn is running", async () => {
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => {};
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const engine: Engine = {
    async prompt(_botId, text, onUpdate) {
      if (text.startsWith("Your name is")) {
        onUpdate(hello);
        return "end_turn";
      }
      started();
      await hold;
      onUpdate(hello);
      return "end_turn";
    },
    async close() {},
  };
  let first: Promise<Response> | undefined;
  await withDaemon(engine, async (daemon) => {
    try {
      const bot = await createBot(daemon, "Content");
      first = postJson(daemon, `/bots/${bot.id}/messages`, { text: "first" });
      await running;
      const second = await postJson(daemon, `/bots/${bot.id}/messages`, {
        text: "second",
      });
      expect(second.status).toBe(409);
      expect(await second.json()).toEqual({
        error: "This bot is already working on a turn.",
      });
      release();
      const finished = await first;
      expect(finished.status).toBe(200);
    } finally {
      release();
      await first?.catch(() => undefined);
    }
  });
});

test("bad requests name what was wrong", async () => {
  await withDaemon(scripted([]), async (daemon) => {
    const missing = await postJson(daemon, "/bots", {});
    expect(missing.status).toBe(400);
    const unknownEngine = await postJson(daemon, "/bots", {
      name: "Content",
      engine: "nope",
    });
    expect(unknownEngine.status).toBe(400);
    const badDescription = await postJson(daemon, "/bots", {
      name: "Content",
      description: 4,
    });
    expect(badDescription.status).toBe(400);
    const claude = await postJson(daemon, "/bots", {
      name: "Content",
      engine: "claude",
    });
    expect(claude.status).toBe(201);
    const claudeBot = (await claude.json()) as BotView;
    const refused = await postJson(daemon, `/bots/${claudeBot.id}/messages`, {
      text: "hello",
    });
    expect(refused.status).toBe(400);

    const absent = await fetch(`${daemon.url}/bots/missing`);
    expect(absent.status).toBe(404);
    const empty = await postJson(daemon, `/bots/${claudeBot.id}/messages`, {
      text: "  ",
    });
    expect(empty.status).toBe(400);
    const broken = await fetch(`${daemon.url}/bots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(broken.status).toBe(400);
    const missingRoute = await fetch(`${daemon.url}/threads`);
    expect(missingRoute.status).toBe(404);
  });
});

test("an engine failure is reported on the response", async () => {
  let calls = 0;
  const engine: Engine = {
    async prompt(_botId, _text, onUpdate) {
      calls += 1;
      if (calls === 1) return "end_turn";
      if (calls === 2) throw new Error("OpenCode exploded.");
      onUpdate(hello);
      throw new Error("OpenCode stopped.");
    },
    async close() {},
  };
  await withDaemon(engine, async (daemon) => {
    const bot = await createBot(daemon, "Content");
    const early = await postJson(daemon, `/bots/${bot.id}/messages`, {
      text: "hello",
    });
    expect(early.status).toBe(500);
    expect(await early.json()).toEqual({ error: "OpenCode exploded." });

    const streamed = await readTurn(daemon, bot.id, "hello");
    expect(streamed).toEqual([
      { event: "update", data: hello },
      { event: "error", data: { error: "OpenCode stopped." } },
    ]);
    const stored = await fetch(`${daemon.url}/bots/${bot.id}`);
    expect(await stored.json()).toMatchObject({ updates: [hello] });
  });
});

test("a failed opening turn is an error and the bot remains", async () => {
  const engine: Engine = {
    async prompt() {
      throw new Error("OpenCode exploded.");
    },
    async close() {},
  };
  await withDaemon(engine, async (daemon) => {
    const created = await postJson(daemon, "/bots", { name: "Content" });
    expect(created.status).toBe(500);
    expect(await created.json()).toEqual({ error: "OpenCode exploded." });
    const listed = (await (
      await fetch(`${daemon.url}/bots`)
    ).json()) as BotView[];
    expect(listed).toHaveLength(1);
    const bot = listed[0];
    expect(bot).toBeDefined();
    const read = await fetch(`${daemon.url}/bots/${bot?.id}`);
    expect(await read.json()).toMatchObject({ updates: [] });
  });
});

test("two bots keep separate folders and opening turns", async () => {
  const prompts: string[] = [];
  const engine: Engine = {
    async prompt(_botId, text, onUpdate) {
      prompts.push(text);
      onUpdate(hello);
      return "end_turn";
    },
    async close() {},
  };
  await withDaemon(engine, async (daemon) => {
    const ada = await createBot(daemon, "Ada", "Keep the word marigold.");
    const bea = await createBot(daemon, "Bea");
    const blank = await createBot(daemon, "Cleo", "   ");
    expect(ada.directory).not.toBe(bea.directory);
    expect(existsSync(join(ada.directory, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(ada.directory, "MEMORY.md"))).toBe(false);
    expect(existsSync(join(bea.directory, "AGENTS.md"))).toBe(false);
    expect(prompts).toEqual([
      openingPrompt("Ada", "Keep the word marigold."),
      openingPrompt("Bea"),
      openingPrompt("Cleo"),
    ]);
    const stored = await fetch(`${daemon.url}/bots/${ada.id}`);
    expect(await stored.json()).toMatchObject({ updates: [hello] });
    expect(blank.name).toBe("Cleo");
  });
});

test("two bots can take a turn at the same time", async () => {
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let waiting = 0;
  let bothWaiting: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    bothWaiting = resolve;
  });
  const engine: Engine = {
    async prompt(botId, text, onUpdate) {
      if (text.startsWith("Your name is")) return "end_turn";
      waiting += 1;
      if (waiting === 2) bothWaiting();
      await hold;
      onUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: botId },
      });
      return "end_turn";
    },
    async close() {},
  };
  let first: Promise<TurnEvent[]> | undefined;
  let second: Promise<TurnEvent[]> | undefined;
  await withDaemon(engine, async (daemon) => {
    try {
      const ada = await createBot(daemon, "Ada");
      const bea = await createBot(daemon, "Bea");
      first = readTurn(daemon, ada.id, "work on ada");
      second = readTurn(daemon, bea.id, "work on bea");
      await ready;
      release();
      const [adaTurn, beaTurn] = await Promise.all([first, second]);
      expect(adaTurn).toEqual([
        {
          event: "update",
          data: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: ada.id },
          },
        },
        { event: "done", data: { stopReason: "end_turn" } },
      ]);
      expect(beaTurn[0]).toMatchObject({
        event: "update",
        data: { content: { text: bea.id } },
      });
    } finally {
      release();
      await first?.catch(() => undefined);
      await second?.catch(() => undefined);
    }
  });
});

test("a bot gets a schedule token before its opening turn", async () => {
  const seen: string[] = [];
  const engine: Engine = {
    async prompt() {
      seen.push("turn");
      return "end_turn";
    },
    async close() {},
  };
  const directory = mkdtempSync(join(tmpdir(), "companion-api-"));
  const storePath = join(directory, "threads.db");
  let daemon = await startDaemon({ storePath, engine });
  try {
    const bot = await createBot(daemon, "Ada");
    expect(seen).toEqual(["turn"]);
    const first = readAccess(bot.directory);
    expect(first.url).toBe(daemon.url);
    expect(first.token).not.toBe("");
    const denied = await fetch(`${daemon.url}/agent/schedules`);
    expect(denied.status).toBe(401);
    const forged = await fetch(`${daemon.url}/agent/schedules`, {
      headers: { authorization: "Bearer nope" },
    });
    expect(forged.status).toBe(401);
    const claimed = await fetch(`${daemon.url}/agent/schedules`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${first.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        botId: "someone-else",
        id: "chosen-by-the-caller",
        kind: "once",
        prompt: "Check",
        at: Date.now() + 3_600_000,
      }),
    });
    expect(claimed.status).toBe(201);
    const schedule = (await claimed.json()) as { id: string; botId: string };
    expect(schedule.botId).toBe(bot.id);
    expect(schedule.id).not.toBe("chosen-by-the-caller");
    await daemon.close();

    daemon = await startDaemon({ storePath, engine });
    const next = readAccess(bot.directory);
    expect(next.token).not.toBe(first.token);
    expect(next.url).toBe(daemon.url);
    const stale = await fetch(`${daemon.url}/agent/schedules`, {
      headers: { authorization: `Bearer ${first.token}` },
    });
    expect(stale.status).toBe(401);
    const fresh = await fetch(`${daemon.url}/agent/schedules`, {
      headers: { authorization: `Bearer ${next.token}` },
    });
    expect(fresh.status).toBe(200);
    const listed = (await fresh.json()) as Array<{ id: string }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(schedule.id);
    writeFileSync(join(directory, ".keep"), "");
  } finally {
    await daemon.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

const pixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("a pasted image stays out of the text model's prompt", async () => {
  const seen: Array<{ text: string; images?: readonly AttachedImage[] }> = [];
  const engine: Engine = {
    async prompt(_botId, text, _onUpdate, images) {
      seen.push({ text, images });
      return "end_turn";
    },
    async close() {},
  };
  await withDaemon(engine, async (daemon) => {
    const bot = await createBot(daemon, "Look");
    const response = await postJson(daemon, `/bots/${bot.id}/messages`, {
      text: "What is this?",
      images: [{ mimeType: "image/png", data: pixel }],
    });
    expect(response.status).toBe(200);
    const turn = seen.find((item) => item.text.includes("What is this?"));
    expect(turn?.text).toContain("vision subagent");
    expect(turn?.text).not.toContain(pixel);
    expect(turn?.images ?? []).toHaveLength(0);
    expect(readdirSync(join(bot.directory, "images"))).toHaveLength(1);
  });
});

test("a model that can see is given the image bytes", async () => {
  const seen: Array<{ text: string; images?: readonly AttachedImage[] }> = [];
  const engine: Engine = {
    async prompt(_botId, text, _onUpdate, images) {
      seen.push({ text, images });
      return "end_turn";
    },
    async close() {},
  };
  const directory = mkdtempSync(join(tmpdir(), "companion-see-"));
  const daemon = await startDaemon({
    storePath: join(directory, "threads.db"),
    engine,
    model: visionOpencodeModel,
  });
  try {
    const bot = await createBot(daemon, "Look");
    const response = await postJson(daemon, `/bots/${bot.id}/messages`, {
      text: "What is this?",
      images: [{ mimeType: "image/png", data: pixel }],
    });
    expect(response.status).toBe(200);
    const turn = seen.find((item) => item.text === "What is this?");
    expect(turn?.images).toEqual([{ mimeType: "image/png", data: pixel }]);
    expect(existsSync(join(bot.directory, "images"))).toBe(false);
  } finally {
    await daemon.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an image of the wrong type is refused before a turn", async () => {
  await withDaemon(
    scripted([{ updates: [], stopReason: "end_turn" }]),
    async (daemon) => {
      const bot = await createBot(daemon, "Look");
      const response = await postJson(daemon, `/bots/${bot.id}/messages`, {
        text: "What is this?",
        images: [{ mimeType: "image/jpeg", data: pixel }],
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "An image's bytes do not match its type.",
      });
    },
  );
});

function readAccess(directory: string): ScheduleAccess {
  return JSON.parse(
    readFileSync(join(directory, ".companion", "schedule.json"), "utf8"),
  ) as ScheduleAccess;
}

function scripted(
  turns: Array<{ updates: acp.SessionUpdate[]; stopReason: acp.StopReason }>,
): Engine {
  let index = 0;
  return {
    async prompt(_botId, _text, onUpdate) {
      const turn = turns[index];
      index += 1;
      if (turn === undefined) throw new Error("No scripted turn.");
      for (const update of turn.updates) onUpdate(update);
      return turn.stopReason;
    },
    async close() {},
  };
}

async function withDaemon(
  engine: Engine,
  run: (daemon: Daemon) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "companion-api-"));
  const daemon = await startDaemon({
    storePath: join(directory, "threads.db"),
    engine,
  });
  try {
    await run(daemon);
  } finally {
    await daemon.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function createBot(
  daemon: Daemon,
  name: string,
  description?: string,
): Promise<BotView> {
  const response = await postJson(daemon, "/bots", { name, description });
  expect(response.status).toBe(201);
  return (await response.json()) as BotView;
}

async function readTurn(
  daemon: Daemon,
  botId: string,
  text: string,
): Promise<TurnEvent[]> {
  const response = await postJson(daemon, `/bots/${botId}/messages`, { text });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  return parseEvents(await response.text());
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
    events.push(turnEvent(name, payload));
  }
  return events;
}

function turnEvent(name: string, data: unknown): TurnEvent {
  switch (name) {
    case "update":
      return { event: "update", data: data as acp.SessionUpdate };
    case "done":
      return {
        event: "done",
        data: data as { stopReason: acp.StopReason },
      };
    case "error":
      return { event: "error", data: data as { error: string } };
    default:
      throw new Error(`Unexpected event ${name}.`);
  }
}
