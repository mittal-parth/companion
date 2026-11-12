/**
 * What the chat and the daemon agree on for one message.
 * Which images can be attached, and how a turn's server-sent events are read.
 * The daemon writes each event as a name, one JSON data line, and a blank line.
 */
import type * as acp from "@agentclientprotocol/sdk";

export const imageMimeTypes = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type ImageMimeType = (typeof imageMimeTypes)[number];

/** How many images one message can carry. */
export const maxImagesPerMessage = 4;

/** The largest image the daemon will store. */
export const maxImageBytes = 5_000_000;

/**
 * A pasted image.
 * `data` is the file's base64, with no `data:` prefix, so a text-only model
 * can be handed a path instead of the bytes.
 */
export type AttachedImage = {
  mimeType: ImageMimeType;
  data: string;
};

/** Whether a type is one this app will store. */
export function isImageMime(value: string): value is ImageMimeType {
  switch (value) {
    case "image/png":
    case "image/jpeg":
    case "image/gif":
    case "image/webp":
      return true;
    default:
      return false;
  }
}

/**
 * One server-sent event from a turn.
 * `update` is an ACP session update, in arrival order.
 * `done` is why the prompt stopped. `error` means the turn failed.
 */
/**
 * A tool call the chat can allow or deny.
 * The same shape as an approval: the session, the tool call, and its title.
 */
export type ApprovalNotice = {
  sessionId: string;
  toolCallId: string;
  title?: string;
};

export type TurnEvent =
  | { event: "update"; data: acp.SessionUpdate }
  | { event: "approval"; data: ApprovalNotice }
  | { event: "done"; data: { stopReason: acp.StopReason } }
  | { event: "error"; data: { error: string } };

/** One event block. An empty block, between events, is skipped. */
export function parseTurnEvent(block: string): TurnEvent | undefined {
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
      if (!isSessionUpdate(payload)) {
        throw new Error("An update event needs a session update.");
      }
      return { event: "update", data: payload };
    case "approval":
      if (!isApproval(payload)) {
        throw new Error("An approval event needs a tool call.");
      }
      return { event: "approval", data: payload };
    case "done":
      if (!isStop(payload)) {
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

/** Every event in one finished response body. */
export function parseTurnEvents(body: string): TurnEvent[] {
  const events: TurnEvent[] = [];
  for (const block of body.split("\n\n")) {
    const event = parseTurnEvent(block);
    if (event !== undefined) events.push(event);
  }
  return events;
}

function isSessionUpdate(value: unknown): value is acp.SessionUpdate {
  return (
    typeof value === "object" &&
    value !== null &&
    "sessionUpdate" in value &&
    typeof value.sessionUpdate === "string"
  );
}

function isApproval(value: unknown): value is ApprovalNotice {
  if (typeof value !== "object" || value === null) return false;
  if (!("sessionId" in value) || !("toolCallId" in value)) return false;
  const title = "title" in value ? value.title : undefined;
  return (
    typeof value.sessionId === "string" &&
    value.sessionId !== "" &&
    typeof value.toolCallId === "string" &&
    value.toolCallId !== "" &&
    (title === undefined || typeof title === "string")
  );
}

function isStop(value: unknown): value is { stopReason: acp.StopReason } {
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
