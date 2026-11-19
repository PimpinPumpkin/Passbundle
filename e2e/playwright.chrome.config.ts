// Tier 2 in Google Chrome as a person has it (chrome/): the stable channel
// installed on this machine, not Playwright's Chromium, with the branded
// extension loaded unpacked as a person loads it by hand, against the main
// test server as tier 1 starts it and a site whose checks we didn't write
// (chrome/relying-party.mjs). DESIGN.md, "Passkeys".
//   npx playwright test -c playwright.chrome.config.ts
import { defineConfig } from "@playwright/test";

import { port } from "./paths.mjs";
import base from "./playwright.config";

const servers = Array.isArray(base.webServer) ? base.webServer : [base.webServer!];

export default defineConfig({
  testDir: "chrome",
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    // The tests' own requests to the test server (making accounts, reading
    // what the vault holds). Chrome itself trusts only the keys it's told.
    baseURL: `https://127.0.0.1:${port}`,
    ignoreHTTPSErrors: true,
    timezoneId: "UTC",
    locale: "en-US",
  },
  // The main test server, as tier 1 starts it.
  webServer: [servers[0]],
});
