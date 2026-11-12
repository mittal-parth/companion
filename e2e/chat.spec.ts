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
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(page.getByText("What should I help with?")).toBeVisible();
  await page.getByLabel("Message").fill("Say something");
  await page.getByRole("button", { name: "Submit" }).click();
  const replies = page.locator(".is-assistant");
  await expect(replies.filter({ hasText: "Working on it" })).toHaveCount(1);
  await expectBubbles(page);
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

  await page.getByRole("button", { name: "Theme: System" }).click();
  await page.getByRole("menuitemradio", { name: "Dark" }).click();
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(root).toHaveClass(/\bdark\b/);
  await expect.poll(() => background(page)).not.toBe(light);

  await page.reload();
  await expect(page.getByRole("button", { name: "Theme: Dark" })).toBeVisible();
  await expect(root).toHaveClass(/\bdark\b/);
  await expect.poll(() => background(page)).not.toBe(light);

  await page.getByRole("button", { name: "Theme: Dark" }).click();
  await page.getByRole("menuitemradio", { name: "Light" }).click();
  await expect(root).not.toHaveClass(/\bdark\b/);
  await expect.poll(() => background(page)).toBe(light);

  await page.getByRole("button", { name: "Theme: Light" }).click();
  await page.getByRole("menuitemradio", { name: "System" }).click();
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

/** The person's words are a black bubble on the right. The bot's are gray on the left. */
async function expectBubbles(page: Page): Promise<void> {
  const column = await page.locator("[role='log']").boundingBox();
  const user = await page
    .locator(".is-user > div", { hasText: "Say something" })
    .boundingBox();
  const assistant = await page
    .locator(".is-assistant > div", { hasText: "Working on it" })
    .boundingBox();
  expect(column).toBeTruthy();
  expect(user).toBeTruthy();
  expect(assistant).toBeTruthy();
  if (column == null || user == null || assistant == null) return;
  expect(assistant.x).toBeLessThan(user.x);
  expect(user.x + user.width).toBeGreaterThan(assistant.x + assistant.width);
  expect(assistant.x - column.x).toBeGreaterThan(8);
  expect(assistant.x - column.x).toBeLessThan(40);
  expect(column.x + column.width - (user.x + user.width)).toBeGreaterThan(8);
  expect(column.x + column.width - (user.x + user.width)).toBeLessThan(40);

  const colors = await page.evaluate(() => {
    const paint = (selector: string, text: string) => {
      const bubble = [...document.querySelectorAll(selector)].find((node) =>
        node.textContent?.includes(text),
      );
      if (!(bubble instanceof HTMLElement)) return null;
      const style = getComputedStyle(bubble);
      return {
        background: style.backgroundColor,
        color: style.color,
        radius: style.borderTopLeftRadius,
      };
    };
    return {
      user: paint(".is-user > div", "Say something"),
      assistant: paint(".is-assistant > div", "Working on it"),
    };
  });
  expect(colors.user).toEqual({
    background: "rgb(0, 0, 0)",
    color: "rgb(255, 255, 255)",
    radius: "14px",
  });
  expect(colors.assistant?.background).toBe("rgb(238, 238, 238)");
  expect(colors.assistant?.radius).toBe("14px");
}

function background(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

test("a sidebar row renames in place and delete opens the next bot", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("Keep going")).toBeVisible();
  await page.getByRole("button", { name: "New bot" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Ada");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Ada" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Rename/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Theme:/ })).toBeVisible();
  await expect(page.getByText("Keep going")).toHaveCount(0);
  await expect(page.getByText("What should I help with?")).toBeVisible();

  await page.getByRole("button", { name: "Ada", exact: true }).click({
    button: "right",
  });
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const draft = page.getByRole("textbox", { name: "Bot name" });
  await draft.fill("Draft");
  await draft.press("Escape");
  await expect(
    page.getByRole("button", { name: "Ada", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ada" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Bot name" })).toHaveCount(0);

  await page.getByRole("button", { name: "Ada", exact: true }).click({
    button: "right",
  });
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await page.getByRole("textbox", { name: "Bot name" }).fill("Blurred");
  await page.getByText("What should I help with?").click();
  await expect(
    page.getByRole("button", { name: "Blurred", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Blurred" })).toBeVisible();

  await page.getByRole("button", { name: "Blurred", exact: true }).click({
    button: "right",
  });
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await page.getByRole("textbox", { name: "Bot name" }).fill("Nightly");
  await page.getByRole("textbox", { name: "Bot name" }).press("Enter");
  await expect(
    page.getByRole("button", { name: "Nightly", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Nightly" })).toBeVisible();

  await page.getByRole("button", { name: "Companion", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Companion" })).toBeVisible();
  await expect(page.getByText("Keep going")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Companion" })).toBeVisible();
  await expect(page.getByText("Keep going")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Nightly", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "New bot" }).click();
  await page.getByRole("radio", { name: "Orange" }).click();
  await page.getByRole("radio", { name: "Lightbulb" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Bea");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Bea" })).toBeVisible();
  await expect(
    page
      .getByRole("heading", { name: "Bea" })
      .locator("[data-shape='lightbulb']"),
  ).toHaveAttribute("data-color", "#ff6a1a");
  await page.getByRole("button", { name: "Companion", exact: true }).click();
  await page.getByRole("button", { name: "Bea", exact: true }).click({
    button: "right",
  });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("heading", { name: "Companion" })).toBeVisible();
  await expect(page.getByText("Keep going")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Bea", exact: true }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Companion", exact: true }).click({
    button: "right",
  });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(
    page.getByRole("heading", { name: "Delete Companion?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Keep going")).toBeVisible();

  await page.getByRole("button", { name: "Companion", exact: true }).click({
    button: "right",
  });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("heading", { name: "Nightly" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Companion", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Keep going")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Create a bot" })).toHaveCount(
    0,
  );

  await page.getByRole("button", { name: "New bot" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Bea");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Bea" })).toBeVisible();
  await page.getByRole("button", { name: "Bea", exact: true }).click({
    button: "right",
  });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("heading", { name: "Nightly" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create a bot" })).toHaveCount(
    0,
  );

  await page.getByRole("button", { name: "Nightly", exact: true }).click({
    button: "right",
  });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("heading", { name: "New Bot" })).toBeVisible();
  await expect(page.getByLabel("Message")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Theme:/ })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create your first Bot" }),
  ).toBeVisible();
  await expect(page.getByText("No chats yet")).toBeVisible();
  await expect(page.getByText("Night Shift")).toHaveCount(0);
  await expect(page.getByText("Inbox Triage")).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("heading", { name: "New Bot" })).toBeVisible();
  await page.getByRole("radio", { name: "Pink" }).click();
  await page.getByRole("radio", { name: "Cloud" }).click();
  await expect(
    page
      .getByRole("heading", { name: "New Bot" })
      .locator("[data-shape='cloud']"),
  ).toHaveAttribute("data-color", "#ec4899");
  await page.getByRole("textbox", { name: "Name" }).fill("Echo");
  await page.getByRole("button", { name: "Get started" }).click();
  await expect(page.getByRole("heading", { name: "Echo" })).toBeVisible();
  await expect(page.getByText("What should I help with?")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Theme:/ })).toBeVisible();
  await expect(
    page
      .getByRole("button", { name: "Echo", exact: true })
      .locator("[data-shape='cloud']"),
  ).toHaveAttribute("data-color", "#ec4899");

  await page.getByRole("button", { name: "Echo", exact: true }).click({
    button: "right",
  });
  await page.getByRole("menuitem", { name: "Change avatar" }).click();
  await expect(
    page.getByRole("heading", { name: "Change avatar" }),
  ).toBeVisible();
  await page.getByRole("radio", { name: "Green" }).click();
  await page.getByRole("radio", { name: "Sprout" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page
      .getByRole("heading", { name: "Echo" })
      .locator("[data-shape='sprout']"),
  ).toHaveAttribute("data-color", "#1fbf68");
  await expect(
    page
      .getByRole("button", { name: "Echo", exact: true })
      .locator("[data-shape='sprout']"),
  ).toHaveAttribute("data-color", "#1fbf68");
  await expect(page.getByText("What should I help with?")).toBeVisible();

  await page.reload();
  await expect(
    page
      .getByRole("heading", { name: "Echo" })
      .locator("[data-shape='sprout']"),
  ).toHaveAttribute("data-color", "#1fbf68");
  await expect(
    page
      .getByRole("button", { name: "Echo", exact: true })
      .locator("[data-shape='sprout']"),
  ).toHaveAttribute("data-color", "#1fbf68");
  await expect(page.getByText("What should I help with?")).toBeVisible();
});

function release(): void {
  writeFileSync(gateFile, "go");
}
