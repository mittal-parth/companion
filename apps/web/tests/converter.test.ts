/**
 * The converter against the recorded OpenCode hello turn, plus a person's
 * image and a failed turn, which that recording does not contain.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as acp from "@agentclientprotocol/sdk";
import type { RecordedSession } from "@companion/shared";
import { expect, test } from "vitest";
import {
  createReplyStream,
  lastChatLine,
  transcriptToMessages,
} from "../src/lib/converter";

const pixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const fixture = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../daemon/fixtures/opencode-hello.json",
    ),
    "utf8",
  ),
) as RecordedSession;

const said: acp.SessionUpdate = {
  sessionUpdate: "user_message_chunk",
  content: { type: "text", text: "What is this?" },
};

const image: acp.SessionUpdate = {
  sessionUpdate: "user_message_chunk",
  content: { type: "image", mimeType: "image/png", data: pixel },
};

test("a stored transcript becomes messages", () => {
  const messages = transcriptToMessages([said, image, ...fixture.updates]);
  expect(messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ]);

  const user = messages[0];
  expect(user?.parts).toEqual([
    { type: "text", text: "What is this?", state: "done" },
    {
      type: "file",
      mediaType: "image/png",
      url: `data:image/png;base64,${pixel}`,
    },
  ]);

  const assistant = messages[1];
  const reasoning = assistant?.parts.find((part) => part.type === "reasoning");
  expect(reasoning).toMatchObject({
    type: "reasoning",
    text: "The user wants me to read note.txt in the working directory and reply with only the exact word in that file. Let me read it.",
  });
  const text = assistant?.parts.find((part) => part.type === "text");
  expect(text).toMatchObject({ type: "text", text: "marigold" });

  const tools = assistant?.parts.filter((part) => part.type === "dynamic-tool");
  expect(tools).toHaveLength(2);
  expect(tools?.[0]).toMatchObject({
    type: "dynamic-tool",
    toolName: "read",
    state: "output-available",
    input: { path: "{workspace}/note.txt" },
  });
  expect(tools?.[0]).toMatchObject({
    output: expect.stringContaining("marigold"),
  });
  expect(tools?.[1]).toMatchObject({
    type: "dynamic-tool",
    state: "output-error",
    errorText: "The user declined this tool call",
  });
  expect(JSON.stringify(assistant?.parts)).not.toContain("available_commands");
  expect(JSON.stringify(assistant?.parts)).not.toContain("usage_update");
});

test("the sidebar line is the latest message, on one row", () => {
  expect(lastChatLine([])).toBe("");
  expect(lastChatLine(transcriptToMessages(fixture.updates))).toBe("marigold");
  expect(
    lastChatLine(
      transcriptToMessages([
        {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Already set.\nWednesday and Sunday at 8am, same time.",
          },
        },
      ]),
    ),
  ).toBe("Already set. Wednesday and Sunday at 8am, same time.");
  expect(
    lastChatLine(
      transcriptToMessages([
        {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Working on it.\n\n**All finished.**",
          },
        },
      ]),
    ),
  ).toBe("Working on it. All finished.");
  expect(lastChatLine(transcriptToMessages([...fixture.updates, image]))).toBe(
    "marigold",
  );
});

test("a live reply streams text, reasoning, tools, and errors", () => {
  const reply = createReplyStream();
  const chunks = [
    ...fixture.updates.flatMap((update) =>
      reply.chunks({ event: "update", data: update }),
    ),
    ...reply.chunks({
      event: "error",
      data: { error: "The engine stopped." },
    }),
  ];
  expect(chunks[0]).toEqual({ type: "start" });
  const reasoning = chunks
    .filter((chunk) => chunk.type === "reasoning-delta")
    .map((chunk) => (chunk.type === "reasoning-delta" ? chunk.delta : ""))
    .join("");
  expect(reasoning).toBe(
    "The user wants me to read note.txt in the working directory and reply with only the exact word in that file. Let me read it.",
  );
  const text = chunks
    .filter((chunk) => chunk.type === "text-delta")
    .map((chunk) => (chunk.type === "text-delta" ? chunk.delta : ""))
    .join("");
  expect(text).toBe("marigold");
  expect(chunks).toContainEqual(
    expect.objectContaining({
      type: "tool-output-available",
      dynamic: true,
      output: expect.stringContaining("marigold"),
    }),
  );
  expect(chunks).toContainEqual(
    expect.objectContaining({
      type: "tool-output-error",
      dynamic: true,
      errorText: "The user declined this tool call",
    }),
  );
  expect(chunks.at(-2)).toEqual({
    type: "error",
    errorText: "The engine stopped.",
  });
  expect(chunks.at(-1)).toEqual({ type: "finish", finishReason: "error" });
  expect(reply.outcome()).toEqual({ status: "failed" });
});

test("a finished turn closes the assistant message", () => {
  const reply = createReplyStream();
  const chunks = reply.chunks({
    event: "done",
    data: { stopReason: "end_turn" },
  });
  expect(chunks).toEqual([
    { type: "start" },
    { type: "finish", finishReason: "stop" },
  ]);
  expect(reply.outcome()).toEqual({ status: "completed" });
});
