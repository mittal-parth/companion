/** The tunnel frames and tokens: what is accepted and what is turned away. */
import { expect, test } from "vitest";
import {
  encodeFrame,
  parseFrame,
  signToken,
  stripHopHeaders,
  verifyToken,
} from "./tunnel.js";

test("a frame survives the websocket", () => {
  const frame = {
    type: "request" as const,
    id: "1",
    method: "POST",
    path: "/bots/a/messages",
    headers: { "content-type": "application/json" },
    body: "e30=",
  };
  expect(parseFrame(encodeFrame(frame))).toEqual(frame);
  expect(parseFrame(encodeFrame({ type: "end", id: "1" }))).toEqual({
    type: "end",
    id: "1",
  });
});

test("a malformed frame is refused", () => {
  expect(() => parseFrame("nope")).toThrow("not JSON");
  expect(() => parseFrame('{"type":"end"}')).toThrow("no id");
  expect(() => parseFrame('{"type":"wat","id":"1"}')).toThrow("unknown type");
  expect(() =>
    parseFrame(
      '{"type":"request","id":"1","method":"GET","path":"//evil.test/x","headers":{}}',
    ),
  ).toThrow("path on the daemon");
  expect(() =>
    parseFrame(
      '{"type":"request","id":"1","method":"GET","path":"http://evil.test","headers":{}}',
    ),
  ).toThrow("path on the daemon");
});

test("hop headers are dropped and the rest are kept", () => {
  expect(
    stripHopHeaders({
      Host: "x",
      "Content-Length": "3",
      Accept: "text/event-stream",
    }),
  ).toEqual({ Accept: "text/event-stream" });
});

test("a token proves its role, its VM and its time", () => {
  const token = signToken({ role: "vm", vm: "vm-1", exp: 1000 }, "secret");
  expect(verifyToken(token, "secret", "vm", 999).vm).toBe("vm-1");
  expect(() => verifyToken(token, "secret", "vm", 1000)).toThrow("expired");
  expect(() => verifyToken(token, "other", "vm", 999)).toThrow("signature");
  expect(() => verifyToken(token, "secret", "web", 999)).toThrow("role");
  expect(() => verifyToken("a.b.c", "secret", "vm", 999)).toThrow("malformed");
});

test("a token whose body was edited no longer verifies", () => {
  const token = signToken({ role: "web", vm: "vm-1", exp: 1000 }, "secret");
  const [, signature] = token.split(".");
  const forged = Buffer.from(
    JSON.stringify({ role: "web", vm: "vm-2", exp: 1000 }),
  ).toString("base64url");
  expect(() =>
    verifyToken(`${forged}.${signature}`, "secret", "web", 999),
  ).toThrow("signature");
});
