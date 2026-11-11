import { defineConfig, devices } from "@playwright/test";

const live = process.env.COMPANION_LIVE === "1";

/**
 * Browser tests for the chat. The server is the built app and a local daemon.
 * A live run talks to OpenCode. The default run uses the scripted engine.
 */
export default defineConfig({
  testDir: "e2e",
  testMatch: live ? "chat.live.spec.ts" : "chat.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: live ? 360_000 : 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://127.0.0.1:3011",
    navigationTimeout: live ? 180_000 : 30_000,
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "pnpm exec tsx apps/daemon/scripts/serve-chat.ts",
    url: "http://127.0.0.1:3011",
    timeout: live ? 300_000 : 120_000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      PORT: "3011",
    },
  },
});
