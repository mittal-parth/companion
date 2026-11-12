import { expect, test } from "vitest";
import {
  avatarColors,
  avatarShapes,
  defaultAvatar,
  parseAvatar,
} from "./avatar.js";

test("the preset list is the create screen's colors and shapes", () => {
  expect(avatarColors.map((color) => color.name)).toEqual([
    "Brown",
    "Red",
    "Orange",
    "Amber",
    "Green",
    "Teal",
    "Blue",
    "Purple",
    "Pink",
    "Gray",
  ]);
  expect(avatarShapes.map((shape) => shape.id)).toEqual([
    "circle",
    "pebble",
    "squircle",
    "capsule",
    "triangle",
    "hex",
    "cloud",
    "drop",
  ]);
  expect(defaultAvatar).toEqual({
    shape: "circle",
    color: avatarColors.find((color) => color.name === "Blue")?.value,
  });
});

test("only a preset shape and color is an avatar", () => {
  expect(parseAvatar("cloud", "#EC4899")).toEqual({
    shape: "cloud",
    color: "#ec4899",
  });
  expect(parseAvatar("circle", "#ffffff")).toBeUndefined();
  expect(parseAvatar("star", "#1f7cf2")).toBeUndefined();
  expect(parseAvatar("circle", "blue")).toBeUndefined();
});
