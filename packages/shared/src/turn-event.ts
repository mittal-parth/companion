/**
 * Reads the server-sent events a turn streams.
 * The daemon writes each one as an event name, one JSON data line, and a blank line.
 */
import type * as acp from "@agentclientprotocol/sdk";

/**
 * One server-sent event from a turn.
 * `update` is an ACP session update, in arrival order.
 * `done` is why the prompt stopped. `error` means the turn failed.
 */
export type TurnEvent =
  | { event: "update"; data: acp.SessionUpdate }
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
