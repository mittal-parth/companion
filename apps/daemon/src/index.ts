/**
 * The daemon is the ACP client that hosts the user's bots.
 * `startDaemon` is the local API: one conversation per bot.
 */
export const daemonRole = "acp-client" as const;

export { startDaemon, type Daemon, type DaemonOptions } from "./api.js";
