/**
 * The theme decision used by the toggle and by the boot script.
 * The script is a string the browser runs before React, so this runs that
 * string against the same cases as the functions.
 */
import vm from "node:vm";
import { expect, test } from "vitest";
import {
  readThemeChoice,
  themeBootScript,
  themeIsDark,
} from "../src/lib/theme";

test("an unknown saved value follows the system", () => {
  expect(readThemeChoice(null)).toBe("system");
  expect(readThemeChoice("")).toBe("system");
  expect(readThemeChoice("blue")).toBe("system");
  expect(readThemeChoice("dark")).toBe("dark");
  expect(readThemeChoice("light")).toBe("light");
  expect(readThemeChoice("system")).toBe("system");
});

test("only system follows the operating system", () => {
  expect(themeIsDark("system", true)).toBe(true);
  expect(themeIsDark("system", false)).toBe(false);
  expect(themeIsDark("dark", false)).toBe(true);
  expect(themeIsDark("light", true)).toBe(false);
});

test("the boot script paints the same choice as the functions", () => {
  const cases: Array<[string | null, boolean]> = [
    [null, false],
    [null, true],
    ["dark", false],
    ["light", true],
    ["system", true],
    ["system", false],
    ["blue", true],
  ];
  for (const [stored, systemPrefersDark] of cases) {
    const painted = runBootScript(stored, systemPrefersDark);
    const choice = readThemeChoice(stored);
    expect(painted.theme).toBe(choice);
    expect(painted.dark).toBe(themeIsDark(choice, systemPrefersDark));
  }
});

test("the boot script leaves the page alone when storage is blocked", () => {
  const painted = runBootScript(null, true, true);
  expect(painted.theme).toBeUndefined();
  expect(painted.dark).toBe(false);
});

function runBootScript(
  stored: string | null,
  systemPrefersDark: boolean,
  storageBlocked = false,
): { theme: string | undefined; dark: boolean } {
  const classes = new Set<string>();
  const root: { dataset: { theme?: string } } = { dataset: {} };
  const context = {
    localStorage: {
      getItem() {
        if (storageBlocked) throw new Error("blocked");
        return stored;
      },
    },
    document: {
      documentElement: {
        dataset: root.dataset,
        classList: {
          toggle(name: string, force: boolean) {
            if (name === "dark" && force) classes.add(name);
            if (name === "dark" && !force) classes.delete(name);
          },
        },
      },
    },
    window: {
      matchMedia(query: string) {
        return {
          matches:
            query === "(prefers-color-scheme: dark)" && systemPrefersDark,
        };
      },
    },
  };
  vm.runInContext(themeBootScript, vm.createContext(context));
  return { theme: root.dataset.theme, dark: classes.has("dark") };
}
