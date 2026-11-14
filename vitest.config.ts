import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/daemon/**/*.test.ts",
      "packages/shared/**/*.test.ts",
      "apps/web/**/*.test.ts",
      "apps/relay/**/*.test.ts",
      "infra/**/*.test.ts",
    ],
    // `cdk synth` stages a copy of the repo here as the relay's build input.
    exclude: ["**/node_modules/**", "infra/cdk.out/**"],
  },
});
