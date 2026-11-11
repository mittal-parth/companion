import { expect, test } from "vitest";
import { daemonRole } from "../src/index.js";

test("the daemon is the ACP client", () => {
  expect(daemonRole).toBe("acp-client");
});
