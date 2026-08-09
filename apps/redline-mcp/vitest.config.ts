import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    exclude: ["**/node_modules/**", "**/dist/**"],
    // The exit-test suite starts a real HTTP server and drives a real MCP client
    // over it; the default 5s is tight for a PGlite boot plus two round trips.
    testTimeout: 30_000,
  },
});
