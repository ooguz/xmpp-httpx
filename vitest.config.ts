import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

// unit/ and integration/ are browser-safe by design (no Node APIs; fixtures
// arrive via `?raw` imports). e2e/ needs Node + Docker and only exists when
// E2E=1 is set.
const BROWSER_SAFE = [
  "test/unit/**/*.test.ts",
  "test/integration/**/*.test.ts",
];

export default defineConfig({
  test: {
    testTimeout: 10_000,
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: BROWSER_SAFE,
        },
      },
      {
        test: {
          name: "browser",
          include: BROWSER_SAFE,
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
      ...(process.env.E2E
        ? [
            {
              test: {
                name: "e2e",
                include: ["test/e2e/**/*.e2e.test.ts"],
                globalSetup: "./test/e2e/global-setup.ts",
                testTimeout: 60_000,
                hookTimeout: 180_000,
              },
            },
          ]
        : []),
    ],
  },
});
