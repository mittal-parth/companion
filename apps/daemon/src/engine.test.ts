/**
 * Proves the OpenCode config carries the model and the standing bot rules.
 * The rules tell every bot to read and update its own files. They are not
 * those files.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  defaultOpencodeModel,
  installOpencodeConfig,
  standingInstructions,
} from "./engine.js";

test("the standing rules name each bot's instructions and memory", () => {
  const text = standingInstructions();
  expect(text).toContain("AGENTS.md");
  expect(text).toContain("MEMORY.md");
  expect(text).toContain("The copies on disk are the latest.");
  expect(text).not.toContain("SARVAM_API_KEY");
});

test("installing the config writes the rules beside the model file", () => {
  const directory = mkdtempSync(join(tmpdir(), "companion-opencode-"));
  try {
    installOpencodeConfig(directory, defaultOpencodeModel);
    const config = JSON.parse(
      readFileSync(join(directory, "opencode", "opencode.json"), "utf8"),
    ) as { model: string };
    expect(config.model).toBe(defaultOpencodeModel);
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
