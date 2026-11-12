import { avatarShapes, defaultAvatar } from "@companion/shared/avatar";
import { renderAvatarSvg, validateAvatar } from "open-bot-avatar";
import { expect, test } from "vitest";

test("every preset silhouette is an avatar open-bot-avatar can draw", () => {
  for (const shape of avatarShapes) {
    const result = validateAvatar({
      version: 1,
      id: shape.id,
      name: shape.name,
      body: { path: shape.path },
      eyes: {
        x: shape.eyes.x,
        y: shape.eyes.y,
        spacing: shape.eyes.spacing,
        scale: shape.eyes.scale,
      },
    });
    expect(result.ok, shape.id).toBe(true);
    if (!result.ok) continue;
    const svg = renderAvatarSvg(result.value, {
      color: defaultAvatar.color,
      eyeColor: "#ffffff",
      depth: 0,
      reducedMotion: true,
      time: 0,
    });
    expect(svg).toContain(defaultAvatar.color);
    expect(svg).toContain("#ffffff");
  }
});
