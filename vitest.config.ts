import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

// unit/ and integration/ are browser-safe by design (no Node APIs; fixtures
// arrive via `?raw` imports). e2e/ needs Node + Docker and only exists when
// E2E=1 is set. integration-node/ uses raw TCP sockets (SOCKS5 bytestreams)
// and only ever runs under the "node" project. browser/ needs real browser
// APIs (CSSOM, DOMParser, blob URLs) and only ever runs under "browser".
const BROWSER_SAFE = [
  "test/unit/**/*.test.ts",
  "test/integration/**/*.test.ts",
];
const NODE_ONLY = ["test/integration-node/**/*.test.ts"];
const BROWSER_ONLY = ["test/browser/**/*.test.ts"];

export default defineConfig({
  resolve: {
    alias: [
      // The webext sources under test import the library by package name (the
      // example links it with `file:../..`); map it to the sources so the
      // browser tests need no example-level install and no built dist/.
      {
        find: /^xmpp-httpx$/,
        replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      },
    ],
  },
  test: {
    testTimeout: 10_000,
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: [...BROWSER_SAFE, ...NODE_ONLY],
          benchmark: { include: ["test/bench/**/*.bench.ts"] },
          // Root-level testTimeout is not inherited by project entries.
          testTimeout: 15_000,
        },
      },
      {
        test: {
          name: "browser",
          include: [...BROWSER_SAFE, ...BROWSER_ONLY],
          testTimeout: 15_000,
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
