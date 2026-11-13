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

const dataDir = process.env.COMPANION_DATA_DIR ?? "/data";
const port = Number(process.env.PORT ?? "3010");
const host = process.env.COMPANION_HOST ?? "127.0.0.1";

mkdirSync(dataDir, { recursive: true });
const daemon = await startDaemon({
  storePath: join(dataDir, "threads.db"),
  port,
  host,
});
console.log(`daemon ready on ${host}:${daemon.port}`);

// Stops children (Chrome, the screen, OpenCode) before the process exits.
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await daemon.close();
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
