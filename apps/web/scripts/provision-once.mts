/**
 * Provisions one real VM on AWS through the same `reconcile` the app uses, but
 * with the record kept in memory so no database is needed. It prints each step
 * and the time to ready, then deletes the machine and its disk.
 *
 *   pnpm --filter @companion/web exec tsx scripts/provision-once.mts
 *
 * Reads the same settings as the app (COMPANION_VM_*, COMPANION_RELAY_*).
 */
import { randomUUID } from "node:crypto";
import { reconcile } from "../src/lib/vm";
import type { VmRow, VmStore } from "@companion/shared/vm";
import { ec2Cloud, relayProbe } from "../src/lib/vm-aws";

/** The record kept in memory, so this check needs no database. */
function memoryStore(): VmStore {
  let row: VmRow | null = null;
  return {
    async get() {
      return row;
    },
    async claim(userId, retry) {
      if (row !== null && !(retry && row.state === "failed")) return null;
      row = {
        userId,
        state: "launching",
        instanceId: null,
        attemptStartedAt: new Date().toISOString(),
      };
      return row;
    },
    async update(_current, patch) {
      if (row === null) return;
      row = {
        ...row,
        state: patch.state,
        instanceId: patch.instanceId ?? row.instanceId,
      };
    },
  };
}

const userId = randomUUID();
const cloud = ec2Cloud();
const deps = {
  store: memoryStore(),
  cloud,
  probe: relayProbe,
  now: () => Date.now(),
};
const started = Date.now();
const seconds = () => Math.round((Date.now() - started) / 1000);

console.log(`user ${userId}`);
let last = "";
let status = "setting-up";
try {
  while (status === "setting-up" && seconds() < 15 * 60) {
    status = (await reconcile(userId, deps)).status;
    const row = await deps.store.get(userId);
    const line = `${row?.state} ${row?.instanceId ?? ""}`;
    if (line !== last) console.log(`${seconds()}s  ${line}`);
    last = line;
    if (status === "setting-up") await new Promise((r) => setTimeout(r, 5000));
  }
  console.log(`${status} after ${seconds()}s`);
} finally {
  const row = await deps.store.get(userId);
  const id = row?.instanceId ?? (row ? (await cloud.find(row))?.id : undefined);
  if (id !== undefined && id !== null) {
    await cloud.destroy(id);
    console.log(`terminated ${id} (its data disk is deleted with it)`);
  }
}
process.exit(status === "ready" ? 0 : 1);
