/**
 * The chat against a daemon whose replies are scripted.
 * One bot is shared, so the cases run in order: a stream, an image, a reload.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { daemonUrlFile, gateFile } from "../apps/daemon/scripts/chat-paths.ts";

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

function release(): void {
  writeFileSync(gateFile, "go");
}
