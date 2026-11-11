/**
 * Test helpers. Shared pieces of the live tests that talk to a real bot: finding OpenCode,
 * creating a bot, and sending a message and reading the reply it streams.
 */
import { spawnSync } from "node:child_process";
import type * as acp from "@agentclientprotocol/sdk";
import { parseTurnEvents, type BotView } from "@companion/shared";
import { expect } from "vitest";
import type { Daemon } from "../src/api.js";

export const opencodeBin = process.env.OPENCODE_BIN ?? "opencode";

/** Fails fast with a clear message when OpenCode is not installed. */
export function requireOpencode(): void {
  if (
    spawnSync(opencodeBin, ["--version"], { encoding: "utf8" }).status !== 0
  ) {
    throw new Error(`A live test needs ${opencodeBin}, and it did not start.`);
  }
}

/** Creates a bot through the daemon API. */
export async function createLiveBot(
  daemon: Daemon,
  name: string,
): Promise<BotView> {
  const response = await fetch(`${daemon.url}/bots`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as BotView;
}

/** One turn: the updates the bot streamed and the words of its reply. */
export type LiveTurn = {
  updates: acp.SessionUpdate[];
  reply: string;
  events: unknown[];
};

/**
 * Sends one message and reads the streamed turn.
 * `events` is the raw stream, kept so a failure shows what the bot did.
 */
export async function askBot(
  daemon: Daemon,
  botId: string,
  text: string,
): Promise<LiveTurn> {
  const response = await fetch(`${daemon.url}/bots/${botId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  expect(response.status).toBe(200);
  const events = parseEvents(await response.text());
  const failure = events.find((event) => event.event === "error");
  expect(failure, JSON.stringify(events)).toBeUndefined();
  const updates = events.flatMap((event) =>
    event.event === "update" ? [event.data] : [],
  );
  const reply = updates
    .flatMap((update) =>
      update.sessionUpdate === "agent_message_chunk" &&
      update.content.type === "text"
        ? [update.content.text]
        : [],
    )
    .join("");
  return { updates, reply, events };
}

/** Reads the server-sent events of one streamed turn. */
export const parseEvents = parseTurnEvents;
