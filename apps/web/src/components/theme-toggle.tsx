"use client";

/**
 * The Light, Dark, and System control.
 * The root layout's boot script has already painted the saved choice.
 * This keeps that choice after React loads, and follows the operating
 * system for as long as System stays selected.
 */
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  applyTheme,
  readStoredThemeChoice,
  saveThemeChoice,
  serverThemeChoice,
  subscribeToTheme,
  themeChoices,
  type ThemeChoice,
} from "@/lib/theme";
import {
  useLayoutEffect,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";

/** The words shown for each choice, in the same order as the control. */
function themeLabel(choice: ThemeChoice): string {
  switch (choice) {
    case "light":
      return "Light";
    case "dark":
      return "Dark";
    case "system":
      return "System";
    default: {
      const exhaustive: never = choice;
      return exhaustive;
    }
  }
}

export function ThemeToggle({ className }: { className?: string }) {
  const choice = useSyncExternalStore(
    subscribeToTheme,
    readStoredThemeChoice,
    serverThemeChoice,
  );

  useLayoutEffect(() => {
    const stored = readStoredThemeChoice();
    applyTheme(stored);
    if (stored !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const followSystem = () => applyTheme("system");
    media.addEventListener("change", followSystem);
    return () => media.removeEventListener("change", followSystem);
  }, [choice]);

  function select(next: ThemeChoice) {
    saveThemeChoice(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = themeChoices.indexOf(choice);
    let nextIndex = index;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        nextIndex = (index + 1) % themeChoices.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        nextIndex = (index - 1 + themeChoices.length) % themeChoices.length;
        break;
      default:
        return;
    }
    event.preventDefault();
    const next = themeChoices[nextIndex];
    if (next === undefined) return;
    select(next);
    event.currentTarget
      .querySelector<HTMLButtonElement>(`[data-theme-choice="${next}"]`)
      ?.focus();
  }

  return (
    <div
      aria-label="Theme"
      className={cn(
        "flex items-center rounded-lg border border-border p-0.5",
        className,
      )}
      onKeyDown={onKeyDown}
      role="radiogroup"
    >
      {themeChoices.map((item) => (
        <Button
          aria-checked={choice === item}
          data-theme-choice={item}
          key={item}
          onClick={() => select(item)}
          role="radio"
          size="xs"
          type="button"
          variant={choice === item ? "secondary" : "ghost"}
        >
          {themeLabel(item)}
        </Button>
      ))}
    </div>
  );
}

/**
 * The bar at the top of the chat and of the page shown when the daemon is down.
 * Both screens change the theme from here.
 */
export function AppHeader({ title }: { title: string }) {
  return (
    <header className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-3">
      <h1 className="text-sm font-medium">{title}</h1>
      <ThemeToggle className="ml-auto" />
    </header>
  );
}
