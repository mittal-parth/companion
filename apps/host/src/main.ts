/**
 * Runs the host agent on the EC2 host. It dials the relay under the host's own
 * id, so the web server can ask it to start computers without any inbound
 * port, and it listens only on 127.0.0.1 for the relay's forwarded requests.
 */
import { execFile, spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { startTunnel } from "@companion/shared/tunnel-client";
import type { HostCommands } from "@companion/shared/host";
import { createHostAgent } from "./agent.js";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { createEbsVolumes, instanceIdentity } from "./ebs.js";
import { createFirecrackerRunner } from "./firecracker.js";

const env = (name: string, fallback?: string): string => {
  const value = (process.env[name] ?? fallback ?? "").trim();
  if (value === "") throw new Error(`Set ${name}.`);
  return value;
};

const commands: HostCommands = {
  run: (command, args) =>
    new Promise((resolve, reject) => {
      execFile(command, args, (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(
              `${command} ${args.join(" ")}: ${stderr || error.message}`,
            ),
          );
        else resolve(stdout);
      });
    }),
  launch(command, args, logFile) {
    const out = openSync(logFile, "a");
    spawn(command, args, {
      detached: true,
      stdio: ["ignore", out, out],
    }).unref();
  },
};

const log = (line: string) => console.log(line);
const dir = env("COMPANION_HOST_DIR", "/var/lib/companion-host");
mkdirSync(dir, { recursive: true });

/**
 * The host's relay token and any extra guest settings live in Parameter Store,
 * not in the image or the launch settings. The instance role may read only these.
 */
async function parameter(
  name: string,
  optional = false,
): Promise<string | undefined> {
  const prefix = env("COMPANION_HOST_PARAMS_PREFIX");
  const ssm = new SSMClient({ region: (await instanceIdentity()).region });
  try {
    const got = await ssm.send(
      new GetParameterCommand({
        Name: `${prefix}/${name}`,
        WithDecryption: true,
      }),
    );
    return got.Parameter?.Value;
  } catch (error) {
    if (optional && (error as Error).name === "ParameterNotFound")
      return undefined;
    throw error;
  }
}
const token = (await parameter("token")) as string;
// Keys a guest needs until the LLM proxy (Task 5.1) removes the need. Root-only on the host.
const guestEnv = await parameter("guest-env", true);
const guestEnvFile = `${dir}/guest.env`;
if (guestEnv !== undefined)
  writeFileSync(guestEnvFile, guestEnv, { mode: 0o600 });

const runner = createFirecrackerRunner({
  commands,
  firecrackerBin: env(
    "COMPANION_FIRECRACKER_BIN",
    "/usr/local/bin/firecracker",
  ),
  jailerBin: env("COMPANION_JAILER_BIN", "/usr/local/bin/jailer"),
  kernelPath: env("COMPANION_GUEST_KERNEL", `${dir}/vmlinux`),
  rootfsPath: env("COMPANION_GUEST_ROOTFS", `${dir}/rootfs.ext4`),
  workDir: dir,
  guestEnvFile: guestEnv === undefined ? undefined : guestEnvFile,
  memoryMiB: Number(env("COMPANION_GUEST_MEM_MIB", "2048")),
  vcpus: Number(env("COMPANION_GUEST_VCPUS", "2")),
  uid: 1001,
  gid: 1001,
});
await runner.prepareHost();
const agent = createHostAgent({
  runner,
  volumes: await createEbsVolumes({ commands }),
  stateFile: `${dir}/computers.json`,
  capacity: Number(env("COMPANION_HOST_CAPACITY", "12")),
  log,
});
agent.restore();

const server = createServer((req, res) => {
  void agent.handle(req, res).catch((error: unknown) => {
    log(`request failed: ${String(error)}`);
    if (!res.headersSent)
      res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "The host agent failed." }));
  });
});
await new Promise<void>((resolve) =>
  server.listen(Number(env("PORT", "3020")), "127.0.0.1", resolve),
);
const address = server.address();
if (address === null || typeof address === "string")
  throw new Error("No port bound.");

const tunnel = startTunnel({
  relayUrl: env("COMPANION_RELAY_URL"),
  token: () => token,
  target: `http://127.0.0.1:${address.port}`,
  log,
});
log(`host agent ready on 127.0.0.1:${address.port}`);

// Computers keep running if the agent stops; it finds them again on restart.
const stop = () => {
  tunnel.close();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
