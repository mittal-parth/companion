/**
 * What the control plane and a host agree on. The web server asks a host to
 * start one user's computer with a `ComputerSpec`; the host agent keeps each
 * computer's record, finds a data volume's device, and runs the microVM. The
 * runner and the volume service are ports so the agent's rules (one computer
 * per user, capacity, restart recovery) are tested without Firecracker or AWS.
 */

/** Everything a host needs to start one user's computer. */
export type ComputerSpec = {
  userId: string;
  /** The user's EBS data volume. The computer mounts it at /data. */
  volumeId: string;
  /** The relay's websocket address, which the computer's daemon dials. */
  relayUrl: string;
  /** Lets that one daemon connect. It reaches the computer privately and is never logged. */
  relayToken: string;
};

/** The two steps of starting: the record exists at once, the microVM follows. */
export type ComputerStatus = "starting" | "running";

/** What a host reports about a computer it holds. The token is never included. */
export type ComputerView = {
  userId: string;
  volumeId: string;
  slot: number;
  status: ComputerStatus;
};

/** Thrown when a host has no room for another computer. The agent answers 507. */
export class HostFullError extends Error {}

/** Reads a start request, or says what is wrong with it. */
export function parseComputerSpec(input: unknown): ComputerSpec {
  if (typeof input !== "object" || input === null) {
    throw new Error("The request must be a JSON object.");
  }
  const record = input as Record<string, unknown>;
  const field = (name: string): string => {
    const value = record[name];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`${name} must be a non-empty string.`);
    }
    return value;
  };
  const userId = field("userId");
  // The id becomes part of file names and process arguments, so it is held to
  // the shape of a UUID or a short slug and nothing that could escape one.
  if (!/^[A-Za-z0-9-]{1,64}$/.test(userId)) {
    throw new Error("userId may only hold letters, digits and dashes.");
  }
  const volumeId = field("volumeId");
  if (!/^vol-[0-9a-f]{8,17}$/.test(volumeId)) {
    throw new Error("volumeId must look like an EBS volume id.");
  }
  const relayUrl = field("relayUrl");
  if (!/^wss?:\/\//.test(relayUrl)) {
    throw new Error("relayUrl must be a ws:// or wss:// address.");
  }
  return { userId, volumeId, relayUrl, relayToken: field("relayToken") };
}

/** One microVM, as the runner is asked to run it. */
export type RunSpec = {
  spec: ComputerSpec;
  /** A small number, unique on this host while the computer exists. It fixes the tap name and addresses. */
  slot: number;
  /** The block device holding the user's data volume. */
  dataDevice: string;
};

/** Runs microVMs on this host. Every call is safe to repeat. */
export type ComputerRunner = {
  /** One-time host setup: forwarding and the guests' firewall. */
  prepareHost(): Promise<void>;
  /** Starts the microVM, or does nothing if that slot already runs one. */
  start(run: RunSpec): Promise<void>;
  /** Stops the microVM and removes its network device and files. */
  stop(slot: number): Promise<void>;
};

/** Attaches users' data volumes to this host. */
export type HostVolumes = {
  /** Attaches the volume if needed, formats it if blank, and returns its device. */
  attach(volumeId: string): Promise<string>;
  /** Detaches it so another host could attach it. */
  detach(volumeId: string): Promise<void>;
};

/**
 * How the runner touches the machine: run a command and wait, or start one
 * that keeps running. Tests replace it to see exactly what would have run.
 */
export type HostCommands = {
  /** Runs a program and returns its output. Rejects when it exits non-zero. */
  run(command: string, args: string[]): Promise<string>;
  /** Starts a program that outlives this call, appending its output to `logFile`. */
  launch(command: string, args: string[], logFile: string): void;
};
