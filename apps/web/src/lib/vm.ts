/**
 * Gives every user one cloud computer, and tells the page when it is usable.
 *
 * `reconcile` is one idempotent step: look at where the user's computer is,
 * move it one step forward, say where it is now. The first visit starts it;
 * the setup screen polls and so keeps calling it. Nothing needs to stay
 * running between calls, so a closed browser or a crashed request just leaves
 * the row where it was, and the next call carries on.
 *
 * Double provisioning is stopped three ways: the database lets one caller
 * claim a user, EC2 gets a token that repeats for the same attempt, and the
 * machine is looked up by tag before any launch.
 */
import {
  NoCapacityError,
  vmLaunchTimeoutMs,
  vmStatus,
  type ReconcileDeps,
  type VmRow,
  type VmStatus,
} from "@companion/shared/vm";

/** The state after one step, for the page and the setup screen. */
export type VmView = { status: VmStatus };

/**
 * Moves the user's computer one step forward. A user with no record is
 * claimed first; a failed one stays failed until `retry` is true, which is
 * the person pressing Try again.
 */
export async function reconcile(
  userId: string,
  deps: ReconcileDeps,
  retry = false,
): Promise<VmView> {
  const { store } = deps;
  let row = await store.get(userId);
  if (row === null || (retry && row.state === "failed")) {
    // Losing the claim means another request is already starting this user.
    row = (await store.claim(userId, retry)) ?? (await store.get(userId));
  }
  if (row === null) return { status: "setting-up" };
  if (row.state === "launching") row = await launch(row, deps);
  if (row.state === "booting") row = await boot(row, deps);
  return { status: vmStatus(row.state) };
}

/**
 * Starts the machine for a claimed attempt. An attempt that already launched
 * one (a crash between launching and saving) is found by tag and reused. A
 * full zone is skipped once for the next zone. Any other failure leaves the
 * row as it is so the next call tries again, until the time limit.
 */
async function launch(row: VmRow, deps: ReconcileDeps): Promise<VmRow> {
  if (timedOut(row, deps)) return fail(row, deps);
  const { cloud, store } = deps;
  let id = (await cloud.find(row))?.id;
  for (let zone = 0; id === undefined && zone < cloud.zones; zone++) {
    try {
      id = await cloud.launch(row, zone);
    } catch (error) {
      if (!(error instanceof NoCapacityError)) {
        console.error("launching a user VM failed", error);
        return row;
      }
    }
  }
  if (id === undefined) return row;
  await store.update(row, { state: "booting", instanceId: id });
  return { ...row, state: "booting", instanceId: id };
}

/**
 * Watches a launched machine until it is usable: running in EC2 and answering
 * through the relay, which also means the daemon started. A machine that
 * vanished, or one that is not usable in time, is cleaned up and the attempt
 * fails so nothing keeps costing money behind a failed screen.
 */
async function boot(row: VmRow, deps: ReconcileDeps): Promise<VmRow> {
  const { cloud, store } = deps;
  const id = row.instanceId;
  if (id === null) return { ...row, state: "launching" };
  const instance = await cloud.describe(id);
  if (instance === "gone") return fail(row, deps);
  if (instance === "running" && (await deps.probe(row.userId))) {
    await store.update(row, { state: "ready" });
    return { ...row, state: "ready" };
  }
  return timedOut(row, deps) ? fail(row, deps) : row;
}

function timedOut(row: VmRow, deps: ReconcileDeps): boolean {
  return deps.now() - Date.parse(row.attemptStartedAt) > vmLaunchTimeoutMs;
}

/** Marks the attempt failed and deletes what it created. */
async function fail(row: VmRow, deps: ReconcileDeps): Promise<VmRow> {
  // A crash between launching and saving leaves a machine only the tag knows.
  const id = row.instanceId ?? (await deps.cloud.find(row))?.id;
  if (id !== undefined) {
    await deps.cloud.destroy(id).catch((error) => {
      console.error("cleaning up a failed VM failed", error);
    });
  }
  await deps.store.update(row, { state: "failed" });
  return { ...row, state: "failed" };
}
