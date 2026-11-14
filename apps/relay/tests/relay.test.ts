/**
 * Proves the relay lets only the right caller reach a VM, carries a request
 * and its streamed answer, and reacts to either side leaving. VMs are bare
 * websocket clients here, so it speaks the tunnel frames directly.
 */
import {
  encodeFrame,
  parseFrame,
  signToken,
  type TunnelFrame,
} from "@companion/shared/tunnel";
import { afterEach, expect, test } from "vitest";
import WebSocket from "ws";
import { startRelay } from "../src/relay.js";

const secret = "s".repeat(40);
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const token = (role: "vm" | "web", vm: string, exp = 4_000_000_000) =>
  signToken({ role, vm, exp }, secret);

async function relayOnly(pingMs?: number) {
  const relay = await startRelay({ secret, pingMs });
  cleanups.push(() => relay.close());
  return { relay, url: `http://127.0.0.1:${relay.port}` };
}

/** A fake VM: connects with a token and records the frames it is sent. */
async function connectVm(
  port: number,
  vm: string,
  options: { autoPong?: boolean } = {},
) {
  const frames: TunnelFrame[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/vm`, {
    headers: { authorization: `Bearer ${token("vm", vm)}` },
    autoPong: options.autoPong ?? true,
  });
  socket.on("message", (data) => frames.push(parseFrame(data.toString())));
  cleanups.push(() => socket.terminate());
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, frames };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++)
    await new Promise((r) => setTimeout(r, 20));
  expect(check()).toBe(true);
};

const asWeb = (vm: string) => ({ authorization: `Bearer ${token("web", vm)}` });

test("the health check needs no token", async () => {
  const { url } = await relayOnly();
  const response = await fetch(`${url}/health`);
  expect(response.status).toBe(200);
});

test("a request with no token, a vm token, or an expired token is refused", async () => {
  const { url } = await relayOnly();
  expect((await fetch(`${url}/bots`)).status).toBe(401);
  const asVm = { authorization: `Bearer ${token("vm", "vm-1")}` };
  expect((await fetch(`${url}/bots`, { headers: asVm })).status).toBe(401);
  const expired = { authorization: `Bearer ${token("web", "vm-1", 1)}` };
  expect((await fetch(`${url}/bots`, { headers: expired })).status).toBe(401);
});

test("a daemon without a valid vm token cannot connect", async () => {
  const { relay } = await relayOnly();
  for (const authorization of [
    undefined,
    `Bearer ${token("web", "vm-1")}`,
    "Bearer nope",
  ]) {
    const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/vm`, {
      headers: authorization === undefined ? {} : { authorization },
    });
    const outcome = await new Promise<string>((resolve) => {
      socket.once("open", () => resolve("open"));
      socket.once("error", () => resolve("refused"));
    });
    expect(outcome).toBe("refused");
  }
  expect(relay.vms()).toEqual([]);
});

test("a request for a VM that is not connected is a 503", async () => {
  const { url } = await relayOnly();
  const response = await fetch(`${url}/bots`, { headers: asWeb("vm-1") });
  expect(response.status).toBe(503);
});

test("a request reaches its VM and the streamed answer comes back", async () => {
  const { relay, url } = await relayOnly();
  const vm = await connectVm(relay.port, "vm-1");
  const pending = fetch(`${url}/bots/x/messages?from=1`, {
    method: "POST",
    headers: { ...asWeb("vm-1"), "content-type": "application/json" },
    body: '{"text":"hi"}',
  });
  await until(() => vm.frames.length === 1);
  const request = vm.frames[0];
  if (request?.type !== "request") throw new Error("expected a request");
  expect(request.method).toBe("POST");
  expect(request.path).toBe("/bots/x/messages?from=1");
  expect(Buffer.from(request.body ?? "", "base64").toString()).toBe(
    '{"text":"hi"}',
  );
  // The web token is for the relay only and must not reach the daemon.
  expect(request.headers.authorization).toBeUndefined();
  expect(request.headers["content-type"]).toBe("application/json");

  const reply = (frame: TunnelFrame) => vm.socket.send(encodeFrame(frame));
  reply({
    type: "response",
    id: request.id,
    status: 201,
    headers: { "x-a": "b" },
  });
  reply({
    type: "chunk",
    id: request.id,
    data: Buffer.from("he").toString("base64"),
  });
  reply({
    type: "chunk",
    id: request.id,
    data: Buffer.from("llo").toString("base64"),
  });
  reply({ type: "end", id: request.id });
  const response = await pending;
  expect(response.status).toBe(201);
  expect(response.headers.get("x-a")).toBe("b");
  expect(await response.text()).toBe("hello");
});

test("a token for one VM never reaches another VM's connection", async () => {
  const { relay, url } = await relayOnly();
  const one = await connectVm(relay.port, "vm-1");
  const two = await connectVm(relay.port, "vm-2");
  void fetch(`${url}/secret`, { headers: asWeb("vm-2") }).catch(() => {});
  await until(() => two.frames.length === 1);
  expect(one.frames).toEqual([]);
});

test("a caller that goes away cancels its request on the VM", async () => {
  const { relay, url } = await relayOnly();
  const vm = await connectVm(relay.port, "vm-1");
  const controller = new AbortController();
  const pending = fetch(`${url}/stream`, {
    headers: asWeb("vm-1"),
    signal: controller.signal,
  }).catch(() => {});
  await until(() => vm.frames.length === 1);
  const id = vm.frames[0]?.id;
  controller.abort();
  await pending;
  await until(() => vm.frames.some((f) => f.type === "cancel" && f.id === id));
});

test("a VM that drops before answering gives the caller a 502", async () => {
  const { relay, url } = await relayOnly();
  const vm = await connectVm(relay.port, "vm-1");
  const pending = fetch(`${url}/bots`, { headers: asWeb("vm-1") });
  await until(() => vm.frames.length === 1);
  vm.socket.terminate();
  expect((await pending).status).toBe(502);
});

test("a VM that drops mid-stream ends the caller's stream with an error", async () => {
  const { relay, url } = await relayOnly();
  const vm = await connectVm(relay.port, "vm-1");
  const pending = fetch(`${url}/stream`, { headers: asWeb("vm-1") });
  await until(() => vm.frames.length === 1);
  const id = vm.frames[0]?.id ?? "";
  vm.socket.send(
    encodeFrame({ type: "response", id, status: 200, headers: {} }),
  );
  vm.socket.send(
    encodeFrame({
      type: "chunk",
      id,
      data: Buffer.from("a").toString("base64"),
    }),
  );
  const response = await pending;
  const reader = response.body?.getReader();
  await reader?.read();
  vm.socket.terminate();
  await expect(
    (async () => {
      for (;;) if ((await reader?.read())?.done) return;
    })(),
  ).rejects.toThrow();
});

test("a second connection for the same VM replaces the first", async () => {
  const { relay, url } = await relayOnly();
  const first = await connectVm(relay.port, "vm-1");
  const closed = new Promise((r) => first.socket.once("close", r));
  const second = await connectVm(relay.port, "vm-1");
  await closed;
  expect(relay.vms()).toEqual(["vm-1"]);
  void fetch(`${url}/x`, { headers: asWeb("vm-1") }).catch(() => {});
  await until(() => second.frames.length === 1);
});

test("a VM that stops answering pings is dropped", async () => {
  const { relay } = await relayOnly(50);
  await connectVm(relay.port, "vm-1", { autoPong: false });
  await until(() => relay.vms().length === 0);
});
