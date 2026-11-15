/**
 * Proves a user's computer is made once and cleaned up when it fails, using an
 * in-memory store and a fake EC2 that, like the real one, hands back the same
 * machine for a repeated launch token. No AWS and no database.
 */
import {
  launchToken,
  NoCapacityError,
  vmLaunchTimeoutMs,
  type InstanceState,
  type ReconcileDeps,
  type VmCloud,
  type VmRow,
  type VmStore,
} from "@companion/shared/vm";
import { expect, test } from "vitest";
import { reconcile } from "../src/lib/vm";

const user = "user-1";

/** A store that claims atomically, as the database function does. */
function fakeStore(now: () => number, failNextUpdate = false) {
  let row: VmRow | null = null;
  let claims = 0;
  let failUpdate = failNextUpdate;
  const store: VmStore = {
    async get() {
      return row;
    },
    async claim(userId, retry) {
      if (row === null || (retry && row.state === "failed")) {
        claims += 1;
        row = {
          userId,
          state: "launching",
          instanceId: null,
          // The database's now(), nudged by the claim count so attempts never share a time.
          attemptStartedAt: new Date(now() + claims).toISOString(),
        };
        return row;
      }
      return null;
    },
    async update(current, patch) {
      if (failUpdate) {
        failUpdate = false;
        throw new Error("the database dropped the write");
      }
      if (row?.attemptStartedAt !== current.attemptStartedAt) return;
      row = {
        ...row,
        state: patch.state,
        instanceId:
          patch.instanceId === undefined ? row.instanceId : patch.instanceId,
      };
    },
  };
  return { store, current: () => row };
}

/** A cloud where a repeated token returns the machine it already made. */
function fakeCloud(options: { fullZones?: number[] } = {}) {
  const byToken = new Map<string, string>();
  const tags = new Map<string, string>();
  const destroyed: string[] = [];
  const state = new Map<string, InstanceState>();
  const cloud: VmCloud = {
    zones: 2,
    async find(row) {
      const id = tags.get(`${row.userId}|${row.attemptStartedAt}`);
      return id === undefined ? null : { id };
    },
    async launch(row, zone) {
      if (options.fullZones?.includes(zone)) throw new NoCapacityError("full");
      const token = launchToken(row, zone);
      let id = byToken.get(token);
      if (id === undefined) {
        id = `i-${byToken.size + 1}`;
        byToken.set(token, id);
        tags.set(`${row.userId}|${row.attemptStartedAt}`, id);
        state.set(id, "pending");
      }
      return id;
    },
    async describe(id) {
      return state.get(id) ?? "gone";
    },
    async destroy(id) {
      destroyed.push(id);
      state.set(id, "gone");
    },
  };
  return {
    cloud,
    state,
    destroyed,
    launched: () => new Set(byToken.values()).size,
  };
}

function setup(
  options: {
    probe?: boolean;
    fullZones?: number[];
    failNextUpdate?: boolean;
  } = {},
) {
  const clock = { ms: Date.UTC(2026, 0, 1, 0, 1) };
  const database = fakeStore(() => clock.ms, options.failNextUpdate);
  const machines = fakeCloud({ fullZones: options.fullZones });
  const probe = { up: options.probe ?? false };
  const deps: ReconcileDeps = {
    store: database.store,
    cloud: machines.cloud,
    probe: async () => probe.up,
    now: () => clock.ms,
  };
  return { deps, database, machines, clock, probe };
}

test("a new user's first visit launches one machine and waits for it", async () => {
  const { deps, database, machines } = setup();
  expect((await reconcile(user, deps)).status).toBe("setting-up");
  expect(database.current()?.state).toBe("booting");
  expect(machines.launched()).toBe(1);
});

test("the user is ready only once the machine is running and answers", async () => {
  const { deps, machines, probe } = setup();
  await reconcile(user, deps);
  expect((await reconcile(user, deps)).status).toBe("setting-up");
  machines.state.set("i-1", "running");
  expect((await reconcile(user, deps)).status).toBe("setting-up");
  probe.up = true;
  expect((await reconcile(user, deps)).status).toBe("ready");
});

test("requests at the same moment still make one machine", async () => {
  const { deps, machines } = setup();
  await Promise.all(Array.from({ length: 6 }, () => reconcile(user, deps)));
  expect(machines.launched()).toBe(1);
});

test("a crash after launching, before saving, does not launch a second machine", async () => {
  const { deps, database, machines } = setup({ failNextUpdate: true });
  await expect(reconcile(user, deps)).rejects.toThrow("dropped");
  expect(database.current()?.state).toBe("launching");
  await reconcile(user, deps);
  expect(machines.launched()).toBe(1);
  expect(database.current()?.instanceId).toBe("i-1");
});

test("a full zone is skipped for the next one", async () => {
  const { deps, machines } = setup({ fullZones: [0] });
  await reconcile(user, deps);
  expect(machines.launched()).toBe(1);
});

test("a user stays setting up when every zone is full, until the time limit", async () => {
  const { deps, database, machines, clock } = setup({ fullZones: [0, 1] });
  expect((await reconcile(user, deps)).status).toBe("setting-up");
  expect(machines.launched()).toBe(0);
  clock.ms += vmLaunchTimeoutMs + 1000;
  expect((await reconcile(user, deps)).status).toBe("failed");
  expect(database.current()?.state).toBe("failed");
});

test("a machine that is not usable in time is deleted and the attempt fails", async () => {
  const { deps, machines, clock } = setup();
  await reconcile(user, deps);
  machines.state.set("i-1", "running");
  clock.ms += vmLaunchTimeoutMs + 1000;
  expect((await reconcile(user, deps)).status).toBe("failed");
  expect(machines.destroyed).toEqual(["i-1"]);
});

test("a machine that disappears fails the attempt", async () => {
  const { deps, machines } = setup();
  await reconcile(user, deps);
  machines.state.set("i-1", "gone");
  expect((await reconcile(user, deps)).status).toBe("failed");
});

test("a timed out attempt that crashed before saving still deletes its machine", async () => {
  const { deps, machines, clock } = setup({ failNextUpdate: true });
  await expect(reconcile(user, deps)).rejects.toThrow("dropped");
  clock.ms += vmLaunchTimeoutMs + 1000;
  expect((await reconcile(user, deps)).status).toBe("failed");
  expect(machines.destroyed).toEqual(["i-1"]);
});

test("a failed user stays failed until they try again, which starts a new machine", async () => {
  const { deps, machines, clock } = setup();
  await reconcile(user, deps);
  clock.ms += vmLaunchTimeoutMs + 1000;
  await reconcile(user, deps);
  expect((await reconcile(user, deps)).status).toBe("failed");
  expect(machines.launched()).toBe(1);

  clock.ms = Date.UTC(2026, 0, 1, 1, 0);
  expect((await reconcile(user, deps, true)).status).toBe("setting-up");
  expect(machines.launched()).toBe(2);
});

test("trying again twice at once starts one new attempt", async () => {
  const { deps, machines, clock } = setup();
  await reconcile(user, deps);
  clock.ms += vmLaunchTimeoutMs + 1000;
  await reconcile(user, deps);
  clock.ms = Date.UTC(2026, 0, 1, 1, 0);
  await Promise.all([reconcile(user, deps, true), reconcile(user, deps, true)]);
  expect(machines.launched()).toBe(2);
});
