/**
 * The account gate against the built app.
 * An unsigned browser gets the sign-in page and a refused API. A signed-in
 * browser can leave from the account menu. The email form is absent here
 * because this server is a production build.
 */
import { expect, test } from "@playwright/test";

const configured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() &&
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim(),
);

test.beforeEach(() => {
  test.skip(!configured, "The hosted Supabase project is not configured.");
});

test.describe("unsigned", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the app and its API stay closed", async ({ page, request }) => {
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: "Sign in with Google" }),
    ).toBeVisible();
    await expect(page.getByLabel("Email")).toHaveCount(0);
    await expect(page.getByLabel("Message")).toHaveCount(0);

    const health = await request.get("/api/health");
    expect(health.status()).toBe(401);
    const bot = await request.get("/api/bots/not-a-bot");
    expect(bot.status()).toBe(401);

    await page.goto("/bots/not-a-bot");
    await expect(page).toHaveURL("/");
    await expect(
      page.getByRole("button", { name: "Sign in with Google" }),
    ).toBeVisible();
  });
});

test("sign out returns to the sign-in page", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("Message")).toBeVisible();
  await page.getByRole("button", { name: "Account" }).click();
  await expect(
    page.locator("[data-slot='dropdown-menu-content']"),
  ).toHaveAttribute("data-side", "top");
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(
    page.getByRole("button", { name: "Sign in with Google" }),
  ).toBeVisible();
  await expect(page.getByLabel("Message")).toHaveCount(0);
});
