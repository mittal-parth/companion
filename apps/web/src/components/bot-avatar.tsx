"use client";

/**
 * A bot's preset avatar, and the color and shape rows used to pick one.
 * Each picture is an open-bot-avatar object mounted live: it has volume,
 * blinks, and looks toward the pointer. The same rows appear when a bot is
 * created and when its avatar is changed.
 */
import { cn } from "cn";
import { useEffect, useRef } from "react";
import { mountAvatar, type AvatarOptions } from "open-bot-avatar/dom";
import {
  avatarColors,
  avatarDefinition,
  avatarShapes,
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
  return (
    <LiveAvatar
      className={className}
      color={avatar.color}
      data-color={avatar.color}
      data-shape={avatar.shape}
      definition={avatarDefinition(avatar.shape)}
      followPointer
      label=""
      size={size}
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
  previewSize = 144,
}: {
  avatar: BotAvatar;
  onChange: (avatar: BotAvatar) => void;
  disabled?: boolean;
  previewSize?: number;
}) {
  return (
    <div className="flex flex-col items-center gap-4">
      <BotAvatar avatar={avatar} size={previewSize} />
      <div
        aria-label="Color"
        className="flex flex-wrap justify-center gap-2.5"
        role="radiogroup"
      >
        {avatarColors.map((color) => {
          const selected = color.value === avatar.color;
          return (
            <button
              aria-checked={selected}
              aria-label={color.name}
              className="size-6 rounded-full"
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
        className="flex flex-wrap justify-center gap-2"
        role="radiogroup"
      >
        {avatarShapes.map((shape) => {
          const selected = shape.id === avatar.shape;
          return (
            <button
              aria-checked={selected}
              aria-label={shape.name}
              className={cn(
                "rounded-lg p-1",
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
                size={40}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Mounts one live avatar and keeps it in step with the chosen picture.
 * The host is decorative; the control around it carries the name.
 */
function LiveAvatar({
  size,
  className,
  "data-shape": dataShape,
  "data-color": dataColor,
  definition,
  color,
  followPointer,
  label,
}: AvatarOptions & {
  size: number;
  className?: string;
  "data-shape": string;
  "data-color": string;
}) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    // A new picture replaces the mounted one. While it is mounted it still
    // blinks and follows the pointer.
    const mounted = mountAvatar(element, {
      definition,
      color,
      followPointer,
      label,
    });
    return () => {
      mounted.destroy();
    };
  }, [definition, color, followPointer, label]);

  return (
    <div
      className={cn("inline-block shrink-0", className)}
      data-color={dataColor}
      data-shape={dataShape}
      ref={host}
      style={{ width: size, height: size }}
    />
  );
}
