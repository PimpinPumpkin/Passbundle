import { defineConfig } from "@playwright/test";

// Tier 2 browser checks on a Linux machine with real Chrome and Edge.
// No test server: these only read the browsers' own policy pages.
export default defineConfig({
  testDir: "linux",
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
