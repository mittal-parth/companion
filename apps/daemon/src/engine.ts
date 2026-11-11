/**
 * Runs each bot's conversation on one OpenCode process.
 * The first prompt starts the session. A later prompt continues it.
 * After a restart, the stored session id is loaded instead of replaced.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import {
  engines,
  isImageMime,
  maxImageBytes,
  maxImagesPerMessage,
  type AttachedImage,
  type ImageMimeType,
} from "@companion/shared";
import type { ThreadStore } from "./thread-store.js";
import { botConversation } from "./thread-store.js";
import { approvalResponse } from "./approval.js";

/** Sarvam's GLM 5.3, the model a bot's conversation runs on. */
export const defaultOpencodeModel = "sarvam/glm5.3";

/**
 * Sarvam's GLM 5.3 Flash.
 * The managed conversation stays on GLM 5.3. This model reads an image when
 * that conversation cannot.
 */
export const visionOpencodeModel = "sarvam/glm5.3-flash";

/** The subagent a text-only conversation asks to look at an image file. */
export const visionAgentId = "vision";

/** Named in the config. The key itself stays in the environment. */
const sarvamKeyEnv = "SARVAM_API_KEY";

/**
 * How long a turn may go without a session update while no tool call is open.
 * A tool that has not finished is still work, so a long command keeps the turn
 * alive. A model that stops sending anything is cancelled.
 */
export const turnIdleTimeoutMs = 180_000;

/**
 * Cancels a turn that has gone quiet.
 * The wait starts at once and resets on each session update. A tool call that
 * has not reached a final status holds the turn through a long silence.
 * `stop` ends the watch so a finished turn is not cancelled later.
 */
export function watchTurnIdle(
  timeoutMs: number,
  onIdle: () => void,
): { note(update: acp.SessionUpdate): void; stop(): void } {
  const open = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function arm(): void {
    clearTimeout(timer);
    if (stopped || open.size > 0) return;
    timer = setTimeout(onIdle, timeoutMs);
  }

  arm();
  return {
    note(update) {
      if (stopped) return;
      if (
        update.sessionUpdate === "tool_call" ||
        update.sessionUpdate === "tool_call_update"
      ) {
        // A new tool call with no status is pending. An update with none
        // leaves the tool call as it was.
        const status =
          update.status ??
          (update.sessionUpdate === "tool_call" ? "pending" : undefined);
        if (status === "completed" || status === "failed") {
          open.delete(update.toolCallId);
        } else if (status !== undefined) {
          open.add(update.toolCallId);
        }
      }
      arm();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

const imageFiles: Record<
  ImageMimeType,
  { extension: string; matches: (bytes: Buffer) => boolean }
> = {
  "image/png": {
    extension: "png",
    matches: (bytes: Buffer) =>
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  "image/jpeg": {
    extension: "jpg",
    matches: (bytes: Buffer) =>
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff,
  },
  "image/gif": {
    extension: "gif",
    matches: (bytes: Buffer) =>
      bytes.length >= 3 && bytes.subarray(0, 3).toString("ascii") === "GIF",
  },
  "image/webp": {
    extension: "webp",
    matches: (bytes: Buffer) =>
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP",
  },
};

function imageKind(mimeType: string) {
  if (!isImageMime(mimeType)) return undefined;
  return imageFiles[mimeType];
}

/**
 * Whether this model can be given image bytes.
 * GLM 5.3 cannot. Flash can, and so can a later engine whose model already sees.
 */
export function modelReadsImages(model: string): boolean {
  return model !== defaultOpencodeModel;
}

/** GLM 5.3 is the managed model that has to ask Flash to look. */
export function needsVisionSubagent(model: string): boolean {
  return model === defaultOpencodeModel;
}

/**
 * Rules every bot follows.
 * OpenCode loads this as its global instructions, separate from the AGENTS.md
 * in a bot's own folder. The model reads and edits those two files. This one
 * only tells it to.
 */
export function standingInstructions(model = defaultOpencodeModel): string {
  const vision = needsVisionSubagent(model)
    ? "\nWhen you need to understand an image or a screenshot, ask the vision subagent to read that file and answer the question. Do not read the image yourself. You decide what to do next.\n"
    : "";
  return `# Companion bots

You are one bot on a computer shared with this person's other bots. Your working directory is yours. Other bots have their own directories. Do not read or edit those.

AGENTS.md in your working directory is your instructions: who you are and what you are for. MEMORY.md in your working directory is your memory: facts, preferences, and rules worth keeping.

Read both files at the start of a turn when they exist. The copies on disk are the latest. Use your file tools. Do not rely on an earlier reading.

When the user tells you what you are for, or changes that, update AGENTS.md in your working directory. When they tell you something worth keeping, update MEMORY.md there. Skip a write when nothing new belongs in either file.

When the user wants something to happen later or on a repeat, load the schedules skill and use the schedule command. Never keep a schedule in AGENTS.md or MEMORY.md.

When a question needs a current public fact, search the web and cite the pages you used. Do not invent that fact.

When a task needs a real web page, such as opening a result, filling a form or reading something a search cannot show, load the browser skill and use the browser command. Never start Chrome yourself.

When a task needs a desktop application that is not a web page, load the desktop skill and use the desktop command. Never drive the screen with xdotool, wmctrl, scrot or agent-desktop. A web page stays on the browser command.
${vision}
If AGENTS.md does not yet say what you are for, ask the user. Do not invent a role.

These rules are shared by every bot. Do not edit this file.
`;
}

/**
 * Commands a bot must not run directly. The `browser` command is the one way
 * to drive Chrome, because it keeps each bot in its own window of the shared
 * browser. Starting another Chrome, or driving the shared one directly, would
 * bypass that.
 */
const rawBrowserCommands = [
  "agent-browser *",
  "npx agent-browser *",
  "playwright-cli *",
  "npx playwright *",
  "google-chrome *",
  "chromium *",
  "chromium-browser *",
  "chrome *",
];

/**
 * Commands a bot must not run directly. The `desktop` command is the one way
 * onto the shared screen. The raw tools can type into another bot's window,
 * and a display variable in front of them is the same command.
 */
const rawDesktopCommands = [
  "agent-desktop *",
  "npx agent-desktop *",
  "xdotool *",
  "wmctrl *",
  "scrot *",
  "DISPLAY=* xdotool *",
  "DISPLAY=* wmctrl *",
  "DISPLAY=* scrot *",
  "DISPLAY=* agent-desktop *",
  "env * xdotool *",
  "env * wmctrl *",
  "env * scrot *",
  "env * agent-desktop *",
];

/**
 * Tells OpenCode to call Sarvam, and to search the web with no key.
 * The same file is written into the bot's folder and into the process config.
 * The key is named twice, as the provider credential and as Sarvam's header,
 * and is not copied into the file.
 *
 * Search rotates through whichever free providers remain. Firecrawl and Tavily
 * are denied because their free tiers fail without a rate-limit status OpenCode
 * can switch on. OpenCode's own hosted search is denied because it bills the
 * workspace. Exa, Parallel, and TinyFish stay, and a search is allowed without
 * a prompt.
 *
 * GLM 5.3 also gets a read-only vision subagent on Flash. A model that can
 * already see does not.
 */
export function opencodeModelConfig(model: string): string {
  const permissions: Array<{
    action: string;
    resource: string;
    effect: string;
  }> = [
    { action: "websearch", resource: "*", effect: "allow" },
    { action: "shell", resource: "browser *", effect: "allow" },
    { action: "shell", resource: "desktop *", effect: "allow" },
  ];
  // The text model is allowed to launch the reader without asking the user.
  if (needsVisionSubagent(model)) {
    permissions.push({
      action: "subagent",
      resource: visionAgentId,
      effect: "allow",
    });
  }
  const configObject: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    model,
    websearch: {
      provider: "random",
    },
    permissions,
    policies: [
      { action: "websearch.use", resource: "firecrawl", effect: "deny" },
      { action: "websearch.use", resource: "tavily", effect: "deny" },
      { action: "websearch.use", resource: "opencode", effect: "deny" },
      ...[...rawBrowserCommands, ...rawDesktopCommands].map((command) => ({
        action: "tool.use",
        resource: `shell:${command}`,
        effect: "deny",
      })),
    ],
    providers: {
      sarvam: {
        name: "Sarvam",
        env: [sarvamKeyEnv],
        package: "@opencode/ai/providers/openai-compatible",
        settings: {
          baseURL: "https://api.sarvam.ai/v2",
        },
        headers: {
          "api-subscription-key": `{env:${sarvamKeyEnv}}`,
        },
        models: {
          "glm5.3": sarvamModel("GLM 5.3", ["text"]),
          "glm5.3-flash": sarvamModel("GLM 5.3 Flash", ["text", "image"]),
        },
      },
    },
  };
  if (needsVisionSubagent(model)) configObject.agents = visionAgent();
  const config = `${JSON.stringify(configObject, null, 2)}\n`;
  const key = process.env[sarvamKeyEnv];
  if (key !== undefined && key.length >= 16 && config.includes(key)) {
    throw new Error("Refusing to write the Sarvam key into OpenCode's config.");
  }
  return config;
}

/** One Sarvam model entry. `input` is what OpenCode may attach to a prompt. */
function sarvamModel(name: string, input: readonly string[]) {
  return {
    name,
    // A custom model drops image parts unless this is set.
    ...(input.includes("image") ? { attachment: true } : {}),
    capabilities: {
      tools: true,
      input,
      output: ["text"],
    },
    modalities: {
      input,
      output: ["text"],
    },
    limit: {
      context: 1048576,
      output: 8192,
    },
  };
}

/**
 * A child session that can read an image file and nothing else.
 * The parent stays on GLM 5.3 and decides what to do with the answer.
 */
function visionAgent() {
  return {
    build: {
      permissions: [
        { action: "subagent", resource: visionAgentId, effect: "allow" },
      ],
    },
    [visionAgentId]: {
      description:
        "Reads an image file and answers a question about what it shows. Use this for a screenshot or a pasted image.",
      mode: "subagent",
      model: visionOpencodeModel,
      steps: 6,
      system:
        "Read the image file you are given and answer the question about it. Say what is visible. Do not edit files, run commands, or launch another agent.",
      permissions: [
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ],
    },
  };
}

/**
 * Checks a pasted image and returns the bytes to store.
 * The type has to match the file, so a text model is never pointed at a lie.
 */
export function imageBytes(image: { mimeType: string; data: string }): Buffer {
  const kind = imageKind(image.mimeType);
  if (kind === undefined) {
    throw new Error("An image needs a png, jpeg, gif, or webp type.");
  }
  if (
    typeof image.data !== "string" ||
    image.data.includes("data:") ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data) ||
    image.data.length % 4 !== 0
  ) {
    throw new Error("An image must be base64.");
  }
  const bytes = Buffer.from(image.data, "base64");
  if (bytes.length === 0) throw new Error("An image is empty.");
  if (bytes.length > maxImageBytes) throw new Error("An image is too large.");
  if (!kind.matches(bytes)) {
    throw new Error("An image's bytes do not match its type.");
  }
  return bytes;
}

/**
 * Saves pasted images into the bot's folder and names them in the prompt.
 * The text model receives paths, not the bytes.
 */
export function delegatePastedImages(
  directory: string,
  text: string,
  images: readonly AttachedImage[],
): string {
  if (images.length === 0) return text;
  if (images.length > maxImagesPerMessage) {
    throw new Error("An image list is too long.");
  }
  const folder = join(directory, "images");
  mkdirSync(folder, { recursive: true });
  const paths = images.map((image) => {
    const kind = imageKind(image.mimeType);
    if (kind === undefined) {
      throw new Error("An image needs a png, jpeg, gif, or webp type.");
    }
    const name = `${randomUUID()}.${kind.extension}`;
    const path = join(folder, name);
    writeFileSync(path, imageBytes(image));
    return path;
  });
  const saved =
    paths.length === 1
      ? `The user attached an image. It is saved at ${paths[0]}.`
      : `The user attached images. They are saved at:\n${paths.join("\n")}`;
  const which = paths.length === 1 ? "that file" : "those files";
  return `${text}\n\n${saved}\nAsk the vision subagent to read ${which} and answer the question. Do not read the image yourself.`;
}

/** The prompt a model is allowed to see. A text-only model gets the words only. */
function promptBlocks(
  model: string,
  text: string,
  images: readonly AttachedImage[] | undefined,
): acp.ContentBlock[] {
  const blocks: acp.ContentBlock[] = [{ type: "text", text }];
  if (!modelReadsImages(model) || images === undefined) return blocks;
  for (const image of images) {
    imageBytes(image);
    blocks.push({ type: "image", mimeType: image.mimeType, data: image.data });
  }
  return blocks;
}

/**
 * Writes the model config and the standing rules OpenCode loads for every bot.
 * The bot's own instructions are not created here. The model writes those.
 */
export function installOpencodeConfig(configHome: string, model: string): void {
  const directory = join(configHome, "opencode");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "opencode.json"), opencodeModelConfig(model));
  writeFileSync(join(directory, "AGENTS.md"), standingInstructions(model));
  installSkills(directory);
}

/**
 * Copies each skill folder into the config OpenCode reads.
 * A skill is a directory under `skills/` with a SKILL.md. Adding one there is
 * enough for the next daemon start to load it.
 */
function installSkills(configDirectory: string): void {
  const source = fileURLToPath(new URL("../skills", import.meta.url));
  const destination = join(configDirectory, "skills");
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(source)) {
    cpSync(join(source, name), join(destination, name), { recursive: true });
  }
}

/**
 * Puts the `schedule` command on the bot's PATH.
 * The shim runs the CLI with this same Node, so the bot just types `schedule`.
 */
export function installScheduleShim(binDir: string): void {
  installShim(binDir, "schedule", "./schedule-cli.ts");
}

/** Puts the `browser` command on the bot's PATH, the same way as `schedule`. */
export function installBrowserShim(binDir: string): void {
  installShim(binDir, "browser", "./browser-cli.ts");
}

/** Puts the `desktop` command on the bot's PATH, the same way as `browser`. */
export function installDesktopShim(binDir: string): void {
  installShim(binDir, "desktop", "./desktop-cli.ts");
}

function installShim(binDir: string, name: string, cliFile: string): void {
  mkdirSync(binDir, { recursive: true });
  const cli = fileURLToPath(new URL(cliFile, import.meta.url));
  const path = join(binDir, name);
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`);
  chmodSync(path, 0o755);
}

/** Speaks ACP for the daemon. One prompt is one turn of a bot's conversation. */
export type Engine = {
  prompt(
    botId: string,
    text: string,
    onUpdate: (update: acp.SessionUpdate) => void,
    images?: readonly AttachedImage[],
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
  /** A directory prepended to PATH, holding the `schedule`, `browser` and `desktop` commands. */
  binDir: string;
}): Promise<Engine> {
  if (
    options.model.startsWith("sarvam/") &&
    (process.env[sarvamKeyEnv]?.trim() ?? "") === ""
  ) {
    throw new Error("SARVAM_API_KEY is required to run a Sarvam model.");
  }
  // Written before the process starts, so session/new already lists this model
  // and every bot is told to keep its own AGENTS.md and MEMORY.md.
  installOpencodeConfig(options.configHome, options.model);
  installScheduleShim(options.binDir);
  installBrowserShim(options.binDir);
  installDesktopShim(options.binDir);
  mkdirSync(options.dataHome, { recursive: true });

  const env = { ...process.env };
  delete env.OPENCODE_DISABLE_FREE_MODELS;
  delete env.OPENCODE_CONFIG;
  delete env.OPENCODE_CONFIG_DIR;
  env.XDG_CONFIG_HOME = options.configHome;
  env.XDG_DATA_HOME = options.dataHome;
  env.PATH = `${options.binDir}${delimiter}${env.PATH ?? ""}`;

  const child = spawn(
    options.bin,
    // OpenCode 1.19 prints its help and exits when these log flags are set,
    // so the daemon relies on the process stderr alone.
    ["acp"],
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
    // A free-tier refusal leaves the prompt open, so end the turn here.
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
    async prompt(botId, text, onUpdate, images) {
      const sessionId = await openSession(
        agent,
        options.store,
        options.model,
        openSessions,
        botId,
      );
      const abort = new AbortController();
      let stoppedForSilence = false;
      // A quiet model is cancelled. A tool call that has not finished is still work.
      const idle = watchTurnIdle(turnIdleTimeoutMs, () => {
        stoppedForSilence = true;
        abort.abort();
      });
      const cancel = () => {
        void agent
          .notify(acp.methods.agent.session.cancel, { sessionId })
          .catch(() => undefined);
      };
      abort.signal.addEventListener("abort", cancel);
      listeners.set(sessionId, (update) => {
        idle.note(update);
        onUpdate(update);
      });
      const request = agent.request(
        acp.methods.agent.session.prompt,
        {
          sessionId,
          // GLM 5.3 never sees the bytes, even if a caller passed them.
          prompt: promptBlocks(options.model, text, images),
        },
        { cancellationSignal: abort.signal, stopWaitingOnCancel: true },
      );
      void request.catch(() => undefined);
      try {
        const response = await Promise.race([request, providerError]);
        return response.stopReason;
      } catch (error) {
        if (stoppedForSilence) return "cancelled";
        cancel();
        throw withStderr(error, stderr);
      } finally {
        idle.stop();
        abort.signal.removeEventListener("abort", cancel);
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
  if (thread.engine !== engines.opencode) {
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

/** Points the session at the requested model when OpenCode started on another one. */
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

/** Asks a child and its process group to stop. */
export function stopChild(child: ChildProcess): void {
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

/** Resolves once the child is gone, killing it if it outlasts `graceMs`. */
export function exited(child: ChildProcess, graceMs = 2000): Promise<void> {
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
    }, graceMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
