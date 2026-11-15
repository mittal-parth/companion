/**
 * What the control plane needs to know about a user's cloud computer: the
 * states it moves through, the ports `reconcile` talks to, and the one token
 * rule that keeps a retried launch from creating a second machine.
 * The ports let tests run the whole state machine without AWS or a database.
 */
import { createHash } from "node:crypto";

/** The steps a computer goes through. `null` in the store means none was ever requested. */
export type VmState = "launching" | "booting" | "ready" | "failed";

/** What the setup screen shows. Everything not ready or failed is "setting-up". */
export type VmStatus = "setting-up" | "ready" | "failed";

/** One user's computer as stored: one row per user, because a user has one VM. */
export type VmRow = {
  userId: string;
  state: VmState;
  instanceId: string | null;
  /** Set when an attempt is claimed. Kept as the database's text so it round-trips exactly. */
  attemptStartedAt: string;
};

/** Where a user's computer record lives. Every write is guarded by the attempt it belongs to. */
export type VmStore = {
  get(userId: string): Promise<VmRow | null>;
  /**
   * Starts an attempt for this user, atomically. Only one caller wins. A new
   * user is claimed by anyone; a failed one only when `retry` is true.
   * Returns null for the callers that lost.
   */
  claim(userId: string, retry: boolean): Promise<VmRow | null>;
  /** Changes a row only while it is still the same attempt. */
  update(
    row: VmRow,
    patch: { state: VmState; instanceId?: string | null },
  ): Promise<void>;
};

/** What EC2 says about an instance, reduced to what `reconcile` decides on. */
export type InstanceState = "pending" | "running" | "gone";

/** The machines themselves. */
export type VmCloud = {
  /** The instance this attempt already launched, if one exists. */
  find(row: VmRow): Promise<{ id: string } | null>;
  /**
   * Launches one machine in the chosen zone. Repeating the call for the same
   * attempt returns the same machine. Throws `NoCapacityError` when the zone is full.
   */
  launch(row: VmRow, zone: number): Promise<string>;
  describe(instanceId: string): Promise<InstanceState>;
  /** Deletes the machine and its disks. Used only for an attempt that never became ready. */
  destroy(instanceId: string): Promise<void>;
  /** How many zones there are to try. */
  zones: number;
};

/** Thrown by `VmCloud.launch` when the chosen zone has no room. */
export class NoCapacityError extends Error {}

/** How `reconcile` reaches the daemon and reads the clock. */
export type ReconcileDeps = {
  store: VmStore;
  cloud: VmCloud;
  /** True when the daemon answers through the relay. */
  probe(userId: string): Promise<boolean>;
  now(): number;
};

/** How long an attempt may take before it is given up and cleaned up. */
export const vmLaunchTimeoutMs = 10 * 60 * 1000;

/** How long a computer's relay token lasts. Revoking one early is a separate task. */
export const vmTokenLifetimeSeconds = 365 * 24 * 60 * 60;

/**
 * The idempotency token for one launch attempt. The same attempt always gets
 * the same token, so EC2 hands back the machine it already made; a new attempt
 * has a new `attemptStartedAt` and so a new token. The zone is part of it because
 * EC2 refuses one token reused with different settings. EC2 allows 64
 * characters, which a SHA-256 in hex fills exactly.
 */
export function launchToken(
  row: Pick<VmRow, "userId" | "attemptStartedAt">,
  zone = 0,
): string {
  return createHash("sha256")
    .update(`${row.userId}\n${row.attemptStartedAt}\n${zone}`)
    .digest("hex");
}

/** The three states the setup screen tells apart. */
export function vmStatus(state: VmState | null): VmStatus {
  if (state === "ready") return "ready";
  if (state === "failed") return "failed";
  return "setting-up";
}
