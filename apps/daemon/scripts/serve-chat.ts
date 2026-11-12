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
import type { ApprovalDecision } from "@companion/shared";
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
    env: {
      ...process.env,
      COMPANION_DAEMON_URL: daemon.url,
      // Opens the app only when this build has no Supabase keys, so CI can
      // still reach the daemon. A build with the keys ignores it.
      COMPANION_E2E_SESSION: "1",
    },
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
  const pending = new Map<string, (decision: ApprovalDecision) => void>();
  return {
    async prompt(
      _botId: string,
      text: string,
      onUpdate: (update: acp.SessionUpdate) => void,
      _images?: readonly unknown[],
      onApproval?: (approval: {
        sessionId: string;
        toolCallId: string;
        title?: string;
      }) => void,
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
      if (text === "Read the vault") {
        return askForVault(onUpdate, onApproval, pending);
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
      // The tool starts before the gate so a test can see the page leave it
      // out of the thread, during the reply and after it finishes.
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
      if (hold) await waitForGate();
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
    answer(_botId: string, toolCallId: string, decision: ApprovalDecision) {
      const resolve = pending.get(toolCallId);
      if (resolve === undefined) return false;
      pending.delete(toolCallId);
      resolve(decision);
      return true;
    },
    async close() {},
  };
}

/**
 * One tool call that waits for Allow or Deny.
 * Deny fails the call and does not reveal the vault. Allow finishes it.
 */
function askForVault(
  onUpdate: (update: acp.SessionUpdate) => void,
  onApproval:
    | ((approval: {
        sessionId: string;
        toolCallId: string;
        title?: string;
      }) => void)
    | undefined,
  pending: Map<string, (decision: ApprovalDecision) => void>,
): Promise<acp.StopReason> {
  const toolCallId = "tool-vault";
  const secret = "cobalt";
  onUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "This step needs a decision.\n\n" },
  });
  onUpdate({
    sessionUpdate: "tool_call",
    toolCallId,
    title: "read vault",
    name: "read",
    kind: "read",
    status: "pending",
    rawInput: { path: "vault.txt" },
  });
  return new Promise((resolve) => {
    pending.set(toolCallId, (decision) => {
      if (decision === "deny") {
        onUpdate({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "failed",
          rawOutput: { error: "The user declined this tool call" },
        });
        resolve("cancelled");
        return;
      }
      onUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        content: [
          {
            type: "content",
            content: { type: "text", text: secret },
          },
        ],
      });
      onUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `**${secret}**` },
      });
      resolve("end_turn");
    });
    onApproval?.({
      sessionId: "scripted",
      toolCallId,
      title: "read vault",
    });
  });
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
