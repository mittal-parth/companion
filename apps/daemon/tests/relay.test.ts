/**
 * Proves the whole path a cloud chat takes: web request, relay, tunnel, real
 * daemon. A turn is started through the relay, the caller leaves, the relay
 * itself is restarted, and the reply is then read in full after the daemon's
 * tunnel reconnects, with every event present once. The engine is scripted, so
 * no model runs.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { parseTurnEvents, type BotView } from "@companion/shared";
import { signToken } from "@companion/shared/tunnel";
import { expect, test } from "vitest";
import { startRelay } from "../../relay/src/relay.js";
import { startDaemon } from "../src/api.js";
import type { Engine } from "../src/engine.js";
import { startTunnel } from "../src/tunnel.js";

const secret = "s".repeat(40);

/** A request as the web server makes it: a token naming the VM, nothing else. */
const viaRelay = (port: number, path: string, init?: RequestInit) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      authorization: `Bearer ${signToken(
        { role: "web", vm: "vm-1", exp: Math.floor(Date.now() / 1000) + 60 },
        secret,
      )}`,
    },
  });

const until = async (check: () => boolean, ms = 15_000) => {
  for (let i = 0; i < ms / 20 && !check(); i++)
    await new Promise((r) => setTimeout(r, 20));
  expect(check()).toBe(true);
};

test("a turn survives the caller leaving and the relay restarting, and its events replay in full", async () => {
  const text = (t: string): acp.SessionUpdate => ({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: t },
  });
  let release: () => void = () => {};
  const hold = new Promise<void>((r) => (release = r));
  let started: () => void = () => {};
  const running = new Promise<void>((r) => (started = r));
  const engine: Engine = {
    async prompt(_botId, prompt, onUpdate) {
      if (prompt.startsWith("Your name is")) return "end_turn";
      onUpdate(text("before"));
      started();
      await hold;
      onUpdate(text("after"));
      return "end_turn";
    },
    async close() {},
  };
  const directory = mkdtempSync(join(tmpdir(), "companion-relay-"));
  const daemon = await startDaemon({
    storePath: join(directory, "threads.db"),
    engine,
  });
  let relay = await startRelay({ secret });
  const port = relay.port;
  const tunnel = startTunnel({
    relayUrl: `ws://127.0.0.1:${port}`,
    token: () =>
      signToken(
        { role: "vm", vm: "vm-1", exp: Math.floor(Date.now() / 1000) + 600 },
        secret,
      ),
    target: daemon.url,
  });
  try {
    await until(() => relay.vms().includes("vm-1"));

    const created = await viaRelay(port, "/bots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Relay" }),
    });
    expect(created.status).toBe(201);
    const bot = (await created.json()) as BotView;

    const controller = new AbortController();
    const sent = viaRelay(port, `/bots/${bot.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "go" }),
      signal: controller.signal,
    }).catch(() => undefined);
    await running;
    controller.abort();
    await sent;

    // The relay goes away mid-turn, as in a deploy, and comes back on its port.
    await relay.close();
    release();
    relay = await startRelay({ secret, port });
    await until(() => relay.vms().includes("vm-1"));

    const replay = await viaRelay(port, `/bots/${bot.id}/events?from=1`);
    expect(replay.status).toBe(200);
    expect(parseTurnEvents(await replay.text())).toEqual([
      { event: "update", data: text("before") },
      { event: "update", data: text("after") },
      { event: "done", data: { stopReason: "end_turn" } },
    ]);
  } finally {
    release();
    tunnel.close();
    await relay.close();
    await daemon.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
