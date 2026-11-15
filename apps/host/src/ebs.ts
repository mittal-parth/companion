/**
 * Attaches users' data volumes to this host with its own instance role, which
 * may only touch volumes tagged as ours. A volume is formatted once, the first
 * time it is attached, and found afterwards by the device name EBS gives it.
 */
import { existsSync } from "node:fs";
import {
  AttachVolumeCommand,
  DescribeVolumesCommand,
  DetachVolumeCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import type { HostCommands, HostVolumes } from "@companion/shared/host";

/** Where this instance learns its own id and region, with the v2 token the metadata service requires. */
export async function instanceIdentity(): Promise<{
  instanceId: string;
  region: string;
}> {
  const base = "http://169.254.169.254/latest";
  const token = await (
    await fetch(`${base}/api/token`, {
      method: "PUT",
      headers: { "X-aws-ec2-metadata-token-ttl-seconds": "300" },
    })
  ).text();
  const read = async (path: string) =>
    (
      await fetch(`${base}/meta-data/${path}`, {
        headers: { "X-aws-ec2-metadata-token": token },
      })
    ).text();
  return {
    instanceId: await read("instance-id"),
    region: await read("placement/region"),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How the device appears on the host: Nitro names it after the volume id, dash removed. */
export function deviceFor(volumeId: string): string {
  return `/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${volumeId.replace("-", "")}`;
}

export async function createEbsVolumes(options: {
  commands: HostCommands;
}): Promise<HostVolumes> {
  const { instanceId, region } = await instanceIdentity();
  const ec2 = new EC2Client({ region });

  async function describe(volumeId: string) {
    const found = await ec2.send(
      new DescribeVolumesCommand({ VolumeIds: [volumeId] }),
    );
    const volume = found.Volumes?.[0];
    if (volume === undefined)
      throw new Error(`Volume ${volumeId} does not exist.`);
    return volume;
  }

  /** The first /dev/sdX name this instance has not used. */
  async function freeDeviceName(): Promise<string> {
    const mine = await ec2.send(
      new DescribeVolumesCommand({
        Filters: [{ Name: "attachment.instance-id", Values: [instanceId] }],
      }),
    );
    const used = new Set(
      (mine.Volumes ?? []).flatMap((volume) =>
        (volume.Attachments ?? []).map((attachment) => attachment.Device),
      ),
    );
    for (const letter of "fghijklmnopqrstuvwxyz") {
      if (!used.has(`/dev/sd${letter}`)) return `/dev/sd${letter}`;
    }
    throw new Error(
      "This instance has no free device name for another volume.",
    );
  }

  return {
    async attach(volumeId) {
      const volume = await describe(volumeId);
      const attachment = volume.Attachments?.[0];
      if (
        attachment?.InstanceId !== undefined &&
        attachment.InstanceId !== instanceId
      ) {
        throw new Error(
          `Volume ${volumeId} is still attached to ${attachment.InstanceId}.`,
        );
      }
      if (attachment === undefined) {
        await ec2.send(
          new AttachVolumeCommand({
            VolumeId: volumeId,
            InstanceId: instanceId,
            Device: await freeDeviceName(),
          }),
        );
      }
      const device = deviceFor(volumeId);
      for (let wait = 0; wait < 600 && !existsSync(device); wait++)
        await sleep(100);
      if (!existsSync(device)) throw new Error(`${device} did not appear.`);
      // A blank volume has no filesystem yet; make one the guest can mount.
      try {
        await options.commands.run("blkid", [
          "-p",
          "-o",
          "value",
          "-s",
          "TYPE",
          device,
        ]);
      } catch {
        await options.commands.run("mkfs.ext4", [
          "-q",
          "-L",
          "companion",
          device,
        ]);
      }
      return device;
    },

    async detach(volumeId) {
      const volume = await describe(volumeId);
      if (volume.Attachments?.[0]?.InstanceId !== instanceId) return;
      await ec2.send(
        new DetachVolumeCommand({ VolumeId: volumeId, InstanceId: instanceId }),
      );
      for (let wait = 0; wait < 240; wait++) {
        if ((await describe(volumeId)).State === "available") return;
        await sleep(1000);
      }
      throw new Error(`Volume ${volumeId} did not detach in time.`);
    },
  };
}
