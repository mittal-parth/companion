/**
 * The one reader for a turn's server-sent events.
 * The web app and the daemon's tests both use it.
 */
import { expect, test } from "vitest";
import { parseTurnEvents } from "./turn-event.js";

test("a finished turn body is one event per block", () => {
  const body = [
    'event: update\ndata: {"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}',
    'event: done\ndata: {"stopReason":"end_turn"}',
    "",
  ].join("\n\n");
  expect(parseTurnEvents(body)).toEqual([
    {
      event: "update",
      data: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hi" },
      },
    },
    { event: "done", data: { stopReason: "end_turn" } },
  ]);
});
