import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as acp from "@agentclientprotocol/sdk";
import type { RecordedSession } from "@companion/shared";
import { expect, test } from "vitest";
import {
  allowOnce,
  describeUpdate,
  hasToolCall,
  noteWord,
  redactWorkspace,
  replyText,
} from "../src/acp-hello.js";

test("a one-time allow is preferred over always", () => {
  const response = allowOnce([
    { optionId: "always", name: "Always", kind: "allow_always" },
    { optionId: "once", name: "Once", kind: "allow_once" },
  ]);
  expect(response).toEqual({
    outcome: { outcome: "selected", optionId: "once" },
  });
});

test("a reject-only prompt is cancelled", () => {
  const response = allowOnce([
    { optionId: "no", name: "Reject", kind: "reject_once" },
  ]);
  expect(response).toEqual({ outcome: { outcome: "cancelled" } });
});

test("reply text and tool calls are read from the session stream", () => {
  const updates: acp.SessionUpdate[] = [
    {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: noteWord },
    },
    {
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "Read note.txt",
    },
  ];
  expect(replyText(updates)).toBe(noteWord);
  expect(hasToolCall(updates)).toBe(true);
  expect(describeUpdate(updates[1]!)).toBe("tool_call Read note.txt (pending)");
});

test("the recorded workspace path is replaced", () => {
  const redacted = redactWorkspace(
    { path: "/tmp/acp-hello-xyz/note.txt" },
    "/tmp/acp-hello-xyz",
  );
  expect(redacted.path).toBe("{workspace}/note.txt");
});

test("the recorded OpenCode session has a reply and a tool call", () => {
  const fixture = join(
    dirname(fileURLToPath(import.meta.url)),
    "../fixtures/opencode-hello.json",
  );
  const session = JSON.parse(
    readFileSync(fixture, "utf8"),
  ) as RecordedSession & {
    prompt: { usage?: { thoughtTokens?: number } };
  };
  expect(replyText(session.updates)).toContain(noteWord);
  expect(hasToolCall(session.updates)).toBe(true);
  expect(session.prompt.stopReason).toBe("end_turn");
  const tool = session.updates.find(
    (update) => update.sessionUpdate === "tool_call",
  );
  expect(tool).toMatchObject({ name: "read", status: "pending" });
  expect(
    session.updates.some(
      (update) => update.sessionUpdate === "agent_thought_chunk",
    ),
  ).toBe(true);
  expect(session.prompt.usage).toMatchObject({ thoughtTokens: 29 });
  expect(session.newSession.configOptions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "effort", currentValue: "default" }),
    ]),
  );
  expect(session.permissions[0]?.response).toEqual({
    outcome: { outcome: "selected", optionId: "reject" },
  });
  const declined = session.updates.find(
    (update) =>
      update.sessionUpdate === "tool_call_update" && update.status === "failed",
  );
  expect(declined).toMatchObject({
    rawOutput: { error: "The user declined this tool call" },
  });
  expect(session.cancel?.stopReason).toBe("cancelled");
});
