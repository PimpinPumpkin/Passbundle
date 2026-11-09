// The website's screenshots (site/static/shots), made from the real apps on the
// same test server the tests use. Not a test: run it when the look or a screen
// the site shows changes, then commit the images. See site/README.md.
//   npx playwright test -c playwright.site.config.ts
import { defineConfig, devices } from "@playwright/test";

import { siteHost, siteHostRules } from "./paths.mjs";
import base from "./playwright.config";

const servers = Array.isArray(base.webServer) ? base.webServer : [base.webServer!];

export default defineConfig({
  ...base,
  testDir: "site-shots",
  reporter: "list",
  // The main test server, sending email to the mail catcher, as the hosted
  // service does (account recovery is only offered by a server that sends
  // email), and under the hosted service's name (siteHostRules), so the
  // addresses it writes into screens, such as an organization's SCIM address,
  // show vault.passbundle.com.
  webServer: [
    servers[1],
    { ...servers[0], env: { ...servers[0].env, KK_MAIL: "1", KK_DOMAIN: `https://${siteHost}` } },
  ],
  projects: [
    {
      name: "site-shots",
      use: { ...devices["Desktop Chrome"], launchOptions: { args: [siteHostRules] } },
    },
  ],
});
