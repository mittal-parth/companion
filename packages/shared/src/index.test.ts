import { expect, test } from "vitest";
import { sharedPackage } from "./index.js";

test("shared types live in this package", () => {
  expect(sharedPackage).toBe("@companion/shared");
});
