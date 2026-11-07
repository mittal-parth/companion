import { expect, test } from "vitest";
import { daemonRole } from "./index.js";

test("the daemon is the ACP client", () => {
  expect(daemonRole).toBe("acp-client");
});
