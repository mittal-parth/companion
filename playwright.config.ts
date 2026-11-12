import { defineConfig, devices } from "@playwright/test";

const live = process.env.COMPANION_LIVE === "1";
const configured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() &&
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() &&
  process.env.BINDU_DEV_EMAIL &&
  process.env.BINDU_DEV_PASS,
);

/**
 * Browser tests for the chat. The server is the built app and a local daemon.
 * A live run talks to OpenCode. The default run uses the scripted engine.
 */
export default defineConfig({
  testDir: "e2e",
  testMatch: live ? "chat.live.spec.ts" : ["auth.spec.ts", "chat.spec.ts"],
  globalSetup: configured ? "./e2e/global-setup.ts" : undefined,
  fullyParallel: false,
  workers: 1,
  timeout: live ? 360_000 : 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://127.0.0.1:3011",
    storageState: configured ? "e2e/.auth/state.json" : undefined,
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
