/**
 * Proves the local API creates a bot as one conversation and streams a turn.
 * The real OpenCode turn lives in api.live.test.ts.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type { BotView, TurnEvent } from "@companion/shared";
import { expect, test } from "vitest";
import { startDaemon, type Daemon } from "./api.js";
import { defaultOpencodeModel } from "./engine.js";
import type { Engine } from "./engine.js";

const hello: acp.SessionUpdate = {
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text: "hello" },
};

test("creating a bot starts its one conversation", async () => {
  await withDaemon(scripted([]), async (daemon) => {
    const created = await postJson(daemon, "/bots", { name: "  Content  " });
    expect(created.status).toBe(201);
    const bot = (await created.json()) as BotView;
    expect(bot.name).toBe("Content");
    expect(bot.engine).toBe("opencode");
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
    expect(await read.json()).toEqual({ ...bot, updates: [] });
  });
});

test("a message streams session updates and stores them", async () => {
  const second: acp.SessionUpdate = {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "again" },
  };
  await withDaemon(
    scripted([
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
    async prompt(_botId, _text, onUpdate) {
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
      if (calls === 1) throw new Error("OpenCode exploded.");
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

async function createBot(daemon: Daemon, name: string): Promise<BotView> {
  const response = await postJson(daemon, "/bots", { name });
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
