/**
 * Proves the OpenCode config carries the model and the standing bot rules,
 * and that a turn stays alive while it is still working.
 * The rules tell every bot to read and update its own files. They are not
 * those files.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as acp from "@agentclientprotocol/sdk";
import type { AttachedImage } from "@companion/shared";
import { afterEach, expect, test, vi } from "vitest";
import {
  defaultOpencodeModel,
  delegatePastedImages,
  imageBytes,
  installOpencodeConfig,
  standingInstructions,
  turnIdleTimeoutMs,
  visionAgentId,
  visionOpencodeModel,
  watchTurnIdle,
} from "./engine.js";

test("the standing rules name each bot's instructions and memory", () => {
  const text = standingInstructions();
  expect(text).toContain("AGENTS.md");
  expect(text).toContain("MEMORY.md");
  expect(text).toContain("The copies on disk are the latest.");
  expect(text).toContain("search the web and cite the pages");
  expect(text).toContain("load the schedules skill");
  expect(text).toContain("ask the vision subagent");
  expect(text).not.toContain("SARVAM_API_KEY");
  expect(standingInstructions(visionOpencodeModel)).not.toContain(
    "vision subagent",
  );
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
      agents: {
        vision: {
          mode: string;
          model: string;
          steps: number;
          permissions: { action: string; resource: string; effect: string }[];
        };
      };
      providers: {
        sarvam: {
          models: {
            "glm5.3": { modalities: { input: string[] }; attachment?: boolean };
            "glm5.3-flash": {
              modalities: { input: string[] };
              attachment?: boolean;
            };
          };
        };
      };
    };
    expect(config.model).toBe(defaultOpencodeModel);
    expect(config.websearch).toEqual({ provider: "random" });
    expect(config.permissions).toEqual([
      { action: "websearch", resource: "*", effect: "allow" },
      { action: "subagent", resource: visionAgentId, effect: "allow" },
    ]);
    expect(config.agents.vision.mode).toBe("subagent");
    expect(config.agents.vision.model).toBe(visionOpencodeModel);
    expect(config.agents.vision.steps).toBe(6);
    expect(config.agents.vision.permissions).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
    ]);
    expect(config.providers.sarvam.models["glm5.3"].modalities.input).toEqual([
      "text",
    ]);
    expect(
      config.providers.sarvam.models["glm5.3-flash"].modalities.input,
    ).toEqual(["text", "image"]);
    expect(config.providers.sarvam.models["glm5.3"].attachment).toBeUndefined();
    expect(config.providers.sarvam.models["glm5.3-flash"].attachment).toBe(
      true,
    );
    expect(config.policies).toEqual([
      { action: "websearch.use", resource: "firecrawl", effect: "deny" },
      { action: "websearch.use", resource: "tavily", effect: "deny" },
      { action: "websearch.use", resource: "opencode", effect: "deny" },
    ]);
    expect(readFileSync(join(directory, "opencode", "AGENTS.md"), "utf8")).toBe(
      standingInstructions(defaultOpencodeModel),
    );
    const skill = fileURLToPath(
      new URL("../skills/schedules/SKILL.md", import.meta.url),
    );
    expect(
      readFileSync(
        join(directory, "opencode", "skills", "schedules", "SKILL.md"),
        "utf8",
      ),
    ).toBe(readFileSync(skill, "utf8"));
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
  const idle = vi.fn();
  const watch = watchTurnIdle(turnIdleTimeoutMs, idle);
  watch.stop();
  watch.note({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "late" },
  });
  vi.advanceTimersByTime(turnIdleTimeoutMs);
  expect(idle).not.toHaveBeenCalled();
});

test("a quiet turn is cancelled at the idle limit", () => {
  vi.useFakeTimers();
  const idle = vi.fn();
  const watch = watchTurnIdle(turnIdleTimeoutMs, idle);
  vi.advanceTimersByTime(turnIdleTimeoutMs - 1);
  expect(idle).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(idle).toHaveBeenCalledTimes(1);
  watch.stop();
});

test("session updates keep a turn alive for hours", () => {
  vi.useFakeTimers();
  const idle = vi.fn();
  const watch = watchTurnIdle(turnIdleTimeoutMs, idle);
  const chunk: acp.SessionUpdate = {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "still working" },
  };
  for (let minute = 0; minute < 180; minute += 1) {
    vi.advanceTimersByTime(60_000);
    watch.note(chunk);
  }
  expect(idle).not.toHaveBeenCalled();
  vi.advanceTimersByTime(turnIdleTimeoutMs);
  expect(idle).toHaveBeenCalledTimes(1);
  watch.stop();
});

test("an open tool call keeps a turn alive through silence", () => {
  vi.useFakeTimers();
  const idle = vi.fn();
  const watch = watchTurnIdle(turnIdleTimeoutMs, idle);
  watch.note({
    sessionUpdate: "tool_call",
    toolCallId: "shell",
    title: "run",
    status: "in_progress",
  });
  vi.advanceTimersByTime(6 * 60 * 60 * 1000);
  expect(idle).not.toHaveBeenCalled();
  watch.note({
    sessionUpdate: "tool_call_update",
    toolCallId: "shell",
    status: "completed",
  });
  vi.advanceTimersByTime(turnIdleTimeoutMs - 1);
  expect(idle).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(idle).toHaveBeenCalledTimes(1);
  watch.stop();
});

const pixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("a model that already sees gets no vision subagent", () => {
  const directory = mkdtempSync(join(tmpdir(), "companion-opencode-see-"));
  try {
    installOpencodeConfig(directory, visionOpencodeModel);
    const config = JSON.parse(
      readFileSync(join(directory, "opencode", "opencode.json"), "utf8"),
    ) as { model: string; agents?: unknown; permissions: unknown };
    expect(config.model).toBe(visionOpencodeModel);
    expect(config.agents).toBeUndefined();
    expect(config.permissions).toEqual([
      { action: "websearch", resource: "*", effect: "allow" },
    ]);
    expect(readFileSync(join(directory, "opencode", "AGENTS.md"), "utf8")).toBe(
      standingInstructions(visionOpencodeModel),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a pasted image becomes a path and the prompt keeps no bytes", () => {
  const directory = mkdtempSync(join(tmpdir(), "companion-image-"));
  const image: AttachedImage = { mimeType: "image/png", data: pixel };
  try {
    const prompt = delegatePastedImages(directory, "What is this?", [image]);
    const names = readdirSync(join(directory, "images"));
    expect(names).toHaveLength(1);
    const saved = join(directory, "images", names[0] ?? "");
    expect(prompt).toContain("What is this?");
    expect(prompt).toContain(saved);
    expect(prompt).toContain("vision subagent");
    expect(prompt).not.toContain(pixel);
    expect(readFileSync(saved)).toEqual(imageBytes(image));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an image whose bytes do not match its type is refused", () => {
  expect(() => imageBytes({ mimeType: "image/jpeg", data: pixel })).toThrow(
    /do not match/,
  );
});

test("more images than one turn can hold are refused", () => {
  const directory = mkdtempSync(join(tmpdir(), "companion-images-"));
  const image: AttachedImage = { mimeType: "image/png", data: pixel };
  try {
    expect(() =>
      delegatePastedImages(directory, "Look", [
        image,
        image,
        image,
        image,
        image,
      ]),
    ).toThrow(/too long/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
