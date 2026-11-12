/**
 * The preset avatars a bot can wear.
 * Colors are open-bot-avatar's picker, without white, in that order.
 * Shapes are that library's starter objects, then the gallery objects from
 * the same repo, by name. The web app mounts them live, so they have volume,
 * blink, and look toward the pointer. Generate and upload are not part of this.
 */
import {
  examples,
  validateAvatar,
  type AvatarDefinition,
} from "open-bot-avatar";
import book from "./gallery/book.json" with { type: "json" };
import brain from "./gallery/brain.json" with { type: "json" };
import bull from "./gallery/bull.json" with { type: "json" };
import bunny from "./gallery/bunny.json" with { type: "json" };
import camera from "./gallery/camera.json" with { type: "json" };
import cat from "./gallery/cat.json" with { type: "json" };
import cloud from "./gallery/cloud.json" with { type: "json" };
import ghost from "./gallery/ghost.json" with { type: "json" };
import magnifier from "./gallery/magnifier.json" with { type: "json" };
import paintBrush from "./gallery/paint-brush.json" with { type: "json" };
import palette from "./gallery/palette.json" with { type: "json" };
import rocket from "./gallery/rocket.json" with { type: "json" };
import shield from "./gallery/shield.json" with { type: "json" };
import star from "./gallery/star.json" with { type: "json" };
import witchHat from "./gallery/witch-hat.json" with { type: "json" };

export const avatarColors = [
  { name: "Brown", value: "#a8693f" },
  { name: "Red", value: "#f2384b" },
  { name: "Orange", value: "#ff6a1a" },
  { name: "Amber", value: "#f8a01c" },
  { name: "Green", value: "#1fbf68" },
  { name: "Teal", value: "#14b3a5" },
  { name: "Blue", value: "#1f7cf2" },
  { name: "Purple", value: "#8b5cf6" },
  { name: "Pink", value: "#ec4899" },
  { name: "Gray", value: "#7a7a7a" },
] as const;

export type AvatarColor = (typeof avatarColors)[number]["value"];

const galleryFiles = [
  book,
  brain,
  bull,
  bunny,
  camera,
  cat,
  cloud,
  ghost,
  magnifier,
  paintBrush,
  palette,
  rocket,
  shield,
  star,
  witchHat,
];

/** Starters first, in the library's order, then the gallery by display name. */
export const avatarDefinitions: readonly AvatarDefinition[] = [
  ...examples,
  ...galleryFiles
    .map((file) => {
      const result = validateAvatar(file);
      if (!result.ok) {
        throw new Error(result.errors.join("\n"));
      }
      return result.value;
    })
    .sort((left, right) => left.name.localeCompare(right.name)),
];

/** The shape row, in the same order as the definitions. */
export const avatarShapes = avatarDefinitions.map((definition) => ({
  id: definition.id,
  name: definition.name,
}));

export type AvatarShape = (typeof avatarShapes)[number]["id"];

/** The shape and color stored for one bot. */
export type BotAvatar = {
  shape: AvatarShape;
  color: AvatarColor;
};

/** What a new bot wears before anyone picks: the first starter, in blue. */
export const defaultAvatar: BotAvatar = {
  shape: "controller",
  color: "#1f7cf2",
};

/** The definition the renderer mounts for a stored shape. */
export function avatarDefinition(shape: AvatarShape): AvatarDefinition {
  const definition = avatarDefinitions.find((item) => item.id === shape);
  if (definition === undefined) {
    throw new Error(`Unknown avatar shape ${shape}.`);
  }
  return definition;
}

/**
 * The preset a request named, or undefined when it is not one of the list.
 * Color matching ignores case so a stored hex and a typed hex agree.
 */
export function parseAvatar(
  shape: string,
  color: string,
): BotAvatar | undefined {
  const knownShape = avatarShapes.find((item) => item.id === shape);
  const knownColor = avatarColors.find(
    (item) => item.value === color.toLowerCase(),
  );
  if (knownShape === undefined || knownColor === undefined) return undefined;
  return { shape: knownShape.id, color: knownColor.value };
}
