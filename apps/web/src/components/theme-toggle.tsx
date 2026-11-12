"use client";

/**
 * A small theme menu for Light, Dark, and System.
 * The root layout's boot script has already painted the saved choice.
 * This keeps that choice after React loads, and follows the operating
 * system for as long as System stays selected.
 */
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  applyTheme,
  readStoredThemeChoice,
  saveThemeChoice,
  serverThemeChoice,
  subscribeToTheme,
  themeChoices,
  type ThemeChoice,
} from "@/lib/theme";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useLayoutEffect, useSyncExternalStore, type ReactNode } from "react";

/** The words shown for each choice. */
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

/** The mark on the closed control, so the current choice is visible without the menu. */
function ThemeIcon({ choice }: { choice: ThemeChoice }): ReactNode {
  switch (choice) {
    case "light":
      return <SunIcon />;
    case "dark":
      return <MoonIcon />;
    case "system":
      return <MonitorIcon />;
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

  function select(next: string) {
    switch (next) {
      case "light":
      case "dark":
      case "system":
        saveThemeChoice(next);
        return;
      default:
        return;
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`Theme: ${themeLabel(choice)}`}
          className={className}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <ThemeIcon choice={choice} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup onValueChange={select} value={choice}>
          {themeChoices.map((item) => (
            <DropdownMenuRadioItem key={item} value={item}>
              {themeLabel(item)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
