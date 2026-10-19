// The website's screenshots (site/static/shots), made from the real apps on the
// same test server the tests use. Not a test: run it when the look or a screen
// the site shows changes, then commit the images. See site/README.md.
//   npx playwright test -c playwright.site.config.ts
import { defineConfig, devices } from "@playwright/test";

import { siteHostRules } from "./paths.mjs";
import base from "./playwright.config";

const servers = Array.isArray(base.webServer) ? base.webServer : [base.webServer!];

export default defineConfig({
  ...base,
  testDir: "site-shots",
  reporter: "list",
  // Only the main test server.
  webServer: servers.slice(0, 1),
  projects: [
    {
      name: "site-shots",
      use: { ...devices["Desktop Chrome"], launchOptions: { args: [siteHostRules] } },
    },
  ],
});
