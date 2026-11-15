/**
 * Proves a user's computer is set up once and recovers from failure, using an
 * in-memory store, a fake volume service that hands back the same volume for a
 * repeated create, and a fake host. No AWS and no database.
 */
import {
  NoCapacityError,
  vmLaunchTimeoutMs,
  volumeToken,
  type ReconcileDeps,
  type VmHosts,
  type VmRow,
  type VmStore,
  type VmVolumes,
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
          // A retry keeps the volume the user already has.
          volumeId: row?.volumeId ?? null,
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
        volumeId: patch.volumeId === undefined ? row.volumeId : patch.volumeId,
      };
    },
  };
  return { store, current: () => row };
}

/** Volumes where a repeated token returns the volume already made, and one can be found by owner. */
function fakeVolumes() {
  const byToken = new Map<string, string>();
  const byOwner = new Map<string, string>();
  const volumes: VmVolumes = {
    async find(userId) {
      return byOwner.get(userId) ?? null;
    },
    async create(userId) {
      const token = volumeToken(userId);
      let id = byToken.get(token);
      if (id === undefined) {
        id = `vol-${byToken.size + 1}`;
        byToken.set(token, id);
        byOwner.set(userId, id);
      }
      return id;
    },
  };
  return { volumes, made: () => new Set(byToken.values()).size };
}

/** A host that starts a computer once however often it is asked, or has no room. */
function fakeHost() {
  const running = new Map<string, string>();
  const state = { full: false, starts: 0 };
  const hosts: VmHosts = {
    async start(row) {
      state.starts += 1;
      if (state.full) throw new NoCapacityError("no room");
      running.set(row.userId, row.volumeId);
    },
  };
  return { hosts, running, state };
}

function setup(options: { probe?: boolean; failNextUpdate?: boolean } = {}) {
  const clock = { ms: Date.UTC(2026, 0, 1, 0, 1) };
  const database = fakeStore(() => clock.ms, options.failNextUpdate);
  const disks = fakeVolumes();
  const host = fakeHost();
  const probe = { up: options.probe ?? false };
  const deps: ReconcileDeps = {
    store: database.store,
    volumes: disks.volumes,
    hosts: host.hosts,
    probe: async () => probe.up,
    now: () => clock.ms,
  };
  return { deps, database, disks, host, clock, probe };
}

test("a new user's first visit makes one volume, starts their computer and waits", async () => {
  const { deps, database, disks, host } = setup();
  expect((await reconcile(user, deps)).status).toBe("setting-up");
  expect(database.current()).toMatchObject({
    state: "booting",
    volumeId: "vol-1",
  });
  expect(disks.made()).toBe(1);
  expect(host.running.get(user)).toBe("vol-1");
});

test("the user is ready only once the computer answers through the relay", async () => {
  const { deps, probe } = setup();
  await reconcile(user, deps);
  expect((await reconcile(user, deps)).status).toBe("setting-up");
  probe.up = true;
  expect((await reconcile(user, deps)).status).toBe("ready");
});

test("requests at the same moment still make one volume and one computer", async () => {
  const { deps, disks, host } = setup();
  await Promise.all(Array.from({ length: 6 }, () => reconcile(user, deps)));
  expect(disks.made()).toBe(1);
  expect(host.running.size).toBe(1);
});

test("a crash after making the volume, before saving, does not make a second volume", async () => {
  const { deps, database, disks } = setup({ failNextUpdate: true });
  await expect(reconcile(user, deps)).rejects.toThrow("dropped");
  expect(database.current()?.state).toBe("launching");
  await reconcile(user, deps);
  expect(disks.made()).toBe(1);
  expect(database.current()?.volumeId).toBe("vol-1");
});

test("a host with no room keeps the user setting up until the time limit, then fails without deleting the volume", async () => {
  const { deps, database, disks, host, clock } = setup();
  host.state.full = true;
  expect((await reconcile(user, deps)).status).toBe("setting-up");
  clock.ms += vmLaunchTimeoutMs + 1000;
  expect((await reconcile(user, deps)).status).toBe("failed");
  expect(database.current()?.volumeId).toBe("vol-1");
  expect(disks.made()).toBe(1);
});

test("a computer that is not usable in time fails the attempt", async () => {
  const { deps, clock } = setup();
  await reconcile(user, deps);
  clock.ms += vmLaunchTimeoutMs + 1000;
  expect((await reconcile(user, deps)).status).toBe("failed");
});

test("a computer that has room again is started on the next call", async () => {
  const { deps, host, probe } = setup();
  host.state.full = true;
  await reconcile(user, deps);
  expect(host.running.size).toBe(0);
  host.state.full = false;
  probe.up = true;
  expect((await reconcile(user, deps)).status).toBe("ready");
  expect(host.running.get(user)).toBe("vol-1");
});

test("a failed user stays failed until they try again, which reuses their volume", async () => {
  const { deps, disks, host, clock, probe } = setup();
  host.state.full = true;
  await reconcile(user, deps);
  clock.ms += vmLaunchTimeoutMs + 1000;
  await reconcile(user, deps);
  expect((await reconcile(user, deps)).status).toBe("failed");

  clock.ms = Date.UTC(2026, 0, 1, 1, 0);
  host.state.full = false;
  probe.up = true;
  expect((await reconcile(user, deps, true)).status).toBe("ready");
  expect(disks.made()).toBe(1);
  expect(host.running.get(user)).toBe("vol-1");
});

test("trying again twice at once starts one new attempt", async () => {
  const { deps, host, clock } = setup();
  host.state.full = true;
  await reconcile(user, deps);
  clock.ms += vmLaunchTimeoutMs + 1000;
  await reconcile(user, deps);
  clock.ms = Date.UTC(2026, 0, 1, 1, 0);
  host.state.full = false;
  await Promise.all([reconcile(user, deps, true), reconcile(user, deps, true)]);
  expect(host.running.size).toBe(1);
});
