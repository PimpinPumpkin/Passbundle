import { type Browser, chromium, expect, type Page, test } from "@playwright/test";

// Runs after installer/linux/tests/test-install.sh has applied the policies
// on this machine. Confirms the real browsers picked up our policy files.
const browsers = [
  { channel: "chrome", page: "chrome://policy" },
  { channel: "msedge", page: "edge://policy" },
];

for (const b of browsers) {
  test.describe(b.channel, () => {
    let browser: Browser | undefined;
    let page: Page;

    // A browser's first start on a fresh runner reads hundreds of megabytes
    // from a disk the cloud fills in as it's read, and builds its first-run
    // caches: from a few seconds to half a minute, depending on the runner,
    // where every later start takes a fraction of a second. That isn't what
    // this checks, so it has a limit of its own, apart from the test's.
    test.beforeAll(async () => {
      test.setTimeout(120_000);
      browser = await chromium.launch({ channel: b.channel });
      page = await browser.newPage();
    });

    test.afterAll(async () => {
      test.setTimeout(60_000);
      await browser?.close();
    });

    test(`${b.channel} reports PassBundle's policies`, async () => {
      await page.goto(b.page);
      await expect(page.getByText("PasswordManagerEnabled", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("ExtensionInstallForcelist", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("AutofillCreditCardEnabled", { exact: true }).first()).toBeVisible();
    });
  });
}
