import { expect, test } from "vitest";
import {
  nextLook,
  turnStatusLine,
  turnStatusLines,
} from "../src/lib/turn-status";

test("status lines include the waiting copy and then repeat", () => {
  expect(turnStatusLines).toContain("Working on it");
  expect(turnStatusLines).toContain("Collecting details");
  expect(turnStatusLine(0)).toBe(turnStatusLines[0]);
  expect(turnStatusLine(1)).toBe(turnStatusLines[1]);
  expect(turnStatusLine(turnStatusLines.length)).toBe(turnStatusLines[0]);
  expect(turnStatusLine(-1)).toBe(turnStatusLines.at(-1));
  expect(turnStatusLine(Number.NaN)).toBe(turnStatusLines[0]);
});

test("a glance stays inside the avatar's look range and moves off the last one", () => {
  const still = nextLook(undefined, () => 0);
  expect(still.x).toBeCloseTo(-0.65);
  expect(still.y).toBeCloseTo(-0.4);
  expect(Math.abs(still.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(still.y)).toBeLessThanOrEqual(1);

  const sameSpot = nextLook(still, () => 0);
  expect(Math.abs(sameSpot.x - still.x)).toBeGreaterThan(0.2);

  const far = nextLook(undefined, () => 1);
  expect(far.x).toBeCloseTo(0.65);
  expect(far.y).toBeCloseTo(0.4);
});
