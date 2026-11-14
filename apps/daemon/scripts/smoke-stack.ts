/**
 * Proves the machine can run a bot's computer: a virtual screen, Chrome and a
 * desktop app, started the way the daemon starts them. The image check runs
 * this inside the container, because `/health` alone does not touch any of it.
 * Exits non-zero, with the reason, on the first thing that does not work.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createBrowserHost } from "../src/browser.js";
import { createDesktopHost } from "../src/desktop.js";
import { createDisplayHost } from "../src/display.js";

const base = process.env.COMPANION_DATA_DIR ?? "/tmp";
mkdirSync(base, { recursive: true });
const directory = mkdtempSync(join(base, "smoke-"));
const display = createDisplayHost({ directory: join(directory, "display") });
const browser = createBrowserHost({
  directory: join(directory, "browser"),
  display,
});
const desktop = createDesktopHost({
  directory: join(directory, "desktop"),
  display,
});

try {
  // Chrome answers on its debugging port and can open a window.
  const { port } = await browser.endpoint();
  const version = (await (
    await fetch(`http://127.0.0.1:${port}/json/version`)
  ).json()) as { Browser: string };
  if (!version.Browser.startsWith("Chrome/")) {
    throw new Error(`Unexpected browser: ${version.Browser}`);
  }
  await browser.openWindow();
  console.log(`chrome ok: ${version.Browser}`);

  // A desktop app opens a window the accessibility tool can see.
  const window = await desktop.launch(
    "smoke",
    "galculator",
    undefined,
    directory,
  );
  console.log(`desktop ok: ${window.app} (${window.title})`);
  console.log("stack ok");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await desktop.close();
  await browser.close();
  await display.close();
  rmSync(directory, { recursive: true, force: true });
}
