/**
 * Runs one OpenCode turn over ACP and prints the session updates.
 * The recording is the fixture later tasks copy stored schemas from.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import type { RecordedSession } from "@companion/shared";

/** The word note.txt contains. The reply has to come back with this word. */
export const noteWord = "marigold";

const notePrompt = `Read note.txt in the working directory with a file-reading tool, then reply with only the exact word in that file.`;

/**
 * Chooses a one-time allow when the engine asks to run a tool.
 * An always-allow is the fallback. Anything else is cancelled.
 */
export function allowOnce(
  options: readonly acp.PermissionOption[],
): acp.RequestPermissionResponse {
  const optionId =
    options.find((option) => option.kind === "allow_once")?.optionId ??
    options.find((option) => option.kind === "allow_always")?.optionId;
  if (!optionId) {
    return { outcome: { outcome: "cancelled" } };
  }
  return { outcome: { outcome: "selected", optionId } };
}

/** The agent's visible reply, assembled from message chunks. */
export function replyText(updates: readonly acp.SessionUpdate[]): string {
  let text = "";
  for (const update of updates) {
    if (
      update.sessionUpdate === "agent_message_chunk" &&
      update.content.type === "text"
    ) {
      text += update.content.text;
    }
  }
  return text;
}

/** Whether the stream included a tool call the engine started. */
export function hasToolCall(updates: readonly acp.SessionUpdate[]): boolean {
  return updates.some((update) => update.sessionUpdate === "tool_call");
}

/** One terminal line for a session update. */
export function describeUpdate(update: acp.SessionUpdate): string {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "compaction_summary_chunk":
      return `${update.sessionUpdate} ${contentLabel(update.content)}`;
    case "tool_call":
      return `tool_call ${update.title} (${update.status ?? "pending"})`;
    case "tool_call_update":
      return `tool_call_update ${update.toolCallId} (${update.status ?? "updated"})`;
    case "plan":
      return `plan ${update.entries.length} entries`;
    case "available_commands_update":
      return `available_commands_update ${update.availableCommands.length}`;
    case "current_mode_update":
      return `current_mode_update ${update.currentModeId}`;
    case "config_option_update":
      return `config_option_update ${update.configOptions.length}`;
    case "session_info_update":
      return `session_info_update ${update.title ?? ""}`.trim();
    case "usage_update":
      return `usage_update ${update.used}/${update.size}`;
    case "notice":
      return `notice ${update.severity} ${update.title}`;
    case "compaction_update":
      return `compaction_update ${update.status}`;
    default: {
      const unexpected: never = update;
      return JSON.stringify(unexpected);
    }
  }
}

/**
 * Starts `opencode acp`, then initialize, session/new, and session/prompt.
 * Allows a tool once so the recording includes a finished tool call.
 */
export async function runAcpHello(options: {
  opencodeBin: string;
  recordPath?: string;
}): Promise<RecordedSession> {
  const workspace = await mkdtemp(join(tmpdir(), "acp-hello-"));
  const child = spawn(options.opencodeBin, ["acp"], {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const timeout = setTimeout(() => child.kill(), 180_000);

  try {
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      const missing = error.code === "ENOENT";
      console.error(
        missing ? `Could not start ${options.opencodeBin}.` : error.message,
      );
    });
    if (!child.stdin || !child.stdout) {
      throw new Error("opencode stdio was not piped");
    }

    await writeFile(join(workspace, "note.txt"), `${noteWord}\n`, "utf8");

    const permissions: RecordedSession["permissions"] = [];
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const recorded = await acp
      .client({ name: "companion" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
        const response = allowOnce(ctx.params.options);
        permissions.push({ request: ctx.params, response });
        const decision =
          response.outcome.outcome === "selected"
            ? response.outcome.optionId
            : "cancelled";
        console.log(`permission ${decision}`);
        return response;
      })
      .connectWith(stream, async (ctx) => {
        const initialize = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientInfo: { name: "companion", version: "0.0.0" },
        });
        const agent = initialize.agentInfo;
        console.log(
          `initialize ${agent?.name ?? "agent"} ${agent?.version ?? ""} protocol ${initialize.protocolVersion}`.trim(),
        );

        return ctx.buildSession(workspace).withSession(async (session) => {
          console.log(`session ${session.sessionId}`);
          const updates: acp.SessionUpdate[] = [];
          const pending = session.prompt(notePrompt);
          let promptResult: acp.PromptResponse | undefined;
          while (!promptResult) {
            const message = await session.nextUpdate();
            if (message.kind === "stop") {
              promptResult = message.response;
              console.log(`stop ${message.stopReason}`);
              break;
            }
            updates.push(message.update);
            console.log(describeUpdate(message.update));
          }
          return {
            initialize,
            newSession: session.newSessionResponse,
            updates,
            permissions,
            prompt: promptResult ?? (await pending),
          };
        });
      });

    const session = redactWorkspace(recorded, workspace);
    const reply = replyText(session.updates);
    if (!reply.includes(noteWord) || !hasToolCall(session.updates)) {
      throw new Error(
        "OpenCode did not return the word from note.txt and a tool call.",
      );
    }
    if (options.recordPath) {
      await writeRecording(options.recordPath, session);
    }
    return session;
  } finally {
    clearTimeout(timeout);
    child.kill();
    await rm(workspace, { recursive: true, force: true });
  }
}

/** Replaces this machine's workspace path so the fixture stays portable. */
export function redactWorkspace<T>(value: T, workspace: string): T {
  const json = JSON.stringify(value).split(workspace).join("{workspace}");
  return JSON.parse(json) as T;
}

/** Writes a session fixture, and refuses a file that looks like it contains a secret. */
async function writeRecording(
  recordPath: string,
  session: RecordedSession,
): Promise<void> {
  const json = `${JSON.stringify(session, null, 2)}\n`;
  if (/sk-[A-Za-z0-9]{8,}|api-subscription-key|BEGIN PRIVATE KEY/i.test(json)) {
    throw new Error(
      "Refusing to record a session that looks like it contains a secret.",
    );
  }
  await mkdir(dirname(recordPath), { recursive: true });
  await writeFile(recordPath, json, "utf8");
}

function contentLabel(content: acp.ContentBlock): string {
  switch (content.type) {
    case "text":
      return content.text;
    case "image":
      return "[image]";
    case "audio":
      return "[audio]";
    case "resource_link":
      return "[resource_link]";
    case "resource":
      return "[resource]";
    default: {
      const unexpected: never = content;
      return JSON.stringify(unexpected);
    }
  }
}

function recordPathFrom(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--record");
  if (index === -1) return undefined;
  const recordPath = argv[index + 1];
  if (!recordPath) throw new Error("--record needs a path");
  return recordPath;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  runAcpHello({
    opencodeBin: process.env.OPENCODE_BIN ?? "opencode",
    recordPath: recordPathFrom(process.argv),
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
