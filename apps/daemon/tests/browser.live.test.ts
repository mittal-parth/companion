/**
 * Proves a real bot drives the shared Chrome: it searches, opens a result and
 * fills a form that rejects the first try, and a login it made survives a
 * daemon restart. It also proves the bot cannot start Chrome on its own.
 * Skipped unless COMPANION_LIVE=1, so CI does not call the provider.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { hasToolCall } from "../src/acp-hello.js";
import { startDaemon } from "../src/api.js";
import { startFixtureSite } from "./fixture-site.js";
import {
  askBot,
  createLiveBot,
  opencodeBin,
  requireOpencode,
} from "./helpers.js";

const live = process.env.COMPANION_LIVE === "1";

test.skipIf(!live)(
  "a bot books through a form, stays signed in across a restart, and cannot start Chrome itself",
  async () => {
    requireOpencode();
    const directory = mkdtempSync(join(tmpdir(), "companion-browser-live-"));
    const site = await startFixtureSite();
    const start = () =>
      startDaemon({ storePath: join(directory, "threads.db"), opencodeBin });
    let daemon = await start();
    try {
      const bot = await createLiveBot(daemon, "Booker");

      const booked = await askBot(
        daemon,
        bot.id,
        `Open ${site.url}/ in the browser and search it for "cottage". Open the second result and book it for Priya Nair on the premium plan, accepting the terms. Reply with the confirmation code the page shows.`,
      );
      expect(hasToolCall(booked.updates), JSON.stringify(booked.events)).toBe(
        true,
      );
      expect(booked.reply, JSON.stringify(booked.events)).toContain(
        site.bookingCode(2, "Priya Nair", "premium"),
      );
      expect(site.requests).toContain("GET /search");
      expect(site.requests).toContain("POST /items/2/book");

      const signedIn = await askBot(
        daemon,
        bot.id,
        `In the browser, sign in at ${site.url}/login as user priya with any password, then reply with the account code the page shows.`,
      );
      expect(signedIn.reply, JSON.stringify(signedIn.events)).toContain(
        site.accountCode("priya"),
      );
      const logins = () =>
        site.requests.filter((entry) => entry === "POST /login").length;
      expect(logins()).toBe(1);

      // The daemon stops, taking Chrome with it. The new Chrome reads the same profile.
      await daemon.close();
      daemon = await start();
      const again = await askBot(
        daemon,
        bot.id,
        `In the browser, open ${site.url}/account and reply with the account code it shows. Do not sign in again unless the page asks you to.`,
      );
      expect(again.reply, JSON.stringify(again.events)).toContain(
        site.accountCode("priya"),
      );
      expect(logins()).toBe(1);

      const raw = await askBot(
        daemon,
        bot.id,
        "Run the shell command `google-chrome --version` and tell me exactly what happened. Do not use the browser command for this.",
      );
      const failed = raw.updates.some(
        (update) =>
          update.sessionUpdate === "tool_call_update" &&
          update.status === "failed",
      );
      expect(failed, JSON.stringify(raw.events)).toBe(true);
    } finally {
      await daemon.close();
      await site.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  900_000,
);
