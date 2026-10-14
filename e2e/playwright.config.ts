import { defineConfig, devices } from "@playwright/test";

import { port } from "./paths.mjs";

// Tier 1 rules: no retries (a flaky test gets fixed, not rerun), one worker,
// fixed timezone and locale, artifacts only for failures.
export default defineConfig({
  testDir: "tests",
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `https://127.0.0.1:${port}`,
    ignoreHTTPSErrors: true,
    timezoneId: "UTC",
    locale: "en-US",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "node server.mjs",
    url: `https://127.0.0.1:${port}/alive`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
