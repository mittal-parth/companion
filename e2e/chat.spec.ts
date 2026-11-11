/**
 * The chat against a daemon whose replies are scripted.
 * One bot is shared, so the cases run in order: a stream, an image, a reload.
 * The theme case sends no message.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { daemonUrlFile, gateFile } from "../apps/daemon/scripts/chat-paths.ts";
import { themeStorageKey } from "../apps/web/src/lib/theme.ts";

const pixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test.describe.configure({ mode: "serial" });

test("a message streams markdown and a tool call", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("What should I help with?")).toBeVisible();
  await page.getByLabel("Message").fill("Say something");
  await page.getByRole("button", { name: "Submit" }).click();
  const replies = page.locator(".is-assistant");
  await expect(replies.filter({ hasText: "Working on it" })).toHaveCount(1);
  await expect(page.getByText("All finished.")).toHaveCount(0);
  release();
  await expect(
    page.locator("[data-streamdown='strong']", { hasText: "All finished." }),
  ).toBeVisible();
  await expect(page.getByText("read note")).toBeVisible();
  await expect(page.getByText("marigold")).toBeVisible();
});

test("an image is shown and stored", async ({ page }) => {
  const file = join(tmpdir(), "companion-pixel.png");
  writeFileSync(file, Buffer.from(pixel, "base64"));
  await page.goto("/");
  await page.getByLabel("Upload files").setInputFiles(file);
  await page.getByLabel("Message").fill("What is this?");
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(
    page.locator(".is-user").getByRole("img", { name: "Attached image" }),
  ).toBeVisible();
  // The picture is on screen as soon as it is sent. The daemon has it once the reply starts.
  await expect(
    page.locator(".is-assistant").filter({ hasText: "Working on it" }),
  ).toHaveCount(2);
  const url = readFileSync(daemonUrlFile, "utf8").trim();
  const bots = (await (await fetch(`${url}/bots`)).json()) as Array<{
    id: string;
  }>;
  const botId = bots[0]?.id;
  expect(botId).toBeTruthy();
  const transcript = await (await fetch(`${url}/bots/${botId}`)).json();
  expect(JSON.stringify(transcript)).toContain(pixel);
  release();
  await expect(
    page.locator("[data-streamdown='strong']", { hasText: "All finished." }),
  ).toHaveCount(2);
});

test("a reload mid-turn keeps the reply going", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Message").fill("Keep going");
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByText("Keep going")).toBeVisible();
  await expect(
    page.locator(".is-assistant").filter({ hasText: "Working on it" }),
  ).toHaveCount(3);
  const finished = page.locator("[data-streamdown='strong']", {
    hasText: "All finished.",
  });
  await expect(finished).toHaveCount(2);
  await page.reload();
  await expect(page.getByText("Keep going")).toBeVisible();
  await expect(
    page.locator(".is-assistant").filter({ hasText: "Working on it" }),
  ).toHaveCount(3);
  await expect(finished).toHaveCount(2);
  release();
  await expect(finished).toHaveCount(3);
});

test("the theme choice changes the page and stays after reload", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(page.getByLabel("Message")).toBeVisible();
  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-theme", "system");
  await expect(root).not.toHaveClass(/\bdark\b/);
  const light = await background(page);

  await page.getByRole("radio", { name: "Dark" }).click();
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(root).toHaveClass(/\bdark\b/);
  await expect.poll(() => background(page)).not.toBe(light);

  await page.reload();
  await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();
  await expect(root).toHaveClass(/\bdark\b/);
  await expect.poll(() => background(page)).not.toBe(light);

  await page.getByRole("radio", { name: "Light" }).click();
  await expect(root).not.toHaveClass(/\bdark\b/);
  await expect.poll(() => background(page)).toBe(light);

  await page.getByRole("radio", { name: "System" }).click();
  await expect(root).toHaveAttribute("data-theme", "system");
  // The system listener is attached after paint. Wait for that frame, then
  // change the operating system so the missed event is not the one we assert.
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => resolve(undefined));
      }),
  );
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(root).toHaveClass(/\bdark\b/);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(root).not.toHaveClass(/\bdark\b/);

  await page.evaluate((key) => localStorage.removeItem(key), themeStorageKey);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "system");
  await expect(root).toHaveClass(/\bdark\b/);
});

function background(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

function release(): void {
  writeFileSync(gateFile, "go");
}
