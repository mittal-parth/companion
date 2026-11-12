/**
 * The appearance of the web chat: light, dark, or the operating system.
 * The choice is kept in this browser. The boot script applies it before
 * the first paint, and the toggle applies it again after React loads.
 */

export const themeStorageKey = "companion-theme";

export const themeChoices = ["light", "dark", "system"] as const;

export type ThemeChoice = (typeof themeChoices)[number];

/**
 * The choice to use for a stored value.
 * Anything this browser did not save, including a cleared value, follows the system.
 */
export function readThemeChoice(stored: string | null): ThemeChoice {
  switch (stored) {
    case "light":
    case "dark":
    case "system":
      return stored;
    default:
      return "system";
  }
}

/**
 * Whether the page should use the dark palette.
 * Light and dark stay put. System takes the operating system's preference.
 */
export function themeIsDark(
  choice: ThemeChoice,
  systemPrefersDark: boolean,
): boolean {
  switch (choice) {
    case "light":
      return false;
    case "dark":
      return true;
    case "system":
      return systemPrefersDark;
    default: {
      const exhaustive: never = choice;
      return exhaustive;
    }
  }
}

/** Used for this view when the browser rejects storage. */
let memoryChoice: ThemeChoice | undefined;
let storageBlocked = false;

const themeChangeEvent = "companion-theme-change";

/** The choice saved in this browser, or system when storage is empty or blocked. */
export function readStoredThemeChoice(): ThemeChoice {
  if (typeof window === "undefined" || storageBlocked) {
    return memoryChoice ?? "system";
  }
  try {
    return readThemeChoice(localStorage.getItem(themeStorageKey));
  } catch {
    return memoryChoice ?? "system";
  }
}

/**
 * Hear when the saved choice changes.
 * Same-tab clicks dispatch the theme event. Another tab writes storage.
 */
export function subscribeToTheme(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === themeStorageKey || event.key === null) onChange();
  };
  window.addEventListener(themeChangeEvent, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(themeChangeEvent, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * Paint the choice onto the document.
 * The dark class is what the existing palette and code colors already follow.
 */
export function applyTheme(choice: ThemeChoice): void {
  const systemPrefersDark = window.matchMedia(
    "(prefers-color-scheme: dark)",
  ).matches;
  const dark = themeIsDark(choice, systemPrefersDark);
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.dataset.theme = choice;
}

/**
 * Remember the choice in this browser and paint it.
 * A blocked store still changes the current view.
 */
export function saveThemeChoice(choice: ThemeChoice): void {
  memoryChoice = choice;
  try {
    localStorage.setItem(themeStorageKey, choice);
    storageBlocked = false;
  } catch {
    // Private browsing can reject storage. The page still follows the choice.
    storageBlocked = true;
  }
  applyTheme(choice);
  window.dispatchEvent(new Event(themeChangeEvent));
}

/** The choice the server renders. The browser replaces it after hydration. */
export function serverThemeChoice(): ThemeChoice {
  return "system";
}

/**
 * Apply the saved choice before the first paint.
 * The rules match readThemeChoice and themeIsDark. It lives here as a string
 * because the browser has to run it while parsing the document, before modules load.
 */
export const themeBootScript = `(function(){try{var stored=localStorage.getItem(${JSON.stringify(themeStorageKey)});var theme=stored==="light"||stored==="dark"||stored==="system"?stored:"system";var dark=theme==="dark"||(theme==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);var root=document.documentElement;root.classList.toggle("dark",dark);root.dataset.theme=theme;}catch(e){}})();`;
