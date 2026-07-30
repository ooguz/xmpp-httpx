import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

// Globals that only exist in Node.js or only in browsers. The core library
// (everything outside src/node/) must run unmodified in both environments.
const PLATFORM_SPECIFIC_GLOBALS = [
  { name: "Buffer", message: "Use Uint8Array — Buffer is Node-only." },
  { name: "process", message: "Node-only; keep the core browser-safe." },
  { name: "require", message: "This package is ESM-only." },
  { name: "__dirname", message: "Node-only; keep the core browser-safe." },
  { name: "document", message: "Browser-only; keep the core Node-safe." },
  { name: "window", message: "Browser-only; use globalThis instead." },
  { name: "navigator", message: "Browser-only; keep the core Node-safe." },
];

export default tseslint.config(
  {
    // docs/api/ is generated typedoc output (gitignored); it only exists after
    // a local `npm run docs:api`, and linting it is meaningless noise.
    ignores: ["dist/", "node_modules/", "coverage/", "examples/*/dist/", "docs/api/"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["src/**/*.ts"],
    // src/node/** and src/cli/** are Node-only by design (sockets, argv, fs).
    ignores: ["src/node/**", "src/cli/**"],
    rules: {
      "no-restricted-globals": ["error", ...PLATFORM_SPECIFIC_GLOBALS],
    },
  },
  {
    // scripts/smoke-browser.mjs drives a real browser: the callbacks it passes
    // to page.evaluate/waitForFunction are serialized and run *in the page*, so
    // browser globals are legitimate there even though the file runs in Node.
    files: ["scripts/smoke-browser.mjs"],
    languageOptions: {
      globals: {
        document: "readonly",
        getComputedStyle: "readonly",
      },
    },
  },
  {
    // examples/electron/chrome.js is the shell's chrome renderer: a plain
    // browser script loaded straight from disk (nothing to build), so it gets
    // browser globals and the `httpx` bridge the preload exposes.
    files: ["examples/electron/chrome.js"],
    languageOptions: {
      globals: {
        document: "readonly",
        window: "readonly",
      },
    },
  },
  {
    // Standalone runtime scripts (demo gateway, manifest packaging).
    files: ["scripts/**/*.mjs", "examples/*/scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        atob: "readonly",
        btoa: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        queueMicrotask: "readonly",
        ReadableStream: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
      },
    },
  },
);
