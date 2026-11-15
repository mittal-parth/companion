/**
 * The real pieces `reconcile` runs on: Supabase holds each user's computer
 * record, EBS holds each user's data volume, a host agent (reached through the
 * relay) runs the computer, and the relay says whether its daemon is up.
 * Everything here reads the web server's environment, never the browser's.
 *
 * With `COMPANION_DAEMON_URL` set (a laptop, self-hosting) there is no
 * provisioning at all and the app behaves as it did before accounts owned VMs.
 */
import {
  CreateVolumeCommand,
  DescribeVolumesCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import { signToken } from "@companion/shared/tunnel";
import {
  NoCapacityError,
  vmTokenLifetimeSeconds,
  volumeToken,
  type ReconcileDeps,
  type VmHosts,
  type VmRow,
  type VmState,
  type VmStore,
  type VmVolumes,
} from "@companion/shared/vm";
import { createClient } from "@supabase/supabase-js";
import { daemonFetch } from "./daemon";
import { e2eSessionOpen, supabaseConfig } from "./supabase/gate";
import { reconcile, type VmView } from "./vm";

/** The tags that tie a data volume to its owner. */
const tagKeys = {
  managed: "companion:managed",
  user: "companion:user",
} as const;

/** The size of each user's data volume, in GiB. */
const dataVolumeGiB = 20;

/** Whether this server gives each user a cloud computer. A direct daemon means no. */
export function provisioningEnabled(): boolean {
  if (e2eSessionOpen()) return false;
  return (process.env.COMPANION_RELAY_URL ?? "").trim() !== "";
}

/** Starts or continues the signed-in user's computer. Safe to call as often as needed. */
export async function ensureVm(userId: string): Promise<VmView> {
  return reconcile(userId, realDeps());
}

/** Starts a fresh attempt for a user whose last one failed. */
export async function retryVm(userId: string): Promise<VmView> {
  return reconcile(userId, realDeps(), true);
}

function setting(name: string): string {
  const value = (process.env[name] ?? "").trim();
  if (value === "") throw new Error(`Set ${name} to provision VMs.`);
  return value;
}

/** Whether this user's daemon answers through the relay. */
export async function relayProbe(userId: string): Promise<boolean> {
  try {
    const response = await daemonFetch(
      "/bots",
      { signal: AbortSignal.timeout(5000) },
      userId,
    );
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

let deps: ReconcileDeps | undefined;

function realDeps(): ReconcileDeps {
  deps ??= {
    store: supabaseStore(),
    volumes: ebsVolumes(),
    hosts: relayHosts(),
    probe: relayProbe,
    now: () => Date.now(),
  };
  return deps;
}

type VmRecord = {
  user_id: string;
  state: VmState;
  volume_id: string | null;
  attempt_started_at: string;
};

const vmColumns = "user_id, state, volume_id, attempt_started_at";

/** A user with no record has no computer yet. */
function toVmRow(record: VmRecord | null | undefined): VmRow | null {
  if (record == null) return null;
  return {
    userId: record.user_id,
    state: record.state,
    volumeId: record.volume_id,
    attemptStartedAt: record.attempt_started_at,
  };
}

/**
 * The record lives in the `vms` table, which the browser roles cannot touch.
 * The secret key skips row-level security, so only this server can read or
 * change it. Each claim is a single statement, so only one request wins.
 */
function supabaseStore(): VmStore {
  const config = supabaseConfig();
  if (config === null) throw new Error("Supabase is not configured.");
  const client = createClient(config.url, setting("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false },
  });
  return {
    async get(userId) {
      const { data, error } = await client
        .from("vms")
        .select(vmColumns)
        .eq("user_id", userId)
        .maybeSingle<VmRecord>();
      if (error) throw new Error(error.message);
      return toVmRow(data);
    },
    async claim(userId, retry) {
      // A retry keeps the user's volume: it is not part of the attempt.
      const attempt = {
        state: "launching",
        attempt_started_at: new Date().toISOString(),
      };
      // A new user: insert, and lose if a row already exists. A retry: take
      // over only a row that is still failed. Either is one atomic statement.
      const query = retry
        ? client
            .from("vms")
            .update(attempt)
            .eq("user_id", userId)
            .eq("state", "failed")
        : client
            .from("vms")
            .upsert(
              { user_id: userId, ...attempt },
              { onConflict: "user_id", ignoreDuplicates: true },
            );
      const { data, error } = await query.select(vmColumns);
      if (error) throw new Error(error.message);
      return toVmRow((data as VmRecord[] | null)?.[0]);
    },
    async update(row, patch) {
      const changes: Record<string, unknown> = { state: patch.state };
      if (patch.volumeId !== undefined) changes.volume_id = patch.volumeId;
      const { error } = await client
        .from("vms")
        .update(changes)
        .eq("user_id", row.userId)
        // Only the attempt that wrote this row may change it.
        .eq("attempt_started_at", row.attemptStartedAt);
      if (error) throw new Error(error.message);
    },
  };
}

/**
 * The users' data volumes, in the VM account. Calls go through the provisioner
 * role when one is named, so the control plane holds no standing power over
 * them. A volume lives in the host's zone, because it can only attach there.
 */
export function ebsVolumes(): VmVolumes {
  const roleArn = (process.env.COMPANION_PROVISIONER_ROLE_ARN ?? "").trim();
  const ec2 = new EC2Client({
    region: setting("COMPANION_VM_REGION"),
    credentials:
      roleArn === ""
        ? undefined
        : fromTemporaryCredentials({
            params: { RoleArn: roleArn, RoleSessionName: "companion-web" },
          }),
  });
  return {
    async find(userId) {
      const found = await ec2.send(
        new DescribeVolumesCommand({
          Filters: [
            { Name: `tag:${tagKeys.user}`, Values: [userId] },
            { Name: `tag:${tagKeys.managed}`, Values: ["true"] },
          ],
        }),
      );
      return found.Volumes?.[0]?.VolumeId ?? null;
    },
    async create(userId) {
      const created = await ec2.send(
        new CreateVolumeCommand({
          // Repeating the call for this user returns the volume already made.
          ClientToken: volumeToken(userId),
          AvailabilityZone: setting("COMPANION_HOST_AZ"),
          Size: dataVolumeGiB,
          VolumeType: "gp3",
          Encrypted: true,
          TagSpecifications: [
            {
              ResourceType: "volume",
              Tags: [
                { Key: tagKeys.managed, Value: "true" },
                { Key: tagKeys.user, Value: userId },
              ],
            },
          ],
        }),
      );
      if (created.VolumeId === undefined) {
        throw new Error("EC2 returned no volume.");
      }
      return created.VolumeId;
    },
  };
}

/**
 * The host that runs computers. Its agent dials the relay like a daemon does,
 * under its own id, so the host needs no inbound port. Each start carries what
 * the new computer reads on boot: where the relay is, and a token that lets
 * this one daemon connect. The agent hands them to the computer privately, and
 * the daemon removes the token from its own environment once it has read it.
 */
export function relayHosts(): VmHosts {
  return {
    async start(row) {
      const relay = setting("COMPANION_RELAY_URL").replace(/^http/, "ws");
      const exp = Math.floor(Date.now() / 1000) + vmTokenLifetimeSeconds;
      const token = signToken(
        { role: "vm", vm: row.userId, exp },
        setting("COMPANION_RELAY_SECRET"),
      );
      const response = await daemonFetch(
        "/computers",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            userId: row.userId,
            volumeId: row.volumeId,
            relayUrl: relay.replace(/\/$/, ""),
            relayToken: token,
          }),
          signal: AbortSignal.timeout(15_000),
        },
        process.env.COMPANION_HOST_ID?.trim() || "host-1",
      );
      await response.body?.cancel();
      // The agent answers 507 when it has no room for another computer.
      if (response.status === 507) throw new NoCapacityError("no room");
      if (!response.ok) {
        throw new Error(`The host answered ${response.status}.`);
      }
    },
  };
}
