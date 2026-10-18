import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    // many tests build a whole fixture day (a full snapshot plan) and several run a stand-in agent session; on a loaded machine the 5 s default timed some of them out
    testTimeout: 30_000,
    hookTimeout: 30_000,
    exclude: ["**/dist/**", "**/node_modules/**"],
  },
});
