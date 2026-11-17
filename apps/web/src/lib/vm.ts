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
 * claim a user, the data volume is looked up by owner before it is created
 * and created with a token that repeats, and a host treats a repeated start
 * of the same user's computer as a no-op.
 */
import {
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
 * Gives a claimed attempt its data volume, then asks a host to run the
 * computer. The volume is looked up by owner first, so a crash after creating
 * it, or a Try again after a failure, reuses it and never makes a second.
 * Any other failure leaves the row as it is so the next call tries again,
 * until the time limit.
 */
async function launch(row: VmRow, deps: ReconcileDeps): Promise<VmRow> {
  if (timedOut(row, deps)) return fail(row, deps);
  const { volumes, store } = deps;
  let volumeId = row.volumeId ?? (await volumes.find(row.userId));
  if (volumeId === null) {
    try {
      volumeId = await volumes.create(row.userId);
    } catch (error) {
      console.error("creating a user's data volume failed", error);
      return row;
    }
  }
  await store.update(row, { state: "booting", volumeId });
  return { ...row, state: "booting", volumeId };
}

/**
 * Watches a computer until it is usable: a host is running it and its daemon
 * answers through the relay. Starting is repeated on every call because it is
 * harmless, which also restarts a computer that stopped before it was ready.
 * One that is not usable in time fails the attempt; the user's volume stays.
 */
async function boot(row: VmRow, deps: ReconcileDeps): Promise<VmRow> {
  const { hosts, store } = deps;
  if (row.volumeId === null) return { ...row, state: "launching" };
  try {
    await hosts.start({ ...row, volumeId: row.volumeId });
  } catch (error) {
    // No room, or the host is unreachable: try again on the next call.
    console.error("starting a user's computer failed", error);
  }
  if (await deps.probe(row.userId)) {
    await store.update(row, { state: "ready" });
    return { ...row, state: "ready" };
  }
  return timedOut(row, deps) ? fail(row, deps) : row;
}

function timedOut(row: VmRow, deps: ReconcileDeps): boolean {
  return deps.now() - Date.parse(row.attemptStartedAt) > vmLaunchTimeoutMs;
}

/**
 * Marks the attempt failed. The data volume is kept: it is the user's, it may
 * hold their work, and a retry reuses it.
 */
async function fail(row: VmRow, deps: ReconcileDeps): Promise<VmRow> {
  await deps.store.update(row, { state: "failed" });
  return { ...row, state: "failed" };
}
