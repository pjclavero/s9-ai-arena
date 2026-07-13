import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["apps/**/tests/**/*.test.ts", "packages/**/*.test.ts"],
    testTimeout: 180000,
    hookTimeout: 60000,
  },
});
