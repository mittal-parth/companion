/**
 * The web app's calls to the local daemon.
 * The browser never talks to the daemon directly. These routes do.
 */
import type * as acp from "@agentclientprotocol/sdk";
import type {
  AttachedImage,
  BotTranscript,
  BotView,
  TurnEvent,
} from "@companion/shared";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import type { UIMessage } from "ai";
import { createReplyStream } from "./messages";

const imageTypes = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

type ImageType = (typeof imageTypes)[number];

/** Where the daemon is listening. Set for the web process, not the browser. */
export function daemonUrl(): string {
  const url = process.env.COMPANION_DAEMON_URL?.trim();
  if (url == null || url === "") {
    throw new Error("Set COMPANION_DAEMON_URL to the local daemon.");
  }
  return url.replace(/\/$/, "");
}

/**
 * The bot the page talks to.
 * The first one is reused. A fresh daemon gets a bot named Companion.
 */
export async function ensureDefaultBot(): Promise<BotTranscript> {
  const listed = await daemonJson<BotView[]>("/bots");
  const first = listed[0];
  const id = first?.id ?? (await createBot("Companion")).id;
  return daemonJson<BotTranscript>(`/bots/${encodeURIComponent(id)}`);
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

async function createBot(name: string): Promise<BotView> {
  const response = await fetch(`${daemonUrl()}/bots`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    throw new Error(await errorMessage(response));
  }
  return (await response.json()) as BotView;
}

async function daemonJson<T>(path: string): Promise<T> {
  const response = await fetch(`${daemonUrl()}${path}`);
  if (!response.ok) {
    throw new Error(await errorMessage(response));
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

async function errorMessage(response: Response): Promise<string> {
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

function parseTurnEvent(block: string): TurnEvent | undefined {
  if (block.trim() === "") return undefined;
  let name = "";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed.startsWith("event:")) {
      name = trimmed.slice("event:".length).trim();
    }
    if (trimmed.startsWith("data:")) {
      data.push(trimmed.slice("data:".length).trim());
    }
  }
  const payload: unknown = JSON.parse(data.join("\n"));
  switch (name) {
    case "update":
      if (!isUpdate(payload)) {
        throw new Error("An update event needs a session update.");
      }
      return { event: "update", data: payload };
    case "done":
      if (!isDone(payload)) {
        throw new Error("A done event needs a stop reason.");
      }
      return { event: "done", data: payload };
    case "error":
      if (!isFailure(payload)) {
        throw new Error("An error event needs a message.");
      }
      return { event: "error", data: payload };
    default:
      throw new Error(`Unexpected event ${name}.`);
  }
}

function isUpdate(value: unknown): value is acp.SessionUpdate {
  return (
    typeof value === "object" &&
    value !== null &&
    "sessionUpdate" in value &&
    typeof value.sessionUpdate === "string"
  );
}

function isDone(value: unknown): value is { stopReason: acp.StopReason } {
  return (
    typeof value === "object" &&
    value !== null &&
    "stopReason" in value &&
    typeof value.stopReason === "string"
  );
}

function isFailure(value: unknown): value is { error: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
  );
}

function imageFrom(mediaType: string, url: string): AttachedImage {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  const mimeType = match?.[1];
  const data = match?.[2];
  if (
    mimeType == null ||
    data == null ||
    !isImageType(mimeType) ||
    (mimeType !== mediaType && mediaType !== "image")
  ) {
    throw new Error("An image needs a png, jpeg, gif, or webp type.");
  }
  return { mimeType, data };
}

function isImageType(value: string): value is ImageType {
  return (imageTypes as readonly string[]).includes(value);
}
