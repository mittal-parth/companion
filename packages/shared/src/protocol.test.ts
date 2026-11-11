/**
 * The image list and the turn reader are the one copy the chat and the daemon share.
 */
import { expect, test } from "vitest";
import {
  isImageMime,
  maxImageBytes,
  maxImagesPerMessage,
  parseTurnEvents,
} from "./protocol.js";

test("an image type is one of the four stored types", () => {
  expect(isImageMime("image/png")).toBe(true);
  expect(isImageMime("image/svg+xml")).toBe(false);
  expect(maxImagesPerMessage).toBe(4);
  expect(maxImageBytes).toBe(5_000_000);
});

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
