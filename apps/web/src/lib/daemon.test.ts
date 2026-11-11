/**
 * The daemon speaks server-sent events. A chunk boundary can fall in the
 * middle of one, and the chat still has to see both events.
 */
import { expect, test } from "vitest";
import { readTurnEvents } from "./daemon";

test("reads a turn that arrives in pieces", async () => {
  const encoder = new TextEncoder();
  const pieces = [
    'event: update\ndata: {"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}\n\nevent: do',
    'ne\ndata: {"stopReason":"end_turn"}\n\n',
  ];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
  const events = [];
  for await (const event of readTurnEvents(body)) events.push(event);
  expect(events).toEqual([
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
