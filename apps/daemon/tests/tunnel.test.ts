/**
 * Proves the daemon's tunnel answers requests the relay sends it, streams
 * long answers, stops on cancel, and reconnects after a drop. The relay is a
 * bare websocket server and the daemon is a plain HTTP server, so nothing here
 * starts an engine.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  encodeFrame,
  parseFrame,
  type TunnelFrame,
} from "@companion/shared/tunnel";
import { afterEach, expect, test } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { startTunnel } from "../src/tunnel.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A relay stand-in: records what connects and the frames each connection sends. */
async function fakeRelay() {
  const connections: Array<{
    socket: WebSocket;
    authorization: string | undefined;
    frames: TunnelFrame[];
  }> = [];
  const server = new WebSocketServer({ port: 0 });
  await new Promise((r) => server.once("listening", r));
  server.on("connection", (socket, request) => {
    const connection = {
      socket,
      authorization: request.headers.authorization,
      frames: [] as TunnelFrame[],
    };
    connections.push(connection);
    socket.on("message", (data) =>
      connection.frames.push(parseFrame(data.toString())),
    );
  });
  cleanups.push(
    () => new Promise<void>((r) => (server.close(), r())),
    () => server.clients.forEach((c) => c.terminate()),
  );
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    connections,
  };
}

/** A daemon stand-in with a quick route, a streaming route and a body echo. */
async function fakeDaemon() {
  const aborted: string[] = [];
  const server: Server = createServer((req, res) => {
    if (req.url === "/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("one\n");
      const timer = setInterval(() => res.write("tick\n"), 20);
      res.on("close", () => {
        clearInterval(timer);
        aborted.push("/stream");
      });
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(req.url === "/missing" ? 404 : 200, { "x-seen": "yes" });
      res.end(`${req.method} ${req.url} ${Buffer.concat(chunks)}`);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    aborted,
  };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++)
    await new Promise((r) => setTimeout(r, 20));
  expect(check()).toBe(true);
};

const text = (frames: TunnelFrame[], id: string) =>
  frames
    .filter((f) => f.type === "chunk" && f.id === id)
    .map((f) => Buffer.from((f as { data: string }).data, "base64").toString())
    .join("");

test("a forwarded request is answered with status, headers and body", async () => {
  const relay = await fakeRelay();
  const daemon = await fakeDaemon();
  cleanups.push(
    startTunnel({ relayUrl: relay.url, token: () => "tok", target: daemon.url })
      .close,
  );
  await until(() => relay.connections.length === 1);
  expect(relay.connections[0]?.authorization).toBe("Bearer tok");

  relay.connections[0]?.socket.send(
    encodeFrame({
      type: "request",
      id: "a",
      method: "POST",
      path: "/bots/x/messages?from=2",
      headers: { "content-type": "application/json", host: "ignored" },
      body: Buffer.from('{"hi":1}').toString("base64"),
    }),
  );
  const frames = relay.connections[0]?.frames ?? [];
  await until(() => frames.some((f) => f.type === "end"));
  expect(frames[0]).toMatchObject({
    type: "response",
    id: "a",
    status: 200,
    headers: { "x-seen": "yes" },
  });
  expect(text(frames, "a")).toBe('POST /bots/x/messages?from=2 {"hi":1}');
});

test("an error status from the daemon is passed through, not turned into a failure", async () => {
  const relay = await fakeRelay();
  const daemon = await fakeDaemon();
  cleanups.push(
    startTunnel({ relayUrl: relay.url, token: () => "t", target: daemon.url })
      .close,
  );
  await until(() => relay.connections.length === 1);
  relay.connections[0]?.socket.send(
    encodeFrame({
      type: "request",
      id: "m",
      method: "GET",
      path: "/missing",
      headers: {},
    }),
  );
  const frames = relay.connections[0]?.frames ?? [];
  await until(() => frames.some((f) => f.type === "end"));
  expect(frames[0]).toMatchObject({ type: "response", status: 404 });
});

test("a daemon that cannot be reached is reported as an error frame", async () => {
  const relay = await fakeRelay();
  cleanups.push(
    startTunnel({
      relayUrl: relay.url,
      token: () => "t",
      target: "http://127.0.0.1:1",
    }).close,
  );
  await until(() => relay.connections.length === 1);
  relay.connections[0]?.socket.send(
    encodeFrame({
      type: "request",
      id: "e",
      method: "GET",
      path: "/",
      headers: {},
    }),
  );
  const frames = relay.connections[0]?.frames ?? [];
  await until(() => frames.some((f) => f.type === "error"));
});

test("a stream keeps flowing until the relay cancels it", async () => {
  const relay = await fakeRelay();
  const daemon = await fakeDaemon();
  cleanups.push(
    startTunnel({ relayUrl: relay.url, token: () => "t", target: daemon.url })
      .close,
  );
  await until(() => relay.connections.length === 1);
  const connection = relay.connections[0]!;
  connection.socket.send(
    encodeFrame({
      type: "request",
      id: "s",
      method: "GET",
      path: "/stream",
      headers: {},
    }),
  );
  await until(() => text(connection.frames, "s").split("tick").length > 3);
  connection.socket.send(encodeFrame({ type: "cancel", id: "s" }));
  await until(() => daemon.aborted.includes("/stream"));
  expect(connection.frames.some((f) => f.type === "end")).toBe(false);
});

test("a dropped connection is opened again, and a stream in flight is released", async () => {
  const relay = await fakeRelay();
  const daemon = await fakeDaemon();
  cleanups.push(
    startTunnel({ relayUrl: relay.url, token: () => "t", target: daemon.url })
      .close,
  );
  await until(() => relay.connections.length === 1);
  relay.connections[0]?.socket.send(
    encodeFrame({
      type: "request",
      id: "s",
      method: "GET",
      path: "/stream",
      headers: {},
    }),
  );
  await until(() => (relay.connections[0]?.frames.length ?? 0) > 1);
  relay.connections[0]?.socket.terminate();
  await until(() => relay.connections.length === 2);
  await until(() => daemon.aborted.includes("/stream"));
});

test("closing the tunnel stops it reconnecting", async () => {
  const relay = await fakeRelay();
  const tunnel = startTunnel({
    relayUrl: relay.url,
    token: () => "t",
    target: "http://127.0.0.1:1",
  });
  await until(() => relay.connections.length === 1);
  tunnel.close();
  await new Promise((r) => setTimeout(r, 1500));
  expect(relay.connections.length).toBe(1);
});
