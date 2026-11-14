/**
 * The relay: the public meeting point between the web server and VMs that
 * accept no inbound connections.
 *
 * Each VM's daemon holds a websocket open to `/vm`. The web server sends
 * ordinary HTTP requests carrying a signed token that names the VM. The relay
 * hands each request to that VM's websocket as a frame and streams the answer
 * back. It keeps nothing: no bodies, no history, no user data. A turn lives in
 * the daemon, so a dropped link here loses no events (the caller rejoins).
 */
import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  encodeFrame,
  maxTunnelMessageBytes,
  parseFrame,
  stripHopHeaders,
  verifyToken,
  type DownFrame,
  type RelayHandle,
  type RelayOptions,
} from "@companion/shared/tunnel";
import { WebSocketServer, type WebSocket } from "ws";

/** The largest request body forwarded: base64 grows it by a third. */
const maxBodyBytes = Math.floor((maxTunnelMessageBytes / 4) * 3) - 4096;

/** One connected VM and the requests it has not finished answering. */
type Vm = {
  socket: WebSocket;
  pending: Map<string, ServerResponse>;
  alive: boolean;
};

/** Starts the relay and resolves once it is listening. */
export async function startRelay(options: RelayOptions): Promise<RelayHandle> {
  const log = options.log ?? (() => {});
  const vms = new Map<string, Vm>();
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: maxTunnelMessageBytes,
  });

  const server = createServer((req, res) => {
    void route(req, res).catch((error: unknown) => {
      log(`request failed: ${(error as Error).message}`);
      if (!res.headersSent) fail(res, 502, "The relay failed.");
      else res.destroy();
    });
  });

  // A VM asks to connect with its own token. The vm claim is the only identity
  // used afterwards, so a daemon can never speak for another VM.
  server.on("upgrade", (req, socket, head) => {
    try {
      if (req.url !== "/vm") throw new Error("Nothing is served here.");
      const claims = verifyToken(bearer(req), options.secret, "vm");
      sockets.handleUpgrade(req, socket, head, (ws) => attach(claims.vm, ws));
    } catch (error) {
      log(`vm refused: ${(error as Error).message}`);
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  });

  /** Registers a VM's socket, replacing an older one for the same VM. */
  function attach(vmId: string, socket: WebSocket): void {
    vms.get(vmId)?.socket.close(4000, "replaced");
    const vm: Vm = { socket, pending: new Map(), alive: true };
    vms.set(vmId, vm);
    log(`vm connected: ${vmId}`);
    socket.on("pong", () => (vm.alive = true));
    socket.on("message", (data) => {
      try {
        onUpFrame(vm, parseFrame(data.toString()));
      } catch (error) {
        log(`vm ${vmId} frame refused: ${(error as Error).message}`);
      }
    });
    socket.on("close", () => {
      // Only forget this VM when a newer socket has not already replaced it.
      if (vms.get(vmId) === vm) vms.delete(vmId);
      for (const res of vm.pending.values()) {
        if (!res.headersSent) fail(res, 502, "The VM disconnected.");
        else res.destroy();
      }
      vm.pending.clear();
      log(`vm disconnected: ${vmId}`);
    });
  }

  function onUpFrame(vm: Vm, frame: ReturnType<typeof parseFrame>): void {
    const res = vm.pending.get(frame.id);
    if (res === undefined) return;
    if (frame.type === "response") {
      res.writeHead(frame.status, stripHopHeaders(frame.headers));
      res.flushHeaders();
    } else if (frame.type === "chunk") {
      res.write(Buffer.from(frame.data, "base64"));
    } else if (frame.type === "end") {
      vm.pending.delete(frame.id);
      res.end();
    } else if (frame.type === "error") {
      vm.pending.delete(frame.id);
      if (!res.headersSent) fail(res, 502, frame.message);
      else res.destroy();
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    // The load balancer's health check. It needs no token and reveals nothing.
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"status":"ok"}');
      return;
    }
    let vmId: string;
    try {
      vmId = verifyToken(bearer(req), options.secret, "web").vm;
    } catch (error) {
      log(`request refused: ${(error as Error).message}`);
      fail(res, 401, "Not authorized.");
      return;
    }
    const vm = vms.get(vmId);
    if (vm === undefined) {
      fail(res, 503, "The VM is not connected.");
      return;
    }
    const body = await readBody(req);
    if (body === undefined) {
      fail(res, 413, "The request body is too large.");
      return;
    }
    const id = randomUUID();
    vm.pending.set(id, res);
    // The caller going away (a closed tab, a cancelled fetch) stops the VM's
    // work on this request, not the turn itself, which belongs to the daemon.
    res.on("close", () => {
      if (vm.pending.delete(id)) send(vm, { type: "cancel", id });
    });
    const headers = stripHopHeaders(
      Object.fromEntries(
        Object.entries(req.headers).flatMap(([name, value]) =>
          typeof value === "string" && name !== "authorization"
            ? [[name, value]]
            : [],
        ),
      ),
    );
    send(vm, {
      type: "request",
      id,
      method: req.method ?? "GET",
      path: req.url ?? "/",
      headers,
      ...(body.length > 0 ? { body: body.toString("base64") } : {}),
    });
  }

  // A silent VM is dropped so its callers get an answer instead of waiting.
  const heartbeat = setInterval(() => {
    for (const vm of vms.values()) {
      if (!vm.alive) {
        vm.socket.terminate();
        continue;
      }
      vm.alive = false;
      vm.socket.ping();
    }
  }, options.pingMs ?? 20_000);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The relay did not bind a port.");
  }
  return {
    port: address.port,
    vms: () => [...vms.keys()],
    async close() {
      clearInterval(heartbeat);
      for (const vm of vms.values()) vm.socket.terminate();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The token after `Bearer `, or an error naming the missing header. */
function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) throw new Error("No bearer token.");
  return header.slice("Bearer ".length);
}

function send(vm: Vm, frame: DownFrame): void {
  if (vm.socket.readyState === vm.socket.OPEN)
    vm.socket.send(encodeFrame(frame));
}

function fail(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

/** The whole request body, or undefined when it is over the limit. */
async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBodyBytes) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
