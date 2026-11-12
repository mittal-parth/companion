/**
 * The Next.js server's client for the local daemon.
 *
 * The page loads the transcript. POST /api/chat sends a message. GET
 * /api/chat/[id]/stream rejoins a turn that is still running. Those three
 * callers all use this file. They call the daemon's existing /bots API.
 * /api/health is the app's own health check, and it does not use this file.
 */
import type { BotAvatar, BotTranscript, BotView } from "@companion/shared";
import {
  isImageMime,
  parseTurnEvent,
  type AttachedImage,
  type TurnEvent,
} from "@companion/shared/protocol";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import type { UIMessage } from "ai";
import {
  createReplyStream,
  lastChatLine,
  transcriptToMessages,
} from "./converter";

/** Where the daemon is listening. Set for the web process, not the browser. */
export function daemonUrl(): string {
  const url = process.env.COMPANION_DAEMON_URL?.trim();
  if (url == null || url === "") {
    throw new Error("Set COMPANION_DAEMON_URL to the local daemon.");
  }
  return url.replace(/\/$/, "");
}

/**
 * A bot in the sidebar: the name, the preset picture, and the latest line
 * of its chat. The line is empty when that chat has no text yet.
 */
export type BotSummary = {
  id: string;
  name: string;
  avatar: BotAvatar;
  preview: string;
};

/**
 * One bot, ready for the chat.
 * A running turn is only the part before its reply, so the client can resume it.
 */
export type LoadedBot = {
  id: string;
  name: string;
  avatar: BotAvatar;
  messages: UIMessage[];
  resume: boolean;
  replyFrom?: number;
  failure?: string;
};

/**
 * The first bot, when this computer has one.
 * Opening the page uses this bot. It does not remember which one was open last.
 * An empty computer stays empty, so the page can ask for a name.
 */
export async function openFirstBot(): Promise<{
  bots: BotSummary[];
  chat: LoadedBot | null;
}> {
  const loaded = await loadEveryBot();
  const first = loaded[0];
  if (first === undefined) return { bots: [], chat: null };
  return { bots: loaded.map(summarize), chat: first };
}

/** Every bot, oldest first, each with the line under its name. */
export async function listBots(): Promise<BotSummary[]> {
  return (await loadEveryBot()).map(summarize);
}

/** The conversations the sidebar labels, oldest first. */
async function loadEveryBot(): Promise<LoadedBot[]> {
  const listed = await daemonJson<BotView[]>("/bots");
  return Promise.all(listed.map((bot) => loadBot(bot.id)));
}

/** The sidebar's view of one loaded conversation. */
function summarize(bot: LoadedBot): BotSummary {
  return {
    id: bot.id,
    name: bot.name,
    avatar: bot.avatar,
    preview: lastChatLine(bot.messages),
  };
}

/** The conversation the chat should show for one bot. */
export async function loadBot(id: string): Promise<LoadedBot> {
  const bot = await daemonJson<BotTranscript>(
    `/bots/${encodeURIComponent(id)}`,
  );
  const turn = bot.turn;
  if (turn.status === "running") {
    return {
      id: bot.id,
      name: bot.name,
      avatar: bot.avatar,
      messages: transcriptToMessages(bot.updates.slice(0, turn.replyFrom)),
      resume: true,
      replyFrom: turn.replyFrom,
    };
  }
  return {
    id: bot.id,
    name: bot.name,
    avatar: bot.avatar,
    messages: transcriptToMessages(bot.updates),
    resume: false,
    failure: turn.status === "failed" ? turn.error : undefined,
  };
}

/** The daemon's server-sent events, one TurnEvent at a time. */
export async function* readTurnEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<TurnEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const event = parseTurnEvent(block);
      if (event !== undefined) yield event;
    }
  }
  const last = parseTurnEvent(buffer);
  if (last !== undefined) yield last;
}

/**
 * Streams one daemon turn as the AI SDK's UI message stream.
 * A 204 from the daemon means there is nothing to replay.
 */
export function chatResponse(body: ReadableStream<Uint8Array>): Response {
  const reply = createReplyStream();
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      for await (const event of readTurnEvents(body)) {
        for (const chunk of reply.chunks(event)) writer.write(chunk);
      }
      for (const chunk of reply.finish()) writer.write(chunk);
      writer.setOutcome(reply.outcome());
    },
    onError: (error) =>
      error instanceof Error ? error.message : "The chat failed.",
  });
  return createUIMessageStreamResponse({ stream });
}

/** The text and images of the message the person just sent. */
export function messageForDaemon(message: UIMessage): {
  text: string;
  images: AttachedImage[];
} {
  let text = "";
  const images: AttachedImage[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      text += part.text;
      continue;
    }
    if (part.type !== "file") continue;
    images.push(imageFrom(part.mediaType, part.url));
  }
  if (text.trim() === "") {
    throw new Error("A message needs text.");
  }
  return { text, images };
}

async function daemonJson<T>(path: string): Promise<T> {
  const response = await fetch(`${daemonUrl()}${path}`);
  if (!response.ok) {
    throw new Error(await daemonError(response));
  }
  return (await response.json()) as T;
}

/** Opens the daemon route that streams a turn. The caller owns the response. */
export function daemonFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${daemonUrl()}${path}`, init);
}

/** The error text from a daemon response that was not a stream. */
export async function daemonError(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
  ) {
    return body.error;
  }
  return "The daemon failed.";
}

/**
 * A browser file part is a data URL. The daemon stores the raw base64 and
 * checks the type again with isImageMime.
 */
function imageFrom(mediaType: string, url: string): AttachedImage {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  const mimeType = match?.[1];
  const data = match?.[2];
  if (
    mimeType == null ||
    data == null ||
    !isImageMime(mimeType) ||
    (mimeType !== mediaType && mediaType !== "image")
  ) {
    throw new Error("An image needs a png, jpeg, gif, or webp type.");
  }
  return { mimeType, data };
}
