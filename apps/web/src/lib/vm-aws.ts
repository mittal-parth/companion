/**
 * The real pieces `reconcile` runs on: Supabase holds each user's computer
 * record, EC2 holds the machine, and the relay says whether its daemon is up.
 * Everything here reads the web server's environment, never the browser's.
 *
 * With `COMPANION_DAEMON_URL` set (a laptop, self-hosting) there is no
 * provisioning at all and the app behaves as it did before accounts owned VMs.
 */
import {
  DescribeInstancesCommand,
  EC2Client,
  ModifyInstanceAttributeCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import { signToken } from "@companion/shared/tunnel";
import {
  launchToken,
  NoCapacityError,
  vmTokenLifetimeSeconds,
  type InstanceState,
  type ReconcileDeps,
  type VmCloud,
  type VmRow,
  type VmState,
  type VmStore,
} from "@companion/shared/vm";
import { createClient } from "@supabase/supabase-js";
import { daemonFetch } from "./daemon";
import { e2eSessionOpen, supabaseConfig } from "./supabase/gate";
import { reconcile, type VmView } from "./vm";

/** The tags that tie a machine to its owner and to one attempt. */
const tagKeys = {
  managed: "companion:managed",
  user: "companion:user",
  attemptStarted: "companion:attempt-started",
} as const;

/** The data disk the launch template attaches. A failed attempt gives it up with the machine. */
const dataDevice = "/dev/sdf";

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
    cloud: ec2Cloud(),
    probe: relayProbe,
    now: () => Date.now(),
  };
  return deps;
}

type VmRecord = {
  user_id: string;
  state: VmState;
  instance_id: string | null;
  attempt_started_at: string;
};

const vmColumns = "user_id, state, instance_id, attempt_started_at";

/** A user with no record has no computer yet. */
function toVmRow(record: VmRecord | null | undefined): VmRow | null {
  if (record == null) return null;
  return {
    userId: record.user_id,
    state: record.state,
    instanceId: record.instance_id,
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
      const attempt = {
        state: "launching",
        instance_id: null,
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
      if (patch.instanceId !== undefined)
        changes.instance_id = patch.instanceId;
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
 * The machines, in the VM account. Calls go through the provisioner role when
 * one is named, so the control plane holds no standing power over them.
 */
export function ec2Cloud(): VmCloud {
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
  const subnets = setting("COMPANION_VM_SUBNETS").split(",");
  const tagFilters = (row: VmRow) => [
    { Name: `tag:${tagKeys.user}`, Values: [row.userId] },
    { Name: `tag:${tagKeys.attemptStarted}`, Values: [row.attemptStartedAt] },
    {
      Name: "instance-state-name",
      Values: ["pending", "running", "stopping", "stopped"],
    },
  ];
  return {
    zones: subnets.length,
    async find(row) {
      const found = await ec2.send(
        new DescribeInstancesCommand({ Filters: tagFilters(row) }),
      );
      const id = found.Reservations?.[0]?.Instances?.[0]?.InstanceId;
      return id === undefined ? null : { id };
    },
    async launch(row, zone) {
      const tags = [
        { Key: tagKeys.managed, Value: "true" },
        { Key: tagKeys.user, Value: row.userId },
        { Key: tagKeys.attemptStarted, Value: row.attemptStartedAt },
      ];
      try {
        const launched = await ec2.send(
          new RunInstancesCommand({
            ClientToken: launchToken(row, zone),
            MinCount: 1,
            MaxCount: 1,
            ImageId: setting("COMPANION_VM_AMI"),
            LaunchTemplate: {
              LaunchTemplateId: setting("COMPANION_VM_LAUNCH_TEMPLATE_ID"),
              Version: "$Latest",
            },
            SubnetId: subnets[zone],
            UserData: Buffer.from(bootConfig(row)).toString("base64"),
            TagSpecifications: ["instance", "volume"].map((type) => ({
              ResourceType: type as "instance" | "volume",
              Tags: tags,
            })),
          }),
        );
        const id = launched.Instances?.[0]?.InstanceId;
        if (id === undefined) throw new Error("EC2 returned no instance.");
        return id;
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === "InsufficientInstanceCapacity"
        ) {
          throw new NoCapacityError(error.message);
        }
        throw error;
      }
    },
    async describe(instanceId): Promise<InstanceState> {
      const found = await ec2
        .send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }))
        .catch((error: unknown) => {
          // An id EC2 no longer knows is a machine that is gone.
          if (
            error instanceof Error &&
            error.name === "InvalidInstanceID.NotFound"
          ) {
            return undefined;
          }
          throw error;
        });
      const state = found?.Reservations?.[0]?.Instances?.[0]?.State?.Name;
      if (state === "pending" || state === "running") return state;
      return "gone";
    },
    async destroy(instanceId) {
      // The data disk normally outlives its machine. This one never held user
      // data, so it goes too, instead of sitting there billing.
      await ec2
        .send(
          new ModifyInstanceAttributeCommand({
            InstanceId: instanceId,
            BlockDeviceMappings: [
              {
                DeviceName: dataDevice,
                Ebs: { DeleteOnTermination: true },
              },
            ],
          }),
        )
        .catch((error: unknown) => {
          console.error("could not mark the data disk for deletion", error);
        });
      await ec2.send(
        new TerminateInstancesCommand({ InstanceIds: [instanceId] }),
      );
    },
  };
}

/**
 * What the machine reads on its first boot: where the relay is and the token
 * that lets this one daemon connect. cloud-init writes it as a root-only file
 * before the daemon container starts. The daemon removes the token from its
 * own environment once it has read it, so bots never inherit it.
 */
function bootConfig(row: VmRow): string {
  const relay = setting("COMPANION_RELAY_URL").replace(/^http/, "ws");
  // Counted from the attempt, not from now, so a repeated launch for the same
  // attempt sends identical settings and EC2 accepts it as the same request.
  const exp =
    Math.floor(Date.parse(row.attemptStartedAt) / 1000) +
    vmTokenLifetimeSeconds;
  const token = signToken(
    { role: "vm", vm: row.userId, exp },
    setting("COMPANION_RELAY_SECRET"),
  );
  return [
    "#cloud-config",
    "write_files:",
    "  - path: /etc/companion-vm.env",
    '    permissions: "0600"',
    "    content: |",
    `      COMPANION_RELAY_URL=${relay.replace(/\/$/, "")}`,
    `      COMPANION_VM_TOKEN=${token}`,
    "",
  ].join("\n");
}
