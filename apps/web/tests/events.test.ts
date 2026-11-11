/**
 * The chat reads the daemon's server-sent events as they arrive.
 * A network chunk can split one event in half. Here the split falls in the
 * middle of the word "done", and both events still come out whole.
 */
import { expect, test } from "vitest";
import { readTurnEvents } from "../src/lib/daemon";

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
