import { expect, test } from "vitest";
import { engineNames, engines, sharedPackage } from "./index.js";

test("shared types live in this package", () => {
  expect(sharedPackage).toBe("@companion/shared");
});

test("engine names are the shared set", () => {
  expect(engineNames).toEqual([
    engines.opencode,
    engines.claude,
    engines.codex,
  ]);
});
