import { expect, test } from "vitest";
import { examples } from "open-bot-avatar";
import {
  avatarColors,
  avatarDefinitions,
  avatarShapes,
  defaultAvatar,
  parseAvatar,
} from "./avatar.js";

test("the preset list is the open-bot-avatar starters and gallery", () => {
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
  expect(
    avatarShapes.map((shape) => shape.id).slice(0, examples.length),
  ).toEqual(examples.map((shape) => shape.id));
  expect(avatarShapes.map((shape) => shape.id).slice(examples.length)).toEqual([
    "book",
    "brain",
    "bull",
    "bunny",
    "camera",
    "cat",
    "cloud",
    "ghost",
    "magnifier",
    "paint-brush",
    "palette",
    "rocket",
    "shield",
    "star",
    "witch-hat",
  ]);
  expect(avatarDefinitions).toHaveLength(avatarShapes.length);
  expect(defaultAvatar).toEqual({
    shape: "controller",
    color: avatarColors.find((color) => color.name === "Blue")?.value,
  });
});

test("only a preset shape and color is an avatar", () => {
  expect(parseAvatar("cloud", "#EC4899")).toEqual({
    shape: "cloud",
    color: "#ec4899",
  });
  expect(parseAvatar("controller", "#ffffff")).toBeUndefined();
  expect(parseAvatar("pebble", "#1f7cf2")).toBeUndefined();
  expect(parseAvatar("controller", "blue")).toBeUndefined();
});
