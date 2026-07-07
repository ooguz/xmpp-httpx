import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset URLs — extension pages are served from moz-extension://
  // and chrome-extension:// roots.
  base: "./",
  build: {
    outDir: "dist/app",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: {
        browser: "browser.html",
      },
    },
  },
});
