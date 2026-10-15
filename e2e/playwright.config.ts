import { defineConfig, devices } from "@playwright/test";

import { fixturePort, hostResolverRules, port } from "./paths.mjs";

// Tier 1 rules: no retries (a flaky test gets fixed, not rerun), one worker,
// fixed timezone and locale, artifacts only for failures.
export default defineConfig({
  testDir: "tests",
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    // No live network: every host except the local test server fails to
    // resolve, instantly and the same way every run.
    launchOptions: { args: [hostResolverRules] },
    baseURL: `https://127.0.0.1:${port}`,
    ignoreHTTPSErrors: true,
    timezoneId: "UTC",
    locale: "en-US",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    {
      command: "node server.mjs",
      url: `https://127.0.0.1:${port}/alive`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "node fixture-server.mjs",
      url: `https://127.0.0.1:${fixturePort}/alive`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
  projects: [
    // Black-box tests of the server's HTTP API. No browser.
    { name: "api", testDir: "tests/api" },
    { name: "chromium", testIgnore: "api/**", use: { ...devices["Desktop Chrome"] } },
  ],
});
