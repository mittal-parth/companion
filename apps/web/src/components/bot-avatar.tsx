"use client";

/**
 * A bot's preset avatar, and the color and shape rows used to pick one.
 * The picture is drawn by open-bot-avatar from the shared silhouette list.
 * The same rows appear when a bot is created and when its avatar is changed.
 */
import { cn } from "cn";
import { useId } from "react";
import { renderAvatarSvg, type AvatarDefinition } from "open-bot-avatar";
import {
  avatarColors,
  avatarShapes,
  type AvatarShape,
  type BotAvatar,
} from "@companion/shared/avatar";

/** The picture of one bot, for the sidebar, the header, and the picker. */
export function BotAvatar({
  avatar,
  size,
  className,
}: {
  avatar: BotAvatar;
  size: number;
  className?: string;
}) {
  const scope = useId().replace(/:/g, "");
  const svg = scopeSvg(
    renderAvatarSvg(definition(avatar.shape), {
      color: avatar.color,
      eyeColor: "#ffffff",
      depth: 0,
      reducedMotion: true,
      size,
      time: 0,
    }),
    scope,
  );
  return (
    <span
      aria-hidden
      className={cn("inline-flex shrink-0", className)}
      data-color={avatar.color}
      data-shape={avatar.shape}
      dangerouslySetInnerHTML={{ __html: svg }}
      style={{ width: size, height: size }}
    />
  );
}

/**
 * The color row, then the shape row, with the current picture above them.
 * Choosing either updates the picture. Nothing here is generated or uploaded.
 */
export function AvatarPicker({
  avatar,
  onChange,
  disabled = false,
  previewSize = 96,
}: {
  avatar: BotAvatar;
  onChange: (avatar: BotAvatar) => void;
  disabled?: boolean;
  previewSize?: number;
}) {
  return (
    <div className="flex flex-col items-center gap-3">
      <BotAvatar avatar={avatar} size={previewSize} />
      <div
        aria-label="Color"
        className="flex flex-wrap justify-center gap-2"
        role="radiogroup"
      >
        {avatarColors.map((color) => {
          const selected = color.value === avatar.color;
          return (
            <button
              aria-checked={selected}
              aria-label={color.name}
              className="size-5 rounded-full"
              disabled={disabled}
              key={color.value}
              onClick={() => onChange({ ...avatar, color: color.value })}
              role="radio"
              style={{
                backgroundColor: color.value,
                boxShadow: selected
                  ? `0 0 0 2px var(--background), 0 0 0 4px ${color.value}`
                  : undefined,
              }}
              type="button"
            />
          );
        })}
      </div>
      <div
        aria-label="Shape"
        className="flex flex-wrap justify-center gap-1"
        role="radiogroup"
      >
        {avatarShapes.map((shape) => {
          const selected = shape.id === avatar.shape;
          return (
            <button
              aria-checked={selected}
              aria-label={shape.name}
              className={cn(
                "rounded-md p-0.5",
                selected &&
                  "ring-2 ring-ring ring-offset-2 ring-offset-background",
              )}
              disabled={disabled}
              key={shape.id}
              onClick={() => onChange({ ...avatar, shape: shape.id })}
              role="radio"
              type="button"
            >
              <BotAvatar
                avatar={{ shape: shape.id, color: avatar.color }}
                size={28}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The shared silhouette as the definition open-bot-avatar draws. */
function definition(shape: AvatarShape): AvatarDefinition {
  const preset = avatarShapes.find((item) => item.id === shape);
  if (preset === undefined) {
    throw new Error(`Unknown avatar shape ${shape}.`);
  }
  return {
    version: 1,
    id: preset.id,
    name: preset.name,
    body: { path: preset.path },
    eyes: {
      x: preset.eyes.x,
      y: preset.eyes.y,
      spacing: preset.eyes.spacing,
      scale: preset.eyes.scale,
    },
  };
}

/**
 * Gives each picture its own ids.
 * Two bots with the same shape would otherwise share one path id, and the
 * second picture would paint the first one's outline.
 */
function scopeSvg(svg: string, scope: string): string {
  const ids = new Set<string>();
  for (const match of svg.matchAll(/\b(?:id|href)="#?(oba-[a-z0-9]+-\d+)"/g)) {
    const id = match[1];
    if (id !== undefined) ids.add(id);
  }
  let next = svg;
  for (const id of ids) {
    next = next.replaceAll(id, `${id}${scope}`);
  }
  return next
    .replace(/\srole="img"/, "")
    .replace(/\saria-label="[^"]*"/, "")
    .replace(/<title>.*?<\/title>/, "");
}
