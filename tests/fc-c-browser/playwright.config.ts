/** FC-C · Playwright 1.48.2 (imagen mcr.microsoft.com/playwright:v1.48.2-jammy), ver run.sh. */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  timeout: 240_000,
  retries: 0,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.FC_C_BASE_URL ?? "http://127.0.0.1:4317",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    actionTimeout: 15_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
