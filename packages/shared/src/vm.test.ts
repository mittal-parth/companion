import { expect, test } from "vitest";
import { volumeToken, vmStatus } from "./vm.js";

test("a user always gets the same volume token, within EC2's 64 characters", () => {
  expect(volumeToken("u")).toBe(volumeToken("u"));
  expect(volumeToken("u")).toHaveLength(64);
});

test("another user gets a different volume token", () => {
  expect(volumeToken("u")).not.toBe(volumeToken("v"));
});

test("only ready and failed are told apart from setting up", () => {
  expect(vmStatus(null)).toBe("setting-up");
  expect(vmStatus("launching")).toBe("setting-up");
  expect(vmStatus("booting")).toBe("setting-up");
  expect(vmStatus("ready")).toBe("ready");
  expect(vmStatus("failed")).toBe("failed");
});
