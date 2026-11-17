/**
 * The real end to end for Task 4.5, against a running web app that has
 * provisioning on and a deployed host: sign in as the dev account, watch the
 * setup screen provision a computer, create a bot (its opening turn is a real
 * model turn through the relay and the microVM), then send one more message.
 * Prints a timeline and saves screenshots; exits non-zero on the first failure.
 *
 *   pnpm exec tsx infra/scripts/e2e-real-host.ts [outputDir]
 *
 * The web app must already be running (default http://127.0.0.1:3000) and the
 * dev sign-in variables must be set. Nothing secret is printed.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { devSessionCookies } from "../../e2e/session.ts";

const base = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
const out = process.argv[2] ?? "/tmp/e2e-real";
mkdirSync(out, { recursive: true });
const started = Date.now();
const at = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const log = (line: string) => console.log(`[${at()}] ${line}`);

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
});
await context.addCookies(await devSessionCookies());
const page = await context.newPage();
try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  log("opened the app");

  // The setup screen reports its state in data-vm-status until the computer answers.
  const setup = page.locator("[data-vm-status]");
  if ((await setup.count()) > 0) {
    log(`setup screen: ${await setup.getAttribute("data-vm-status")}`);
    await page.screenshot({ path: join(out, "1-setup.png") });
    await page.waitForFunction(
      () => {
        const status = document
          .querySelector("[data-vm-status]")
          ?.getAttribute("data-vm-status");
        if (status === "failed")
          throw new Error("The setup screen reported failed.");
        return status === "ready" || status === undefined;
      },
      undefined,
      { timeout: 12 * 60_000, polling: 2000 },
    );
    log("computer ready, the app is opening");
  } else {
    log("no setup screen: the computer was already ready");
  }

  // A new computer shows the create screen. One that already has a bot opens its chat.
  const name = page.getByLabel("Name", { exact: true });
  const message = page.getByLabel("Message");
  await name
    .or(message)
    .first()
    .waitFor({ timeout: 4 * 60_000 });
  if (await name.isVisible()) {
    await page.screenshot({ path: join(out, "2-create.png") });
    await name.fill("Ada");
    await page.getByRole("button", { name: "Get started" }).click();
    log("creating a bot: its opening turn runs on the microVM");
  } else {
    log("a bot already exists: opening its chat");
  }
  const assistant = page.locator(".is-assistant").first();
  await assistant.waitFor({ timeout: 4 * 60_000 });
  log(
    `greeting: ${(await assistant.innerText()).slice(0, 160).replace(/\n/g, " ")}`,
  );
  await page.screenshot({ path: join(out, "3-greeting.png") });

  // Each turn counts only once it has finished: a thought quotes the prompt, so
  // the expected word alone can appear long before the answer does.
  // A reply that admits the tool did not work fails the turn, even if it names what was asked for.
  const refusal =
    /isn'?t available|not available|failed|couldn'?t|can'?t|unable|missing/i;
  const turns: { prompt: string; expect: RegExp; label: string }[] = [
    {
      label: "plain reply",
      prompt: "Reply with exactly the word pong and nothing else.",
      expect: /\bpong\b/i,
    },
    ...(process.argv.includes("--tools")
      ? [
          {
            label: "browser",
            prompt:
              "Use your browser command to open https://example.com and reply with only the page's main heading.",
            expect: /example domain/i,
          },
          {
            label: "desktop",
            prompt:
              "Use your desktop command to launch the calculator app, then reply with only the title of the window that opened.",
            expect: /calc/i,
          },
        ]
      : []),
  ];
  for (const [index, turn] of turns.entries()) {
    await message.fill(turn.prompt);
    await page.getByRole("button", { name: "Submit" }).click();
    await page.locator("[data-turn-status]").waitFor({ timeout: 60_000 });
    await page.locator("[data-turn-status]").waitFor({
      state: "detached",
      timeout: 6 * 60_000,
    });
    const reply = (await page.locator(".is-assistant").last().innerText())
      .replace(/Thought for [^\n]*/g, "")
      .trim();
    log(
      `${turn.label} turn finished, reply: ${reply.slice(0, 100).replace(/\n/g, " ")}`,
    );
    await page.screenshot({ path: join(out, `4-${index}-${turn.label}.png`) });
    if (!turn.expect.test(reply) || refusal.test(reply)) {
      throw new Error(`The ${turn.label} reply did not match ${turn.expect}.`);
    }
  }
  log("end to end passed");
} catch (error) {
  log(`FAILED: ${(error as Error).message.split("\n")[0]}`);
  await page.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
