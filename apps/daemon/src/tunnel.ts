/**
 * The daemon's side of the relay tunnel.
 *
 * A VM accepts no inbound connections, so the daemon dials out to the relay and
 * keeps that websocket open, reconnecting whenever it drops. Requests that
 * arrive on it are made against the daemon's own HTTP server, so the relay
 * reaches exactly the API a local client does, and the answer is streamed back
 * as it is produced. A turn is the daemon's own and keeps running when the
 * tunnel drops (Task 2.7); the web side rejoins it by event index.
 */
import {
  encodeFrame,
  parseFrame,
  stripHopHeaders,
  maxTunnelMessageBytes,
  type TunnelHandle,
  type TunnelOptions,
  type TunnelRequest,
  type UpFrame,
} from "@companion/shared/tunnel";
import WebSocket from "ws";

/** How long the relay may be silent before the connection is treated as dead. */
const silenceLimitMs = 60_000;
const firstRetryMs = 1_000;
const longestRetryMs = 30_000;

/**
 * Connects to the relay and keeps the connection up until `close`.
 * Returns at once; the first connect happens in the background.
 */
export function startTunnel(options: TunnelOptions): TunnelHandle {
  const log = options.log ?? (() => {});
  let socket: WebSocket | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let retryMs = firstRetryMs;
  let closed = false;

  const connect = () => {
    const ws = new WebSocket(`${options.relayUrl.replace(/\/$/, "")}/vm`, {
      headers: { authorization: `Bearer ${options.token()}` },
      maxPayload: maxTunnelMessageBytes,
    });
    socket = ws;
    const inFlight = new Map<string, AbortController>();
    let watchdog: NodeJS.Timeout | undefined;
    // The relay pings on a timer; a quiet line means a half-open connection,
    // which a stopped-and-restarted VM or a dropped load balancer leaves behind.
    const feedWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => ws.terminate(), silenceLimitMs);
    };
    const send = (frame: UpFrame) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encodeFrame(frame));
    };

    ws.on("open", () => {
      retryMs = firstRetryMs;
      feedWatchdog();
      log("tunnel connected");
    });
    ws.on("ping", feedWatchdog);
    ws.on("message", (data) => {
      feedWatchdog();
      let frame;
      try {
        frame = parseFrame(data.toString());
      } catch (error) {
        log(`tunnel frame refused: ${(error as Error).message}`);
        return;
      }
      if (frame.type === "cancel") {
        inFlight.get(frame.id)?.abort();
      } else if (frame.type === "request") {
        const controller = new AbortController();
        inFlight.set(frame.id, controller);
        void forward(options.target, frame, controller.signal, send).finally(
          () => inFlight.delete(frame.id),
        );
      }
    });
    ws.on("unexpected-response", (_request, response) => {
      log(`tunnel refused by the relay: ${response.statusCode}`);
    });
    ws.on("error", (error) => log(`tunnel error: ${error.message}`));
    ws.on("close", () => {
      clearTimeout(watchdog);
      for (const controller of inFlight.values()) controller.abort();
      if (closed) return;
      log(`tunnel closed, retrying in ${retryMs}ms`);
      retryTimer = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, longestRetryMs);
    });
  };

  connect();
  return {
    close() {
      closed = true;
      clearTimeout(retryTimer);
      socket?.terminate();
    },
  };
}

/**
 * Makes one forwarded request against the daemon and streams the answer back.
 * Aborting the signal, when the relay cancels or the tunnel drops, stops the
 * read so the daemon's own response is released.
 */
async function forward(
  target: string,
  request: TunnelRequest,
  signal: AbortSignal,
  send: (frame: UpFrame) => void,
): Promise<void> {
  const { id } = request;
  try {
    const hasBody = request.body !== undefined && request.method !== "GET";
    const response = await fetch(`${target}${request.path}`, {
      method: request.method,
      headers: stripHopHeaders(request.headers),
      body: hasBody ? Buffer.from(request.body as string, "base64") : undefined,
      signal,
    });
    send({
      type: "response",
      id,
      status: response.status,
      headers: stripHopHeaders(Object.fromEntries(response.headers)),
    });
    if (response.body !== null) {
      for await (const chunk of response.body) {
        send({
          type: "chunk",
          id,
          data: Buffer.from(chunk).toString("base64"),
        });
      }
    }
    send({ type: "end", id });
  } catch (error) {
    if (signal.aborted) return;
    send({ type: "error", id, message: (error as Error).message });
  }
}
