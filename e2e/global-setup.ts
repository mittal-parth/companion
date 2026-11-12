/**
 * Signs the browser tests in before they open the app.
 * The file it writes holds a session, so it stays out of git.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devSessionCookies } from "./session.ts";

const path = join(dirname(fileURLToPath(import.meta.url)), ".auth/state.json");

export default async function globalSetup(): Promise<void> {
  const cookies = await devSessionCookies();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ cookies, origins: [] }));
}
