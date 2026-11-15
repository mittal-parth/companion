import { expect, test } from "vitest";
import { launchToken, vmStatus } from "./vm.js";

const row = {
  userId: "u",
  attemptStartedAt: "2026-01-01T00:00:00.123456+00:00",
};

test("the same attempt always gets the same token, within EC2's 64 characters", () => {
  expect(launchToken(row)).toBe(launchToken({ ...row }));
  expect(launchToken(row)).toHaveLength(64);
});

test("a new attempt, another user or another zone gets a different token", () => {
  const tokens = new Set([
    launchToken(row),
    launchToken({ ...row, attemptStartedAt: "2026-01-01T00:10:00+00:00" }),
    launchToken({ ...row, userId: "v" }),
    launchToken(row, 1),
  ]);
  expect(tokens.size).toBe(4);
});

test("only ready and failed are told apart from setting up", () => {
  expect(vmStatus(null)).toBe("setting-up");
  expect(vmStatus("launching")).toBe("setting-up");
  expect(vmStatus("booting")).toBe("setting-up");
  expect(vmStatus("ready")).toBe("ready");
  expect(vmStatus("failed")).toBe("failed");
});
