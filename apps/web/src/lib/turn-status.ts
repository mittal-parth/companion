/**
 * What a bot shows under its latest reply while that turn is still being written.
 * The lines rotate so the wait does not look stuck. They are not tool names:
 * text from the turn stays in the bubble, and each tool call stays out of this row.
 */

export const turnStatusLines = [
  "Collecting details",
  "Working on it",
  "Thinking it through",
  "Checking the thread",
  "Putting it together",
] as const;

/** How long one line stays before the next. */
export const turnStatusIntervalMs = 2400;

/** How long the avatar holds one glance before looking somewhere else. */
export const turnLookIntervalMs = 800;

/** The line for this step, wrapping so the list repeats. */
export function turnStatusLine(index: number): string {
  const count = turnStatusLines.length;
  const safe = Number.isFinite(index) ? Math.trunc(index) : 0;
  const wrapped = ((safe % count) + count) % count;
  return turnStatusLines[wrapped] ?? turnStatusLines[0];
}

/**
 * A small glance for the live avatar, each axis inside its -1..1 look range.
 * When a previous glance is known, the next one moves away from it.
 */
export function nextLook(
  current?: { x: number; y: number },
  random: () => number = Math.random,
): { x: number; y: number } {
  const axis = (span: number) => (random() * 2 - 1) * span;
  const look = { x: axis(0.65), y: axis(0.4) };
  if (
    current !== undefined &&
    Math.abs(look.x - current.x) < 0.2 &&
    Math.abs(look.y - current.y) < 0.15
  ) {
    return {
      x: current.x > 0 ? -0.55 : 0.55,
      y: current.y > 0 ? -0.3 : 0.3,
    };
  }
  return look;
}
