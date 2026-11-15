/**
 * Runs a user's computer as a Firecracker microVM under the jailer, and sets
 * up the network the guests share. Each microVM gets a read-only root
 * filesystem shared by all, the user's data volume as a block device, and a
 * tiny private drive holding what it must be told at boot (relay address and
 * token). Guests reach the internet through NAT but cannot reach each other,
 * the host, the VPC or the instance metadata address.
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ComputerRunner,
  HostCommands,
  RunSpec,
} from "@companion/shared/host";

export type FirecrackerOptions = {
  commands: HostCommands;
  firecrackerBin: string;
  jailerBin: string;
  kernelPath: string;
  /** The shared read-only root filesystem built from the x86 image. */
  rootfsPath: string;
  /** Holds per-computer files and the jailer's chroots. Must share a filesystem with the kernel and root image so they can be hard linked. */
  workDir: string;
  /** A root-only file of KEY=value lines added to every guest's environment, if present. */
  guestEnvFile?: string;
  memoryMiB: number;
  vcpus: number;
  /** An unprivileged user the microVM process drops to. */
  uid: number;
  gid: number;
};

/** The guests live in 100.64.0.0/16, a range the VPC never uses; each gets a /30. */
export const guestRange = "100.64.0.0/16";

/** The tap device and addresses for one slot. The host is .1 of its /30 and the guest is .2. */
export function guestNetwork(slot: number): {
  tap: string;
  hostIp: string;
  guestIp: string;
  mac: string;
} {
  if (!Number.isInteger(slot) || slot < 1 || slot > 16000) {
    throw new Error(`Slot ${slot} is out of range.`);
  }
  const base = slot * 4;
  const address = (offset: number) =>
    `100.64.${Math.floor((base + offset) / 256)}.${(base + offset) % 256}`;
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return {
    tap: `tap${slot}`,
    hostIp: address(1),
    guestIp: address(2),
    mac: `AA:FC:00:00:${hex(slot >> 8)}:${hex(slot & 255)}`,
  };
}

/** Where a guest may not send traffic: private ranges, the metadata address, and other guests. */
const blockedFromGuests = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "100.64.0.0/10",
];

export function createFirecrackerRunner(
  options: FirecrackerOptions,
): ComputerRunner {
  const { commands } = options;
  const jailerBase = join(options.workDir, "jailer");
  const idOf = (slot: number) => `cmp-${slot}`;
  const chrootOf = (slot: number) =>
    join(jailerBase, "firecracker", idOf(slot), "root");

  /** Adds an iptables rule only if it is not already there. */
  async function ensure(table: string, rule: string[], position?: number) {
    const base = table === "filter" ? [] : ["-t", table];
    const [chain, ...rest] = rule as [string, ...string[]];
    try {
      await commands.run("iptables", [...base, "-C", chain, ...rest]);
    } catch {
      await commands.run("iptables", [
        ...base,
        position === undefined ? "-A" : "-I",
        chain,
        ...(position === undefined ? [] : [String(position)]),
        ...rest,
      ]);
    }
  }

  async function isRunning(slot: number): Promise<boolean> {
    try {
      await commands.run("pgrep", ["-f", "--", `--id ${idOf(slot)} `]);
      return true;
    } catch {
      return false;
    }
  }

  return {
    async prepareHost() {
      await commands.run("sysctl", ["-w", "net.ipv4.ip_forward=1"]);
      await ensure("nat", [
        "POSTROUTING",
        "-s",
        guestRange,
        "!",
        "-d",
        guestRange,
        "-j",
        "MASQUERADE",
      ]);
      // The guests' own chain is rebuilt each time, so rule changes take hold on restart.
      await commands.run("iptables", ["-N", "COMPANION-GUEST"]).catch(() => {});
      await commands.run("iptables", ["-F", "COMPANION-GUEST"]);
      for (const range of blockedFromGuests) {
        await commands.run("iptables", [
          "-A",
          "COMPANION-GUEST",
          "-d",
          range,
          "-j",
          "DROP",
        ]);
      }
      await commands.run("iptables", ["-A", "COMPANION-GUEST", "-j", "ACCEPT"]);
      await ensure(
        "filter",
        ["FORWARD", "-i", "tap+", "-j", "COMPANION-GUEST"],
        1,
      );
      await ensure(
        "filter",
        [
          "FORWARD",
          "-o",
          "tap+",
          "-m",
          "conntrack",
          "--ctstate",
          "RELATED,ESTABLISHED",
          "-j",
          "ACCEPT",
        ],
        2,
      );
      // Nothing a guest sends is for the host itself.
      await ensure("filter", ["INPUT", "-i", "tap+", "-j", "DROP"], 1);
    },

    async start({ spec, slot, dataDevice }: RunSpec) {
      if (await isRunning(slot)) return;
      const id = idOf(slot);
      const net = guestNetwork(slot);
      const chroot = chrootOf(slot);
      const configDir = join(options.workDir, "config", id);
      // A leftover from a crashed start must not be reused.
      await this.stop(slot);
      mkdirSync(chroot, { recursive: true });

      await commands.run("ip", [
        "tuntap",
        "add",
        "dev",
        net.tap,
        "mode",
        "tap",
        "user",
        String(options.uid),
        "group",
        String(options.gid),
      ]);
      await commands.run("ip", [
        "addr",
        "add",
        `${net.hostIp}/30`,
        "dev",
        net.tap,
      ]);
      await commands.run("ip", ["link", "set", net.tap, "up"]);

      // The root image is read only and shared, so it is linked, not copied.
      await commands.run("ln", [options.kernelPath, join(chroot, "vmlinux")]);
      await commands.run("ln", [
        options.rootfsPath,
        join(chroot, "rootfs.ext4"),
      ]);

      // What the guest is told at boot, on a private drive only it can read.
      mkdirSync(configDir, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(configDir, "env"),
        guestEnvironment(spec, options.guestEnvFile),
        {
          mode: 0o600,
        },
      );
      await commands.run("mke2fs", [
        "-q",
        "-t",
        "ext4",
        "-F",
        "-d",
        configDir,
        join(chroot, "config.ext4"),
        "2M",
      ]);

      // The data volume appears inside the chroot as a device node of the same number.
      const numbers = (
        await commands.run("stat", ["-L", "-c", "%t %T", dataDevice])
      )
        .trim()
        .split(" ");
      await commands.run("mknod", [
        join(chroot, "data"),
        "b",
        `0x${numbers[0]}`,
        `0x${numbers[1]}`,
      ]);
      await commands.run("chown", [
        `${options.uid}:${options.gid}`,
        join(chroot, "data"),
        join(chroot, "config.ext4"),
      ]);
      await commands.run("chmod", ["660", join(chroot, "data")]);

      writeFileSync(
        join(chroot, "vm.json"),
        JSON.stringify(vmConfig(options, net)),
      );
      mkdirSync(join(options.workDir, "logs"), { recursive: true });
      commands.launch(
        options.jailerBin,
        [
          "--id",
          id,
          "--exec-file",
          options.firecrackerBin,
          "--uid",
          String(options.uid),
          "--gid",
          String(options.gid),
          "--chroot-base-dir",
          jailerBase,
          "--cgroup-version",
          "2",
          "--",
          "--no-api",
          "--config-file",
          "/vm.json",
        ],
        join(options.workDir, "logs", `${id}.log`),
      );
    },

    async stop(slot) {
      const id = idOf(slot);
      await commands.run("pkill", ["-f", "--", `--id ${id} `]).catch(() => {});
      for (let wait = 0; wait < 50 && (await isRunning(slot)); wait++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (await isRunning(slot)) {
        await commands
          .run("pkill", ["-9", "-f", "--", `--id ${id} `])
          .catch(() => {});
      }
      await commands
        .run("ip", ["link", "del", guestNetwork(slot).tap])
        .catch(() => {});
      rmSync(join(jailerBase, "firecracker", id), {
        recursive: true,
        force: true,
      });
      rmSync(join(options.workDir, "config", id), {
        recursive: true,
        force: true,
      });
    },
  };
}

/** The guest's boot environment: the relay it dials, plus any host-wide extras such as a model key. */
export function guestEnvironment(
  spec: { relayUrl: string; relayToken: string },
  extraFile?: string,
): string {
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  const lines = [
    `COMPANION_RELAY_URL=${quote(spec.relayUrl)}`,
    `COMPANION_VM_TOKEN=${quote(spec.relayToken)}`,
  ];
  if (extraFile !== undefined) {
    try {
      lines.push(readFileSync(extraFile, "utf8").trim());
    } catch {
      // No extras file on this host.
    }
  }
  return `${lines.join("\n")}\n`;
}

/** The Firecracker machine description for one computer. Paths are inside the jailer's chroot. */
export function vmConfig(
  options: Pick<FirecrackerOptions, "memoryMiB" | "vcpus">,
  net: { tap: string; hostIp: string; guestIp: string; mac: string },
) {
  return {
    "boot-source": {
      kernel_image_path: "/vmlinux",
      boot_args: [
        "console=ttyS0",
        "reboot=k",
        "panic=1",
        "pci=off",
        "ro",
        "init=/init",
        `ip=${net.guestIp}::${net.hostIp}:255.255.255.252::eth0:off`,
        "random.trust_cpu=on",
      ].join(" "),
    },
    drives: [
      {
        drive_id: "rootfs",
        path_on_host: "/rootfs.ext4",
        is_root_device: true,
        is_read_only: true,
      },
      {
        drive_id: "data",
        path_on_host: "/data",
        is_root_device: false,
        is_read_only: false,
      },
      {
        drive_id: "config",
        path_on_host: "/config.ext4",
        is_root_device: false,
        is_read_only: true,
      },
    ],
    "machine-config": {
      vcpu_count: options.vcpus,
      mem_size_mib: options.memoryMiB,
    },
    "network-interfaces": [
      { iface_id: "eth0", guest_mac: net.mac, host_dev_name: net.tap },
    ],
  };
}
