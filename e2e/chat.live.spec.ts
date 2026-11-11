/**
 * One turn against OpenCode on Sarvam.
 * Skipped unless COMPANION_LIVE=1, the same gate as the daemon's live tests.
 */
import { expect, test } from "@playwright/test";
import { requireOpencode } from "../apps/daemon/tests/helpers.ts";

test("a live turn replies", async ({ page }) => {
  test.setTimeout(180_000);
  requireOpencode();
  await page.goto("/");
  await page
    .getByLabel("Message")
    .fill("Reply with exactly the word marigold.");
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByText("marigold").last()).toBeVisible({
    timeout: 120_000,
  });
});
