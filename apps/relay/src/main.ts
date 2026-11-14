/**
 * Runs the relay as a program, for its container behind the load balancer.
 * The shared secret comes from the environment and is never logged.
 */
import { startRelay } from "./relay.js";

const secret = (process.env.RELAY_SECRET ?? "").trim();
if (secret.length < 32) {
  throw new Error("Set RELAY_SECRET to at least 32 characters.");
}
const relay = await startRelay({
  port: Number(process.env.PORT ?? "8080"),
  host: process.env.RELAY_HOST ?? "0.0.0.0",
  secret,
  log: (line) => console.log(line),
});
console.log(`relay ready on :${relay.port}`);

// Fargate sends SIGTERM before stopping a task; closing drops VM sockets so
// they reconnect to the replacement straight away.
const stop = () => void relay.close().then(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
