/**
 * Proves the host agent's rules with a fake runner and fake volumes: one
 * computer per user, no double start, a full host says so, a failed start
 * releases everything so it can be retried, and the list survives a restart.
 * Requests go through the real HTTP handler, as the relay would send them.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ComputerRunner,
  HostVolumes,
  RunSpec,
} from "@companion/shared/host";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createHostAgent } from "../src/agent.js";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "companion-host-"));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

const spec = (n: number) => ({
  userId: `user-${n}`,
  volumeId: `vol-0abc${n}000000000`.slice(0, 21),
  relayUrl: "wss://relay.example.com",
  relayToken: `secret-token-${n}`,
});

function fakes(options: { failAttach?: number } = {}) {
  const running = new Map<number, RunSpec>();
  const attached = new Set<string>();
  const state = { failAttach: options.failAttach ?? 0, starts: 0 };
  const runner: ComputerRunner = {
    async prepareHost() {},
    async start(run) {
      state.starts += 1;
      running.set(run.slot, run);
    },
    async stop(slot) {
      running.delete(slot);
    },
  };
  const volumes: HostVolumes = {
    async attach(volumeId) {
      if (state.failAttach > 0) {
        state.failAttach -= 1;
        throw new Error("attach failed");
      }
      attached.add(volumeId);
      return `/dev/fake/${volumeId}`;
    },
    async detach(volumeId) {
      attached.delete(volumeId);
    },
  };
  return { runner, volumes, running, attached, state };
}

function agentWith(
  parts: ReturnType<typeof fakes>,
  capacity = 2,
  stateFile = join(directory, "computers.json"),
) {
  return createHostAgent({
    runner: parts.runner,
    volumes: parts.volumes,
    stateFile,
    capacity,
  });
}

/** Sends a request through the agent's real HTTP handler. */
async function call(
  agent: ReturnType<typeof agentWith>,
  method: string,
  path: string,
  body?: unknown,
) {
  const server = createServer((req, res) => void agent.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: (await response.json()) as unknown,
    };
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

test("starting a user's computer attaches their volume and runs it once, however often it is asked", async () => {
  const parts = fakes();
  const agent = agentWith(parts);
  expect((await call(agent, "POST", "/computers", spec(1))).status).toBe(202);
  expect((await call(agent, "POST", "/computers", spec(1))).status).toBe(200);
  await agent.settled();
  expect(parts.state.starts).toBe(1);
  expect(parts.running.get(1)).toMatchObject({
    dataDevice: `/dev/fake/${spec(1).volumeId}`,
  });
  expect(agent.list()).toEqual([
    {
      userId: "user-1",
      volumeId: spec(1).volumeId,
      slot: 1,
      status: "running",
    },
  ]);
});

test("a full host answers 507, and a freed slot is reused", async () => {
  const parts = fakes();
  const agent = agentWith(parts, 2);
  await call(agent, "POST", "/computers", spec(1));
  await call(agent, "POST", "/computers", spec(2));
  expect((await call(agent, "POST", "/computers", spec(3))).status).toBe(507);
  expect((await call(agent, "DELETE", "/computers/user-1")).status).toBe(200);
  expect((await call(agent, "POST", "/computers", spec(3))).status).toBe(202);
  await agent.settled();
  expect(parts.running.get(1)?.spec.userId).toBe("user-3");
});

test("stopping releases the microVM and the volume, and an unknown user is a 404", async () => {
  const parts = fakes();
  const agent = agentWith(parts);
  await call(agent, "POST", "/computers", spec(1));
  await agent.settled();
  expect(parts.attached.size).toBe(1);
  await call(agent, "DELETE", "/computers/user-1");
  expect(parts.running.size).toBe(0);
  expect(parts.attached.size).toBe(0);
  expect((await call(agent, "DELETE", "/computers/user-1")).status).toBe(404);
});

test("a start that fails releases everything, so the next request can try again", async () => {
  const parts = fakes({ failAttach: 1 });
  const agent = agentWith(parts);
  await call(agent, "POST", "/computers", spec(1));
  await agent.settled();
  expect(agent.list()).toEqual([]);
  expect(parts.running.size).toBe(0);
  expect((await call(agent, "POST", "/computers", spec(1))).status).toBe(202);
  await agent.settled();
  expect(agent.list()[0]?.status).toBe("running");
});

test("after the agent restarts, saved computers come back in the same slots", async () => {
  const stateFile = join(directory, "computers.json");
  const first = fakes();
  const agent = agentWith(first, 3, stateFile);
  await call(agent, "POST", "/computers", spec(1));
  await call(agent, "POST", "/computers", spec(2));
  await agent.settled();

  const second = fakes();
  const restarted = agentWith(second, 3, stateFile);
  restarted.restore();
  await restarted.settled();
  expect(second.running.get(1)?.spec.userId).toBe("user-1");
  expect(second.running.get(2)?.spec.userId).toBe("user-2");
});

test("a bad request is refused, and the list never shows a token", async () => {
  const agent = agentWith(fakes());
  expect(
    (await call(agent, "POST", "/computers", { ...spec(1), userId: "../etc" }))
      .status,
  ).toBe(400);
  expect(
    (await call(agent, "POST", "/computers", { ...spec(1), volumeId: "disk" }))
      .status,
  ).toBe(400);
  await call(agent, "POST", "/computers", spec(1));
  const listed = JSON.stringify((await call(agent, "GET", "/computers")).body);
  expect(listed).not.toContain("secret-token");
});

test("the saved list is private to the agent's user", async () => {
  const stateFile = join(directory, "computers.json");
  const agent = agentWith(fakes(), 2, stateFile);
  await call(agent, "POST", "/computers", spec(1));
  expect(readFileSync(stateFile, "utf8")).toContain("secret-token-1");
  const { statSync } = await import("node:fs");
  expect(statSync(stateFile).mode & 0o077).toBe(0);
});
