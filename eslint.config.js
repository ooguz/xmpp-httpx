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
  { ignores: ["dist/", "node_modules/", "coverage/", "examples/*/dist/"] },
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
    ignores: ["src/node/**"],
    rules: {
      "no-restricted-globals": ["error", ...PLATFORM_SPECIFIC_GLOBALS],
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
        URL: "readonly",
      },
    },
  },
);
