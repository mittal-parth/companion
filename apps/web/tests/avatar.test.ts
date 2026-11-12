import { avatarDefinitions, defaultAvatar } from "@companion/shared/avatar";
import { renderAvatarSvg, validateAvatar } from "open-bot-avatar";
import { expect, test } from "vitest";

test("every preset is an open-bot-avatar definition the renderer can draw", () => {
  for (const definition of avatarDefinitions) {
    const result = validateAvatar(definition);
    expect(result.ok, definition.id).toBe(true);
    if (!result.ok) continue;
    const svg = renderAvatarSvg(result.value, {
      color: defaultAvatar.color,
      time: 0,
    });
    expect(svg).toContain(defaultAvatar.color);
  }
});
