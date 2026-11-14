/**
 * Runs the daemon as a program, for the container and the cloud VM.
 *
 * Everything the daemon keeps lives under one data directory, so mounting a
 * disk there carries bots, conversations and the Chrome profile across image
 * updates. Settings come from the environment and nothing is read from a file
 * in the image.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startDaemon } from "./api.js";
import { startTunnel } from "./tunnel.js";

const dataDir = process.env.COMPANION_DATA_DIR ?? "/data";
const port = Number(process.env.PORT ?? "3010");
const host = process.env.COMPANION_HOST ?? "127.0.0.1";

// A new VM has no model key yet: it receives one from the control plane after
// it boots (Task 5.1). The daemon must still start, so it can report ready and
// reach the relay. A turn run before then fails at the provider, not here.
if ((process.env.SARVAM_API_KEY ?? "").trim() === "") {
  process.env.SARVAM_API_KEY = "not-configured";
  console.warn("SARVAM_API_KEY is not set. Turns will fail until it is.");
}

mkdirSync(dataDir, { recursive: true });
const daemon = await startDaemon({
  storePath: join(dataDir, "threads.db"),
  port,
  host,
});
console.log(`daemon ready on ${host}:${daemon.port}`);

// In the cloud the VM accepts no inbound connections, so the daemon dials the
// relay instead. Locally there is no relay and nothing here runs.
const relayUrl = (process.env.COMPANION_RELAY_URL ?? "").trim();
const vmToken = (process.env.COMPANION_VM_TOKEN ?? "").trim();
if (relayUrl !== "" && vmToken === "") {
  throw new Error("COMPANION_RELAY_URL needs COMPANION_VM_TOKEN.");
}
const tunnel =
  relayUrl === ""
    ? undefined
    : startTunnel({
        relayUrl,
        token: () => vmToken,
        target: daemon.url,
        log: (line) => console.log(line),
      });

// Stops children (Chrome, the screen, OpenCode) before the process exits.
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  tunnel?.close();
  await daemon.close();
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
