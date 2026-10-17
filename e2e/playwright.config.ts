import { defineConfig, devices } from "@playwright/test";

import {
  fixturePort,
  hostResolverRules,
  limitsServerPort,
  mailHttpPort,
  mailServerPort,
  port,
} from "./paths.mjs";

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
      command: "node mail-server.mjs",
      url: `http://127.0.0.1:${mailHttpPort}/alive`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "node server.mjs",
      env: { KK_MAIL: "1", KK_PORT: mailServerPort },
      url: `https://127.0.0.1:${mailServerPort}/alive`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "node server.mjs",
      env: { KK_LIMITS: "1", KK_PORT: limitsServerPort },
      url: `https://127.0.0.1:${limitsServerPort}/alive`,
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
    // API tests against the server that sends email, read from the mail catcher.
    {
      name: "mail",
      testDir: "tests/mail",
      use: { baseURL: `https://127.0.0.1:${mailServerPort}` },
    },
    {
      name: "chromium",
      testIgnore: ["api/**", "mail/**"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
