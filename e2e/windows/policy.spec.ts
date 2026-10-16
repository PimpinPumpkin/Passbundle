import { chromium, expect, test } from "@playwright/test";

// Runs after installer/windows/tests/Test-Install.ps1 has applied the policies
// on this machine. Confirms the real browsers picked them up.
const browsers = [
  { channel: "chrome", page: "chrome://policy" },
  { channel: "msedge", page: "edge://policy" },
];

for (const b of browsers) {
  test(`${b.channel} reports PassBundle's policies`, async () => {
    const browser = await chromium.launch({ channel: b.channel });
    const page = await browser.newPage();
    await page.goto(b.page);
    await expect(page.getByText("PasswordManagerEnabled", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("ExtensionInstallForcelist", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("AutofillCreditCardEnabled", { exact: true }).first()).toBeVisible();
    await browser.close();
  });
}
