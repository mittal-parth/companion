/**
 * What the control plane needs to know about a user's cloud computer: the
 * states it moves through, the ports `reconcile` talks to, and the one token
 * rule that keeps a repeated request from creating a second data volume.
 * The ports let tests run the whole state machine without AWS or a database.
 */
import { createHash } from "node:crypto";

/** The steps a computer goes through. `null` in the store means none was ever requested. */
export type VmState = "launching" | "booting" | "ready" | "failed";

/** What the setup screen shows. Everything not ready or failed is "setting-up". */
export type VmStatus = "setting-up" | "ready" | "failed";

/** One user's computer as stored: one row per user, because a user has one computer. */
export type VmRow = {
  userId: string;
  state: VmState;
  /** The user's data volume, set once it exists. It outlives every attempt. */
  volumeId: string | null;
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
    patch: { state: VmState; volumeId?: string | null },
  ): Promise<void>;
};

/**
 * Each user's data volume: the disk that holds their bots and files and
 * outlives every computer built on it. There is one per user, so it is found
 * by owner, not by attempt, and it is never deleted automatically.
 */
export type VmVolumes = {
  find(userId: string): Promise<string | null>;
  /** Creates it. Repeating the call for the same user returns the same volume. */
  create(userId: string): Promise<string>;
};

/** The machines that run computers. A host runs many users' computers side by side. */
export type VmHosts = {
  /**
   * Makes sure this user's computer is running on a host, on their volume.
   * Repeating it is harmless: a computer already starting or running is left
   * alone. Throws `NoCapacityError` when no host has room.
   */
  start(row: VmRow & { volumeId: string }): Promise<void>;
};

/** Thrown by `VmHosts.start` when no host has room for another computer. */
export class NoCapacityError extends Error {}

/** How `reconcile` reaches the daemon and reads the clock. */
export type ReconcileDeps = {
  store: VmStore;
  volumes: VmVolumes;
  hosts: VmHosts;
  /** True when the daemon answers through the relay. */
  probe(userId: string): Promise<boolean>;
  now(): number;
};

/** How long an attempt may take before it is given up and cleaned up. */
export const vmLaunchTimeoutMs = 10 * 60 * 1000;

/** How long a computer's relay token lasts. Revoking one early is a separate task. */
export const vmTokenLifetimeSeconds = 365 * 24 * 60 * 60;

/**
 * The idempotency token for creating a user's data volume. A user has one
 * volume, so the token depends on the user alone and a repeated create
 * returns the volume already made. EC2 allows 64 characters, which a SHA-256
 * in hex fills exactly.
 */
export function volumeToken(userId: string): string {
  return createHash("sha256").update(`volume\n${userId}`).digest("hex");
}

/** The three states the setup screen tells apart. */
export function vmStatus(state: VmState | null): VmStatus {
  if (state === "ready") return "ready";
  if (state === "failed") return "failed";
  return "setting-up";
}
