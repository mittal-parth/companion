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

test("a message streams markdown and hides the tool call", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(inChat(page, "What should I help with?")).toBeVisible();
  await expect(preview(page, "Companion")).toHaveText(
    "Hello. What should I help with?",
  );
  await expect(page.locator("[data-turn-status]")).toHaveCount(0);
  await page.getByLabel("Message").fill("Say something");
  await page.getByRole("button", { name: "Submit" }).click();
  const replies = page.locator(".is-assistant");
  await expect(replies.filter({ hasText: "Working on it" })).toHaveCount(1);
  await expectBubbles(page);
  await expect(inChat(page, "All finished.")).toHaveCount(0);
  await expect(preview(page, "Companion")).toHaveText("Working on it.");
  await expect(page.getByText("read note")).toHaveCount(0);
  await expectTurnStatus(page);
  release();
  await expect(
    page.locator("[data-streamdown='strong']", { hasText: "All finished." }),
  ).toBeVisible();
  await expect(preview(page, "Companion")).toContainText("All finished.");
  await expect(page.getByText("read note")).toHaveCount(0);
  await expect(page.getByText("marigold")).toHaveCount(0);
  await expect(page.locator("[data-turn-status]")).toHaveCount(0);
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
  await expect(page.locator("[data-turn-status]")).toBeVisible();
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
  await expect(page.locator("[data-turn-status]")).toHaveCount(0);
});

test("a reload mid-turn keeps the reply going", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Message").fill("Keep going");
  await page.getByRole("button", { name: "Submit" }).click();
  await expect(inChat(page, "Keep going")).toBeVisible();
  await expect(
    page.locator(".is-assistant").filter({ hasText: "Working on it" }),
  ).toHaveCount(3);
  const status = page.locator("[data-turn-status]");
  await expect(status).toBeVisible();
  const finished = page.locator("[data-streamdown='strong']", {
    hasText: "All finished.",
  });
  await expect(finished).toHaveCount(2);
  await page.reload();
  await expect(inChat(page, "Keep going")).toBeVisible();
  await expect(status).toBeVisible();
  await expect(
    page.locator(".is-assistant").filter({ hasText: "Working on it" }),
  ).toHaveCount(3);
  await expect(finished).toHaveCount(2);
  release();
  await expect(finished).toHaveCount(3);
  await expect(page.locator("[data-turn-status]")).toHaveCount(0);
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

/** The row under the bot's latest reply: its picture, three dots, and a line that changes. */
async function expectTurnStatus(page: Page): Promise<void> {
  const status = page.locator("[data-turn-status]");
  await expect(status).toBeVisible();
  await expect(status.locator("[data-shape='controller']")).toHaveAttribute(
    "data-mood",
    "thinking",
  );
  await expect(status.locator("[data-turn-dot]")).toHaveCount(3);
  const look = await status.getAttribute("data-look");
  await expect(status).not.toHaveAttribute("data-look", look ?? "", {
    timeout: 4_000,
  });
  const line = await status.getAttribute("data-status-line");
  await expect(status).not.toHaveAttribute("data-status-line", line ?? "", {
    timeout: 6_000,
  });
  await expect(status).toContainText(
    /Collecting details|Working on it|Thinking it through|Checking the thread|Putting it together/,
  );
}

function background(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

test("a sidebar row renames in place and delete opens the next bot", async ({
  page,
}) => {
  await page.goto("/");
  await expect(inChat(page, "Keep going")).toBeVisible();
  await expect(preview(page, "Companion")).toContainText("All finished.");
  await page.getByRole("button", { name: "New bot" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Ada");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Ada" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Rename/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Theme:/ })).toBeVisible();
  await expect(inChat(page, "Keep going")).toHaveCount(0);
  await expect(inChat(page, "What should I help with?")).toBeVisible();
  await expect(preview(page, "Ada")).toHaveText(
    "Hello. What should I help with?",
  );
  await expect(preview(page, "Companion")).toContainText("All finished.");

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
  await page
    .locator("[role='log']")
    .getByText("What should I help with?")
    .click();
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
  await expect(inChat(page, "Keep going")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Companion" })).toBeVisible();
  await expect(inChat(page, "Keep going")).toBeVisible();
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
  await expect(inChat(page, "Keep going")).toBeVisible();
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
  await expect(inChat(page, "Keep going")).toBeVisible();

  await page.getByRole("button", { name: "Companion", exact: true }).click({
    button: "right",
  });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("heading", { name: "Nightly" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Companion", exact: true }),
  ).toHaveCount(0);
  await expect(inChat(page, "Keep going")).toHaveCount(0);
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
  await expect(inChat(page, "What should I help with?")).toBeVisible();
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
  await expect(inChat(page, "What should I help with?")).toBeVisible();

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
  await expect(inChat(page, "What should I help with?")).toBeVisible();
});

test("the schedules column lists the open bot and can pause a schedule", async ({
  page,
}) => {
  await page.goto("/");
  const heading = page.getByRole("heading", { name: "Echo" });
  await expect(heading).toBeVisible();
  await expect(page.getByRole("heading", { name: "Schedules" })).toHaveCount(0);
  await expect(heading.locator("[data-shape='sprout']")).toHaveAttribute(
    "data-color",
    "#1fbf68",
  );

  const header = page.locator("header").filter({
    has: page.getByRole("button", { name: /^Theme:/ }),
  });
  const headerBox = await header.boundingBox();
  const headingBox = await heading.boundingBox();
  expect(headerBox).toBeTruthy();
  expect(headingBox).toBeTruthy();
  if (headerBox !== null && headingBox !== null) {
    const headerCenter = headerBox.x + headerBox.width / 2;
    const headingCenter = headingBox.x + headingBox.width / 2;
    expect(Math.abs(headingCenter - headerCenter)).toBeLessThan(24);
  }

  await seedEchoSchedules();
  await page.getByRole("button", { name: "Schedules for Echo" }).click();
  const panel = page.getByRole("complementary", { name: "Schedules" });
  await expect(panel.getByRole("heading", { name: "Schedules" })).toBeVisible();
  await expect(panel.locator("[data-shape='sprout']")).toHaveAttribute(
    "data-color",
    "#1fbf68",
  );
  await expect(panel.getByText("Echo", { exact: true })).toBeVisible();
  await expect(panel.getByText("Morning briefing")).toBeVisible();
  await expect(panel.getByText("Every day at 8:00 AM")).toBeVisible();
  await expect(panel.getByText("Inbox cleanup")).toBeVisible();
  await expect(panel.getByText("Weekdays at 6:00 PM")).toBeVisible();
  await expect(panel.getByText("Next run").first()).toBeVisible();
  await expect(panel.getByText("Last receipt None").first()).toBeVisible();
  await expect(panel.getByRole("textbox")).toHaveCount(0);
  await expect(panel.getByText("Routines")).toHaveCount(0);
  await expect(page.getByLabel("Message")).toBeVisible();

  const morning = panel
    .getByRole("listitem")
    .filter({ hasText: "Morning briefing" });
  await morning
    .getByRole("switch", { name: "Disable Morning briefing" })
    .click();
  await expect(morning.getByText("Paused")).toBeVisible();
  await expect(morning.getByText("Next run None")).toBeVisible();
  await expect(morning.getByRole("switch")).not.toBeChecked();
  expect(await echoSchedule("Morning briefing")).toMatchObject({
    paused: true,
    nextRunAt: null,
  });

  await morning
    .getByRole("switch", { name: "Enable Morning briefing" })
    .click();
  await expect(morning.getByText("Every day at 8:00 AM")).toBeVisible();
  await expect(morning.getByText("Next run None")).toHaveCount(0);
  await expect(morning.getByRole("switch")).toBeChecked();
  const enabled = await echoSchedule("Morning briefing");
  expect(enabled.paused).toBe(false);
  expect(enabled.nextRunAt).toEqual(expect.any(String));

  await panel.getByRole("button", { name: "Close schedules" }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByLabel("Message")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Echo", exact: true }),
  ).toBeVisible();
});

/** Two future schedules on Echo, created the way the bot's command would. */
async function seedEchoSchedules(): Promise<void> {
  const { url, token } = await echoAccess();
  const create = async (body: Record<string, unknown>) => {
    const response = await fetch(`${url}/agent/schedules`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(response.ok).toBe(true);
  };
  await create({
    kind: "cron",
    prompt: "Morning briefing",
    expression: "0 8 * * *",
    timezone: "UTC",
  });
  await create({
    kind: "cron",
    prompt: "Inbox cleanup",
    expression: "0 18 * * 1-5",
    timezone: "UTC",
  });
}

async function echoSchedule(prompt: string): Promise<{
  paused: boolean;
  nextRunAt: string | null;
}> {
  const { url, token } = await echoAccess();
  const response = await fetch(`${url}/agent/schedules`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.ok).toBe(true);
  const rows = (await response.json()) as Array<{
    prompt: string;
    paused: boolean;
    nextRunAt: string | null;
  }>;
  const row = rows.find((item) => item.prompt === prompt);
  expect(row).toBeTruthy();
  if (row === undefined) throw new Error(`Missing schedule ${prompt}.`);
  return row;
}

/** The daemon address and Echo's schedule token. */
async function echoAccess(): Promise<{ url: string; token: string }> {
  const url = readFileSync(daemonUrlFile, "utf8").trim();
  const response = await fetch(`${url}/bots`);
  expect(response.ok).toBe(true);
  const bots = (await response.json()) as Array<{
    name: string;
    directory: string;
  }>;
  const echo = bots.find((bot) => bot.name === "Echo");
  expect(echo).toBeTruthy();
  if (echo === undefined) throw new Error("Echo is missing.");
  const access = JSON.parse(
    readFileSync(join(echo.directory, ".companion", "schedule.json"), "utf8"),
  ) as { token: string };
  return { url, token: access.token };
}

function release(): void {
  writeFileSync(gateFile, "go");
}

/** The latest chat line under one bot's name. */
function preview(page: Page, name: string) {
  return page
    .getByRole("button", { name, exact: true })
    .locator("[data-slot='bot-preview']");
}

/** A line in the open conversation. The sidebar repeats the latest one. */
function inChat(page: Page, text: string) {
  return page.locator("[role='log']").getByText(text);
}
