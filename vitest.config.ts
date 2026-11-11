import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/daemon/**/*.test.ts",
      "packages/shared/**/*.test.ts",
      "apps/web/**/*.test.ts",
    ],
  },
});
