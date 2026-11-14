/**
 * What the relay, the daemon and the web server agree on to reach a daemon
 * that accepts no inbound connections.
 *
 * The daemon dials out to the relay and keeps that websocket open. A web
 * request is carried down it as an HTTP request, and the daemon's answer, which
 * may be a long stream, comes back as pieces. Nothing here knows the daemon's
 * routes, so the daemon API is the same whether it is reached directly or
 * through the relay. Access is by short-lived signed tokens: one proves a
 * connection is a given VM, the other proves a request is for a given VM.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Sent by the relay to a daemon: do this HTTP request, or stop one. */
export type TunnelRequest = {
  type: "request";
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  /** The request body as base64. Absent for a request with no body. */
  body?: string;
};

export type TunnelCancel = { type: "cancel"; id: string };

/** Sent by a daemon to the relay: the answer to one request, in order. */
export type TunnelResponse = {
  type: "response";
  id: string;
  status: number;
  headers: Record<string, string>;
};

/** One piece of the response body, as base64. */
export type TunnelChunk = { type: "chunk"; id: string; data: string };

export type TunnelEnd = { type: "end"; id: string };

/** The daemon could not answer: it never reached its own server, or the body broke off. */
export type TunnelError = { type: "error"; id: string; message: string };

/** Frames the relay sends to a daemon. */
export type DownFrame = TunnelRequest | TunnelCancel;

/** Frames a daemon sends to the relay. */
export type UpFrame = TunnelResponse | TunnelChunk | TunnelEnd | TunnelError;

export type TunnelFrame = DownFrame | UpFrame;

/** The largest websocket message either side accepts, which bounds a request body. */
export const maxTunnelMessageBytes = 32 * 1024 * 1024;

/** Header names that describe one hop of a connection, not the request itself. */
const hopByHop = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-authenticate",
  "content-length",
  "host",
]);

/** Headers without the ones that only mean something on one connection. */
export function stripHopHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !hopByHop.has(name.toLowerCase()),
    ),
  );
}

/** A frame as the text sent over the websocket. */
export function encodeFrame(frame: TunnelFrame): string {
  return JSON.stringify(frame);
}

/**
 * A frame read from the websocket, or an error naming what was wrong.
 * Either side calls this on every message, since the other end is not trusted
 * to be well-formed.
 */
export function parseFrame(text: string): TunnelFrame {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("The tunnel frame is not JSON.");
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("The tunnel frame is not an object.");
  }
  const frame = value as Record<string, unknown>;
  if (typeof frame.id !== "string" || frame.id === "") {
    throw new Error("The tunnel frame has no id.");
  }
  switch (frame.type) {
    case "request":
      if (typeof frame.method !== "string" || typeof frame.path !== "string") {
        throw new Error("A request frame needs a method and a path.");
      }
      if (!frame.path.startsWith("/") || frame.path.startsWith("//")) {
        throw new Error("A request path must be a path on the daemon.");
      }
      if (!isHeaders(frame.headers)) {
        throw new Error("A request frame needs string headers.");
      }
      if (frame.body !== undefined && typeof frame.body !== "string") {
        throw new Error("A request body must be base64 text.");
      }
      return value as TunnelRequest;
    case "cancel":
    case "end":
      return value as TunnelCancel | TunnelEnd;
    case "response":
      if (typeof frame.status !== "number" || !isHeaders(frame.headers)) {
        throw new Error("A response frame needs a status and string headers.");
      }
      return value as TunnelResponse;
    case "chunk":
      if (typeof frame.data !== "string") {
        throw new Error("A chunk frame needs base64 data.");
      }
      return value as TunnelChunk;
    case "error":
      if (typeof frame.message !== "string") {
        throw new Error("An error frame needs a message.");
      }
      return value as TunnelError;
    default:
      throw new Error("The tunnel frame has an unknown type.");
  }
}

function isHeaders(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((v) => typeof v === "string")
  );
}

/**
 * What a token says.
 * `vm` is the one daemon it is about. A `vm` token is held by that daemon and
 * lets it connect. A `web` token is made by the web server per request and
 * names the user, so the relay can log whose request it carried.
 */
export type TokenClaims = {
  role: "vm" | "web";
  vm: string;
  user?: string;
  /** When it stops working, in seconds since the epoch. */
  exp: number;
};

/** A claim set signed with the secret the control plane and the relay share. */
export function signToken(claims: TokenClaims, secret: string): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${mac(body, secret)}`;
}

/**
 * The claims in a token, when it is signed with this secret, has the wanted
 * role and has not expired. Anything else is refused with the reason, so a
 * log line can say why a connection was turned away.
 */
export function verifyToken(
  token: string,
  secret: string,
  role: TokenClaims["role"],
  nowSeconds: number = Math.floor(Date.now() / 1000),
): TokenClaims {
  const [body, signature, extra] = token.split(".");
  if (body === undefined || signature === undefined || extra !== undefined) {
    throw new Error("The token is malformed.");
  }
  const expected = Buffer.from(mac(body, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("The token signature is wrong.");
  }
  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new Error("The token is malformed.");
  }
  if (claims.role !== role) throw new Error("The token is for another role.");
  if (typeof claims.vm !== "string" || claims.vm === "") {
    throw new Error("The token names no VM.");
  }
  if (typeof claims.exp !== "number" || claims.exp <= nowSeconds) {
    throw new Error("The token has expired.");
  }
  return claims;
}

function mac(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

/** What the daemon needs to open its tunnel to the relay. */
export type TunnelOptions = {
  /** The relay's address, such as `wss://relay.example.com`. */
  relayUrl: string;
  /** The VM token to present. Asked for on every connect, so it can be renewed. */
  token: () => string;
  /** The daemon's own address, which forwarded requests are made against. */
  target: string;
  /** Called with a line about connects, drops and refused frames. */
  log?: (line: string) => void;
};

/** A running tunnel. `close` stops it for good and drops any request still in flight. */
export type TunnelHandle = {
  close(): void;
};
