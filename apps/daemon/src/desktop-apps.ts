/**
 * The applications a bot may start on the shared screen.
 *
 * Kept apart from the desktop host so the `desktop` command can name them
 * without loading the host. Anything else would be a shell. Each one is its
 * own process per launch, so closing one bot's window does not close another's.
 * A file manager such as Thunar is not here: a second window opens inside the
 * first process.
 */

/** The apps a bot is allowed to start. */
export const desktopAppNames = ["mousepad", "galculator"] as const;

export type DesktopAppName = (typeof desktopAppNames)[number];

/** What `desktop launch` prints when the bot names an app that is not allowed. */
export const desktopLaunchUsage =
  "Usage: desktop launch mousepad [file]   or   desktop launch galculator\n";

/** True when `app` is one a bot is allowed to start. */
export function isDesktopApp(app: string): app is DesktopAppName {
  switch (app) {
    case "mousepad":
    case "galculator":
      return true;
    default:
      return false;
  }
}
