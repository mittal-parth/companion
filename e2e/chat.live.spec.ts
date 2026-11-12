/**
 * The chat against the daemon's real OpenCode engine.
 * Skipped unless COMPANION_LIVE=1, the same gate as the daemon's live tests.
 * The cases share one bot, so they run in order.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { daemonUrlFile } from "../apps/daemon/scripts/chat-paths.ts";

test.describe.configure({ mode: "serial" });

test("the opening turn is already on the page", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".is-assistant").first()).toBeVisible();
  await expect(page.getByLabel("Message")).toBeVisible();
});

test("a message streams a reply", async ({ page }) => {
  await page.goto("/");
  await page
    .getByLabel("Message")
    .fill("Reply with exactly the word marigold.");
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByText("marigold").last()).toBeVisible({
    timeout: 180_000,
  });
});

test("a file read's word is in the reply, not a tool card", async ({
  page,
}) => {
  const word = `marigold-${randomUUID().slice(0, 8)}`;
  const bot = await defaultBot();
  writeFileSync(join(bot.directory, "note.txt"), `${word}\n`, "utf8");
  await page.goto("/");
  await page
    .getByLabel("Message")
    .fill(
      "Read note.txt in the working directory with a file-reading tool, then reply with only the exact word in that file.",
    );
  await page.getByRole("button", { name: "Submit" }).click();
  const reply = page.locator(".is-assistant").last();
  await expect(reply.getByText(word)).toBeVisible({ timeout: 240_000 });
  await expect(reply.getByText("Completed")).toHaveCount(0);
});

/** The bot the test server created when it started. */
async function defaultBot(): Promise<{ directory: string }> {
  const url = readFileSync(daemonUrlFile, "utf8").trim();
  const bots = (await (await fetch(`${url}/bots`)).json()) as Array<{
    directory?: string;
  }>;
  const directory = bots[0]?.directory;
  if (directory == null || directory === "") {
    throw new Error("The chat has no bot.");
  }
  return { directory };
}
