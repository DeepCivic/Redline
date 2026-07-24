import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // The Playwright e2e suite runs under its own runner, not vitest.
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
  },
});
