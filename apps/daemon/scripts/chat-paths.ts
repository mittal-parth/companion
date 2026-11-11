/**
 * Files the chat's end-to-end server and its tests share.
 * The server writes them. The test reads them. Nothing else uses the paths.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The fake engine waits until the test creates this file, then finishes the turn. */
export const gateFile = join(tmpdir(), "companion-chat-gate");

/** The daemon URL, so a test can read back what the daemon stored. */
export const daemonUrlFile = join(tmpdir(), "companion-chat-daemon-url");
