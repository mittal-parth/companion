/**
 * Proves the OpenCode config carries the model and the standing bot rules,
 * and that a turn stays alive while it is still working.
 * The rules tell every bot to read and update its own files. They are not
 * those files.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, expect, test, vi } from "vitest";
import {
  defaultOpencodeModel,
  installOpencodeConfig,
  standingInstructions,
  turnIdleTimeoutMs,
  watchTurnIdle,
  type TurnIdleWatch,
} from "./engine.js";

test("the standing rules name each bot's instructions and memory", () => {
  const text = standingInstructions();
  expect(text).toContain("AGENTS.md");
  expect(text).toContain("MEMORY.md");
  expect(text).toContain("The copies on disk are the latest.");
  expect(text).toContain("search the web and cite the pages");
  expect(text).not.toContain("SARVAM_API_KEY");
});

test("installing the config writes the rules beside the model file", () => {
  const directory = mkdtempSync(join(tmpdir(), "companion-opencode-"));
  try {
    installOpencodeConfig(directory, defaultOpencodeModel);
    const config = JSON.parse(
      readFileSync(join(directory, "opencode", "opencode.json"), "utf8"),
    ) as {
      model: string;
      websearch: { provider: string };
      permissions: { action: string; resource: string; effect: string }[];
      policies: { action: string; resource: string; effect: string }[];
    };
    expect(config.model).toBe(defaultOpencodeModel);
    expect(config.websearch).toEqual({ provider: "random" });
    expect(config.permissions).toEqual([
      { action: "websearch", resource: "*", effect: "allow" },
    ]);
    expect(config.policies).toEqual([
      { action: "websearch.use", resource: "firecrawl", effect: "deny" },
      { action: "websearch.use", resource: "tavily", effect: "deny" },
      { action: "websearch.use", resource: "opencode", effect: "deny" },
    ]);
    expect(readFileSync(join(directory, "opencode", "AGENTS.md"), "utf8")).toBe(
      standingInstructions(),
    );
    const key = process.env.SARVAM_API_KEY;
    if (key !== undefined && key.length >= 16) {
      expect(
        readFileSync(join(directory, "opencode", "opencode.json"), "utf8"),
      ).not.toContain(key);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.useRealTimers();
});

test("a finished turn is not cancelled by a late update", () => {
  vi.useFakeTimers();
  const watch = silence();
  watch.stop();
  watch.note({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "late" },
  });
  vi.advanceTimersByTime(turnIdleTimeoutMs);
  expect(watch.fired).toBe(false);
});

test("a quiet turn is cancelled at the idle limit", () => {
  vi.useFakeTimers();
  const watch = silence();
  vi.advanceTimersByTime(turnIdleTimeoutMs - 1);
  expect(watch.fired).toBe(false);
  vi.advanceTimersByTime(1);
  expect(watch.fired).toBe(true);
  watch.stop();
});

test("session updates keep a turn alive for hours", () => {
  vi.useFakeTimers();
  const watch = silence();
  const chunk: acp.SessionUpdate = {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "still working" },
  };
  for (let minute = 0; minute < 180; minute += 1) {
    vi.advanceTimersByTime(60_000);
    watch.note(chunk);
  }
  expect(watch.fired).toBe(false);
  vi.advanceTimersByTime(turnIdleTimeoutMs);
  expect(watch.fired).toBe(true);
  watch.stop();
});

test("an open tool call keeps a turn alive through silence", () => {
  vi.useFakeTimers();
  const watch = silence();
  watch.note({
    sessionUpdate: "tool_call",
    toolCallId: "shell",
    title: "run",
    status: "in_progress",
  });
  vi.advanceTimersByTime(6 * 60 * 60 * 1000);
  expect(watch.fired).toBe(false);
  watch.note({
    sessionUpdate: "tool_call_update",
    toolCallId: "shell",
    status: "completed",
  });
  vi.advanceTimersByTime(turnIdleTimeoutMs - 1);
  expect(watch.fired).toBe(false);
  vi.advanceTimersByTime(1);
  expect(watch.fired).toBe(true);
  watch.stop();
});

test("one open tool call holds the turn after another finishes", () => {
  vi.useFakeTimers();
  const watch = silence();
  watch.note({
    sessionUpdate: "tool_call",
    toolCallId: "read",
    title: "read",
    status: "in_progress",
  });
  watch.note({
    sessionUpdate: "tool_call",
    toolCallId: "shell",
    title: "run",
    status: "pending",
  });
  watch.note({
    sessionUpdate: "tool_call_update",
    toolCallId: "read",
    status: "failed",
  });
  vi.advanceTimersByTime(6 * 60 * 60 * 1000);
  expect(watch.fired).toBe(false);
  watch.note({
    sessionUpdate: "tool_call_update",
    toolCallId: "shell",
    content: [{ type: "content", content: { type: "text", text: "out" } }],
  });
  vi.advanceTimersByTime(6 * 60 * 60 * 1000);
  expect(watch.fired).toBe(false);
  watch.stop();
});

function silence(): TurnIdleWatch & { readonly fired: boolean } {
  const state = { fired: false };
  const watch = watchTurnIdle(turnIdleTimeoutMs, () => {
    state.fired = true;
  });
  return {
    get fired() {
      return state.fired;
    },
    note: (update) => watch.note(update),
    stop: () => watch.stop(),
  };
}
