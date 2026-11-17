/**
 * The host agent's rules: which computers this host runs, and the HTTP API the
 * web server reaches through the relay. A user has at most one computer here,
 * asking again for a running one changes nothing, a full host says so, and the
 * list survives an agent restart so computers come back without being asked.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  HostFullError,
  parseComputerSpec,
  type ComputerRunner,
  type ComputerSpec,
  type ComputerStatus,
  type ComputerView,
  type HostVolumes,
} from "@companion/shared/host";

type Held = { spec: ComputerSpec; slot: number; status: ComputerStatus };

export type HostAgent = {
  /** Starts a user's computer. True when this call began it, false when it already existed. */
  start(spec: ComputerSpec): boolean;
  /** Stops a user's computer and releases its volume. False when none exists. */
  stop(userId: string): Promise<boolean>;
  list(): ComputerView[];
  /** Brings back every computer saved before the agent last stopped. */
  restore(): void;
  /** Resolves when no start or stop is still in progress. Tests wait on it. */
  settled(): Promise<void>;
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
};

export function createHostAgent(options: {
  runner: ComputerRunner;
  volumes: HostVolumes;
  /** Where the held computers are saved. Holds relay tokens, so it is private. */
  stateFile: string;
  /** The most computers this host runs at once. */
  capacity: number;
  log?: (line: string) => void;
}): HostAgent {
  const { runner, volumes } = options;
  const log = options.log ?? (() => {});
  const held = new Map<string, Held>();
  const work = new Set<Promise<unknown>>();

  function track<T>(promise: Promise<T>): Promise<T> {
    work.add(promise);
    void promise.then(
      () => work.delete(promise),
      () => work.delete(promise),
    );
    return promise;
  }

  function save(): void {
    mkdirSync(dirname(options.stateFile), { recursive: true });
    const temporary = `${options.stateFile}.tmp`;
    writeFileSync(
      temporary,
      JSON.stringify(
        [...held.values()].map(({ spec, slot }) => ({ spec, slot })),
      ),
      { mode: 0o600 },
    );
    renameSync(temporary, options.stateFile);
  }

  function freeSlot(): number {
    const used = new Set([...held.values()].map((entry) => entry.slot));
    let slot = 1;
    while (used.has(slot)) slot++;
    return slot;
  }

  /** Attaches the volume and runs the microVM. A failure releases everything so a repeat can try again. */
  async function bring(entry: Held): Promise<void> {
    const { spec, slot } = entry;
    try {
      const dataDevice = await volumes.attach(spec.volumeId);
      await runner.start({ spec, slot, dataDevice });
      entry.status = "running";
      log(`computer running: ${spec.userId} in slot ${slot}`);
    } catch (error) {
      log(`computer failed to start: ${spec.userId}: ${String(error)}`);
      await runner.stop(slot).catch(() => {});
      await volumes.detach(spec.volumeId).catch(() => {});
      held.delete(spec.userId);
      save();
    }
  }

  const agent: HostAgent = {
    start(spec) {
      if (held.has(spec.userId)) return false;
      if (held.size >= options.capacity) {
        throw new HostFullError("This host has no room for another computer.");
      }
      const entry: Held = { spec, slot: freeSlot(), status: "starting" };
      held.set(spec.userId, entry);
      save();
      void track(bring(entry));
      return true;
    },
    async stop(userId) {
      const entry = held.get(userId);
      if (entry === undefined) return false;
      held.delete(userId);
      save();
      await track(
        (async () => {
          await runner.stop(entry.slot);
          await volumes.detach(entry.spec.volumeId);
        })(),
      );
      return true;
    },
    list() {
      return [...held.values()].map(({ spec, slot, status }) => ({
        userId: spec.userId,
        volumeId: spec.volumeId,
        slot,
        status,
      }));
    },
    restore() {
      let saved: { spec: ComputerSpec; slot: number }[];
      try {
        saved = JSON.parse(
          readFileSync(options.stateFile, "utf8"),
        ) as typeof saved;
      } catch {
        return;
      }
      for (const { spec, slot } of saved) {
        const entry: Held = { spec, slot, status: "starting" };
        held.set(spec.userId, entry);
        void track(bring(entry));
      }
    },
    async settled() {
      while (work.size > 0) await Promise.allSettled([...work]);
    },
    async handle(req, res) {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const parts = url.pathname.split("/").filter((part) => part !== "");
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (parts[0] === "health" && req.method === "GET") {
        return send(200, { status: "ok", computers: held.size });
      }
      if (parts[0] !== "computers") return send(404, { error: "Not found." });
      if (parts.length === 1 && req.method === "GET")
        return send(200, agent.list());
      if (parts.length === 1 && req.method === "POST") {
        let spec: ComputerSpec;
        try {
          spec = parseComputerSpec(JSON.parse(await readBody(req)));
        } catch (error) {
          return send(400, { error: (error as Error).message });
        }
        try {
          const began = agent.start(spec);
          return send(began ? 202 : 200, {
            status: began ? "starting" : "exists",
          });
        } catch (error) {
          if (error instanceof HostFullError) {
            return send(507, { error: error.message });
          }
          throw error;
        }
      }
      if (parts.length === 2 && req.method === "DELETE") {
        const stopped = await agent.stop(parts[1] as string);
        return send(stopped ? 200 : 404, { stopped });
      }
      return send(405, { error: "Method not allowed." });
    },
  };
  return agent;
}

/** The request body as text. Start requests are tiny, so a limit keeps a bad one from filling memory. */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error("The request body is too large.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
