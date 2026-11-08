/**
 * Runs each bot's conversation on one OpenCode process.
 * The first prompt starts the session. A later prompt continues it.
 * After a restart, the stored session id is loaded instead of replaced.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { ThreadStore } from "./thread-store.js";
import { botConversation } from "./thread-store.js";
import { approvalResponse } from "./approval.js";

/**
 * OpenCode's free model. It needs no API key.
 * On the last live run OpenCode refused it with "Free usage limit reached".
 * A keyed provider has to replace this before that run can pass. See docs/phase-2-1.md.
 */
export const freeOpencodeModel = "opencode/big-pickle";

const turnTimeoutMs = 180_000;

/**
 * The project file OpenCode reads for which model a conversation uses.
 * The same file is written into the bot's folder and into the process config.
 */
export function opencodeModelConfig(model: string): string {
  return `${JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      model,
    },
    null,
    2,
  )}\n`;
}

/** Speaks ACP for the daemon. One prompt is one turn of a bot's conversation. */
export type Engine = {
  prompt(
    botId: string,
    text: string,
    onUpdate: (update: acp.SessionUpdate) => void,
  ): Promise<acp.StopReason>;
  close(): Promise<void>;
};

/**
 * Starts `opencode acp` and keeps it for the life of the daemon.
 * Sessions are stored under `dataHome` so a later process can load them.
 */
export async function startOpencodeEngine(options: {
  store: ThreadStore;
  bin: string;
  model: string;
  dataHome: string;
  configHome: string;
}): Promise<Engine> {
  mkdirSync(join(options.configHome, "opencode"), { recursive: true });
  writeFileSync(
    join(options.configHome, "opencode", "opencode.json"),
    opencodeModelConfig(options.model),
  );
  mkdirSync(options.dataHome, { recursive: true });

  const env = { ...process.env };
  delete env.OPENCODE_DISABLE_FREE_MODELS;
  delete env.OPENCODE_CONFIG;
  delete env.OPENCODE_CONFIG_DIR;
  env.XDG_CONFIG_HOME = options.configHome;
  env.XDG_DATA_HOME = options.dataHome;

  const child = spawn(
    options.bin,
    ["acp", "--print-logs", "--log-level", "ERROR"],
    {
      cwd: options.dataHome,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    },
  );
  let stderr = "";
  let reportProviderError: ((error: Error) => void) | undefined;
  const providerError = new Promise<never>((_resolve, reject) => {
    reportProviderError = reject;
  });
  void providerError.catch(() => undefined);
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderr = `${stderr}${text}`.slice(-8000);
    // OpenCode keeps the prompt open after this refusal, so end the turn here.
    if (reportProviderError && /Free usage limit reached/i.test(stderr)) {
      reportProviderError(
        new Error(
          "OpenCode's free model is unavailable: free usage limit reached.",
        ),
      );
      reportProviderError = undefined;
    }
  });

  if (!child.stdin || !child.stdout) {
    stopChild(child);
    throw new Error("OpenCode stdio was not piped.");
  }

  const listeners = new Map<string, (update: acp.SessionUpdate) => void>();
  const openSessions = new Set<string>();
  let starting = true;
  let startupFailed = false;
  let failStartup: (error: Error) => void = () => {};
  const failed = new Promise<never>((_resolve, reject) => {
    failStartup = reject;
  });
  // The race during startup handles this. A later exit must not become unhandled.
  void failed.catch(() => undefined);

  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const connection = acp
    .client({ name: "companion" })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
      return approvalResponse(ctx.params.options, "allow");
    })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      listeners.get(ctx.params.sessionId)?.(ctx.params.update);
    })
    .connect(stream);
  const noteExit = (error: Error) => {
    if (starting && !startupFailed) {
      startupFailed = true;
      failStartup(error);
    }
    connection.close(error);
  };
  child.once("error", (error: Error) => {
    noteExit(error);
  });
  child.on("exit", (code, signal) => {
    noteExit(
      new Error(
        `OpenCode exited (${code ?? signal ?? "unknown"}).${stderr.trim() === "" ? "" : `\n${stderr.trim()}`}`,
      ),
    );
  });

  const agent = connection.agent;
  const initialized = agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientInfo: { name: "companion", version: "0.0.0" },
  });
  void initialized.catch(() => undefined);
  try {
    await Promise.race([initialized, failed]);
  } catch (error) {
    starting = false;
    stopChild(child);
    connection.close(error);
    throw withStderr(error, stderr);
  }
  starting = false;

  return {
    async prompt(botId, text, onUpdate) {
      const sessionId = await openSession(
        agent,
        options.store,
        options.model,
        openSessions,
        botId,
      );
      listeners.set(sessionId, onUpdate);
      const signal = AbortSignal.timeout(turnTimeoutMs);
      const cancel = () => {
        void agent
          .notify(acp.methods.agent.session.cancel, { sessionId })
          .catch(() => undefined);
      };
      signal.addEventListener("abort", cancel);
      const request = agent.request(
        acp.methods.agent.session.prompt,
        {
          sessionId,
          prompt: [{ type: "text", text }],
        },
        { cancellationSignal: signal, stopWaitingOnCancel: true },
      );
      void request.catch(() => undefined);
      try {
        const response = await Promise.race([request, providerError]);
        return response.stopReason;
      } catch (error) {
        if (!signal.aborted) cancel();
        throw withStderr(error, stderr);
      } finally {
        signal.removeEventListener("abort", cancel);
        listeners.delete(sessionId);
      }
    },

    async close() {
      connection?.close();
      stopChild(child);
      await exited(child);
    },
  };
}

/**
 * Uses the session this process already opened, loads one a restart stored,
 * or starts a session in the bot's folder.
 */
async function openSession(
  agent: acp.ClientContext,
  store: ThreadStore,
  model: string,
  openSessions: Set<string>,
  botId: string,
): Promise<string> {
  const thread = botConversation(store, botId);
  if (thread.engine !== "opencode") {
    throw new Error("This daemon only runs OpenCode.");
  }
  if (thread.sessionId !== null && openSessions.has(thread.sessionId)) {
    return thread.sessionId;
  }
  if (thread.sessionId !== null) {
    const loaded = await agent.request(acp.methods.agent.session.load, {
      sessionId: thread.sessionId,
      cwd: thread.cwd,
      mcpServers: [],
    });
    await selectModel(agent, thread.sessionId, model, loaded.configOptions);
    openSessions.add(thread.sessionId);
    return thread.sessionId;
  }

  const created = await agent.request(acp.methods.agent.session.new, {
    cwd: thread.cwd,
    mcpServers: [],
  });
  store.attachSession(thread.id, created.sessionId);
  await selectModel(agent, created.sessionId, model, created.configOptions);
  openSessions.add(created.sessionId);
  return created.sessionId;
}

/** Points the session at the free model when OpenCode started on another one. */
async function selectModel(
  agent: acp.ClientContext,
  sessionId: string,
  model: string,
  configOptions: readonly acp.SessionConfigOption[] | null | undefined,
): Promise<void> {
  const option = configOptions?.find((item) => item.id === "model");
  if (option === undefined) {
    await setModel(agent, sessionId, model);
    return;
  }
  switch (option.type) {
    case "select": {
      if (option.currentValue === model) return;
      const offered = listedModels(option.options);
      if (!offered.includes(model)) {
        throw new Error(
          `OpenCode cannot use ${model}. It offered ${offered.join(", ")}.`,
        );
      }
      await setModel(agent, sessionId, model);
      return;
    }
    case "boolean":
      throw new Error("OpenCode's model option was not a choice.");
    default: {
      const unexpected: never = option;
      throw new Error(`Unexpected model option ${JSON.stringify(unexpected)}.`);
    }
  }
}

async function setModel(
  agent: acp.ClientContext,
  sessionId: string,
  model: string,
): Promise<void> {
  await agent.request(acp.methods.agent.session.setConfigOption, {
    sessionId,
    configId: "model",
    value: model,
  });
}

function listedModels(options: acp.SessionConfigSelect["options"]): string[] {
  const values: string[] = [];
  for (const option of options) {
    if ("group" in option) {
      for (const nested of option.options) values.push(nested.value);
      continue;
    }
    values.push(option.value);
  }
  return values;
}

function withStderr(error: unknown, stderr: string): Error {
  const message = error instanceof Error ? error.message : "OpenCode failed.";
  const detail = stderr.trim();
  if (detail === "" || message.includes(detail)) {
    return error instanceof Error ? error : new Error(message);
  }
  return new Error(`${message}\n${detail}`);
}

function stopChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // The process group is already gone. Fall through to the child.
    }
  }
  child.kill();
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      resolve();
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
