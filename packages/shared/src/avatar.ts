/**
 * The preset avatars a bot can wear.
 * The colors are open-bot-avatar's picker, without white, in that order.
 * The shapes are the eight silhouettes on the create screen. The web app
 * draws them with open-bot-avatar. Generate and upload are not part of this.
 */

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

/**
 * One silhouette and where its eyes sit, in the 0–100 box open-bot-avatar uses.
 * The order is the shape row on the create screen.
 */
export const avatarShapes = [
  {
    id: "circle",
    name: "Circle",
    path: "M50 14A36 36 0 1 1 50 86A36 36 0 1 1 50 14Z",
    eyes: { x: 50, y: 46, spacing: 16, scale: 1.15 },
  },
  {
    id: "pebble",
    name: "Pebble",
    path: "M50 28A34 22 0 1 1 50 72A34 22 0 1 1 50 28Z",
    eyes: { x: 50, y: 48, spacing: 15, scale: 1.05 },
  },
  {
    id: "squircle",
    name: "Squircle",
    path: "M36 18H64A18 18 0 0 1 82 36V64A18 18 0 0 1 64 82H36A18 18 0 0 1 18 64V36A18 18 0 0 1 36 18Z",
    eyes: { x: 50, y: 46, spacing: 16, scale: 1.1 },
  },
  {
    id: "capsule",
    name: "Capsule",
    path: "M36 34H64A16 16 0 0 1 64 66H36A16 16 0 0 1 36 34Z",
    eyes: { x: 50, y: 50, spacing: 14, scale: 0.95 },
  },
  {
    id: "triangle",
    name: "Triangle",
    path: "M50 16C58 16 66 28 74 48C80 64 84 76 78 82C62 88 38 88 22 82C16 76 20 64 26 48C34 28 42 16 50 16Z",
    eyes: { x: 50, y: 58, spacing: 14, scale: 1 },
  },
  {
    id: "hex",
    name: "Hexagon",
    path: "M50 16L76 32C80 36 80 42 80 50C80 58 80 64 76 68L50 84L24 68C20 64 20 58 20 50C20 42 20 36 24 32Z",
    eyes: { x: 50, y: 48, spacing: 15, scale: 1.05 },
  },
  {
    id: "cloud",
    name: "Cloud",
    path: "M34 64C22 64 16 56 20 48C16 40 22 32 32 34C36 24 48 20 58 26C66 20 80 24 82 36C90 38 92 50 84 56C88 66 78 72 68 68C60 76 42 74 34 64Z",
    eyes: { x: 52, y: 48, spacing: 14, scale: 0.95 },
  },
  {
    id: "drop",
    name: "Drop",
    path: "M50 16C66 28 80 44 80 60C80 76 66 88 50 88C34 88 20 76 20 60C20 44 34 28 50 16Z",
    eyes: { x: 50, y: 58, spacing: 14, scale: 1 },
  },
] as const;

export type AvatarShape = (typeof avatarShapes)[number]["id"];

/** The shape and color stored for one bot. */
export type BotAvatar = {
  shape: AvatarShape;
  color: AvatarColor;
};

/** What a new bot wears before anyone picks: a blue circle. */
export const defaultAvatar: BotAvatar = {
  shape: "circle",
  color: "#1f7cf2",
};

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
