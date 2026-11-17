/**
 * Proves what the runner would do on a real host, by recording its commands:
 * guests are fenced from each other, the host, the VPC and the metadata
 * address; every microVM runs jailed with a read-only root and its own drives;
 * and the relay token reaches only the guest's private drive, never an
 * argument or the machine description.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostCommands } from "@companion/shared/host";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  createFirecrackerRunner,
  guestEnvironment,
  guestNetwork,
} from "../src/firecracker.js";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "companion-fc-"));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function recorder(options: { existing?: boolean; running?: boolean } = {}) {
  const ran: string[][] = [];
  const launched: { command: string; args: string[]; logFile: string }[] = [];
  const commands: HostCommands = {
    async run(command, args) {
      ran.push([command, ...args]);
      if (command === "stat") return "fc 0\n";
      if (command === "pgrep" && !options.running) throw new Error("none");
      if (command === "iptables" && args.includes("-C") && !options.existing) {
        throw new Error("no such rule");
      }
      return "";
    },
    launch(command, args, logFile) {
      launched.push({ command, args, logFile });
    },
  };
  return { commands, ran, launched };
}

function runnerWith(commands: HostCommands) {
  return createFirecrackerRunner({
    commands,
    firecrackerBin: "/usr/local/bin/firecracker",
    jailerBin: "/usr/local/bin/jailer",
    kernelPath: "/opt/vmlinux",
    rootfsPath: "/opt/rootfs.ext4",
    workDir: directory,
    memoryMiB: 2048,
    vcpus: 2,
    uid: 1001,
    gid: 1001,
  });
}

const run = {
  spec: {
    userId: "user-1",
    volumeId: "vol-0abc1234",
    relayUrl: "wss://relay.example.com",
    relayToken: "very-secret-token",
  },
  slot: 3,
  dataDevice: "/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_vol0abc1234",
};

test("every slot gets its own tap, /30 and MAC, inside the guests' range", () => {
  const seen = new Set<string>();
  for (let slot = 1; slot <= 300; slot++) {
    const net = guestNetwork(slot);
    expect(net.hostIp.startsWith("100.64.")).toBe(true);
    for (const value of [net.tap, net.hostIp, net.guestIp, net.mac]) {
      expect(seen.has(value)).toBe(false);
      seen.add(value);
    }
  }
  expect(guestNetwork(1)).toMatchObject({
    hostIp: "100.64.0.5",
    guestIp: "100.64.0.6",
  });
  expect(() => guestNetwork(0)).toThrow();
});

test("the guests' firewall blocks private ranges, the metadata address and other guests, then allows the internet", async () => {
  const { commands, ran } = recorder();
  await runnerWith(commands).prepareHost();
  const chain = ran
    .filter(
      (c) =>
        c[0] === "iptables" &&
        c.includes("COMPANION-GUEST") &&
        c.includes("-A"),
    )
    .map((c) => c.slice(3).join(" "));
  expect(chain).toEqual([
    "-d 10.0.0.0/8 -j DROP",
    "-d 172.16.0.0/12 -j DROP",
    "-d 192.168.0.0/16 -j DROP",
    "-d 169.254.0.0/16 -j DROP",
    "-d 100.64.0.0/10 -j DROP",
    "-j ACCEPT",
  ]);
  const text = ran.map((c) => c.join(" "));
  expect(text).toContain("sysctl -w net.ipv4.ip_forward=1");
  expect(text.some((c) => c.includes("MASQUERADE"))).toBe(true);
  expect(
    text.some((c) => c.startsWith("iptables -I INPUT 1 -i tap+ -j DROP")),
  ).toBe(true);
});

test("preparing the host twice does not duplicate rules that already exist", async () => {
  const { commands, ran } = recorder({ existing: true });
  await runnerWith(commands).prepareHost();
  const added = ran.filter(
    (c) =>
      c[0] === "iptables" &&
      (c.includes("-I") ||
        (c.includes("-A") && !c.includes("COMPANION-GUEST"))),
  );
  expect(added).toEqual([]);
});

test("a computer starts jailed, with a read-only root, its volume and a private config drive", async () => {
  const { commands, ran, launched } = recorder();
  await runnerWith(commands).start(run);
  const chroot = join(directory, "jailer", "firecracker", "cmp-3", "root");

  expect(launched).toHaveLength(1);
  const args = launched[0]!.args.join(" ");
  expect(launched[0]!.command).toBe("/usr/local/bin/jailer");
  expect(args).toContain("--id cmp-3");
  expect(args).toContain("--uid 1001 --gid 1001");
  expect(args).toContain("--no-api --config-file /vm.json");

  const config = JSON.parse(readFileSync(join(chroot, "vm.json"), "utf8")) as {
    drives: {
      drive_id: string;
      is_read_only: boolean;
      is_root_device: boolean;
    }[];
    "boot-source": { boot_args: string };
  };
  expect(config.drives.map((d) => [d.drive_id, d.is_read_only])).toEqual([
    ["rootfs", true],
    ["data", false],
    ["config", true],
  ]);
  expect(config["boot-source"].boot_args).toContain(
    "ip=100.64.0.14::100.64.0.13",
  );

  const text = ran.map((c) => c.join(" "));
  expect(text).toContain(`stat -L -c %t %T ${run.dataDevice}`);
  expect(text).toContain(`mknod ${join(chroot, "data")} b 0xfc 0x0`);
  expect(
    text.some((c) => c.startsWith("ip tuntap add dev tap3 mode tap user 1001")),
  ).toBe(true);
});

test("the relay token reaches only the guest's private config drive", async () => {
  const { commands, ran, launched } = recorder();
  await runnerWith(commands).start(run);
  const configDir = join(directory, "config", "cmp-3");
  const env = readFileSync(join(configDir, "env"), "utf8");
  expect(env).toContain("COMPANION_VM_TOKEN='very-secret-token'");
  expect(statSync(join(configDir, "env")).mode & 0o077).toBe(0);
  const everywhere = JSON.stringify([ran, launched]);
  expect(everywhere).not.toContain("very-secret-token");
  const chroot = join(directory, "jailer", "firecracker", "cmp-3", "root");
  expect(readFileSync(join(chroot, "vm.json"), "utf8")).not.toContain(
    "very-secret-token",
  );
});

test("a slot that already runs a microVM is left alone", async () => {
  const { commands, launched } = recorder({ running: true });
  await runnerWith(commands).start(run);
  expect(launched).toEqual([]);
});

test("stopping kills the microVM, removes its tap and its files", async () => {
  const { commands, ran } = recorder();
  const runner = runnerWith(commands);
  await runner.start(run);
  await runner.stop(3);
  const text = ran.map((c) => c.join(" "));
  expect(text).toContain("pkill -f -- --id cmp-3 ");
  expect(text).toContain("ip link del tap3");
  expect(() => statSync(join(directory, "config", "cmp-3"))).toThrow();
});

test("a value with a quote cannot break out of the guest's environment file", () => {
  const env = guestEnvironment({ relayUrl: "wss://x", relayToken: "a'b$(id)" });
  expect(env).toContain(`COMPANION_VM_TOKEN='a'\\''b$(id)'`);
});
