/**
 * Starts the daemon and the built web app for the chat's browser tests.
 * COMPANION_LIVE=1 uses OpenCode. Otherwise a scripted engine holds each
 * reply until the test releases it, so a reload can land mid-turn.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as acp from "@agentclientprotocol/sdk";
import { startDaemon } from "../src/api.js";
import { daemonUrlFile, gateFile } from "./chat-paths.js";

const here = dirname(fileURLToPath(import.meta.url));

const port = process.env.PORT ?? "3011";
const live = process.env.COMPANION_LIVE === "1";
// A recording can skip the gate and pause between chunks so the stream is visible.
const hold = process.env.COMPANION_CHAT_HOLD !== "0";
const paceMs = Number(process.env.COMPANION_DEMO_PACE_MS ?? "0");
const directory = mkdtempSync(join(tmpdir(), "companion-chat-"));

rmSync(gateFile, { force: true });

const daemon = await startDaemon({
  storePath: join(directory, "threads.db"),
  port: 0,
  engine: live ? undefined : heldEngine(),
});
writeFileSync(daemonUrlFile, daemon.url);

// The page no longer creates a bot when the list is empty. The browser tests
// start from a conversation, so this server makes the first one.
const seeded = await fetch(`${daemon.url}/bots`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Companion" }),
});
if (!seeded.ok) {
  console.error(await seeded.text());
  await daemon.close();
  rmSync(directory, { recursive: true, force: true });
  process.exit(1);
}

const nextBin = join(here, "../../web/node_modules/next/dist/bin/next");
const next = spawn(
  process.execPath,
  [nextBin, "start", "-H", "127.0.0.1", "-p", port],
  {
    cwd: join(here, "../../web"),
    env: { ...process.env, COMPANION_DAEMON_URL: daemon.url },
    stdio: "inherit",
  },
);

let stopping = false;
const stop = async (code: number) => {
  if (stopping) return;
  stopping = true;
  next.kill("SIGTERM");
  await daemon.close();
  rmSync(directory, { recursive: true, force: true });
  process.exit(code);
};

next.on("exit", (code) => {
  if (!stopping) void stop(code ?? 1);
});
process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));

/**
 * Replies in two beats. The first is immediate, so the page can show that
 * streaming started. The rest waits, so a test can reload before the turn ends.
 * A recording sets COMPANION_CHAT_HOLD=0 and pauses between chunks instead.
 */
function heldEngine() {
  return {
    async prompt(
      _botId: string,
      text: string,
      onUpdate: (update: acp.SessionUpdate) => void,
    ): Promise<acp.StopReason> {
      if (text.startsWith("Your name is")) {
        onUpdate({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Hello. What should I help with?",
          },
        });
        return "end_turn";
      }
      if (hold) rmSync(gateFile, { force: true });
      await pace();
      onUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Looking at the request." },
      });
      await pace();
      onUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Working on it.\n\n" },
      });
      if (hold) await waitForGate();
      await pace();
      onUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tool-read",
        title: "read note",
        name: "read",
        kind: "read",
        status: "pending",
        rawInput: { path: "note.txt" },
      });
      await pace();
      onUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-read",
        status: "completed",
        content: [
          {
            type: "content",
            content: { type: "text", text: "marigold" },
          },
        ],
      });
      await pace();
      onUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "**All finished.**" },
      });
      return "end_turn";
    },
    async close() {},
  };
}

/** Pauses between chunks when a recording asked for a visible stream. */
function pace(): Promise<void> {
  if (!Number.isFinite(paceMs) || paceMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, paceMs));
}

function waitForGate(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (!existsSync(gateFile)) return;
      clearInterval(timer);
      resolve();
    }, 30);
  });
}
