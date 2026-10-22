// The "Vault lock" policy's page in the web vault: an owner chooses when
// members' vaults lock and what happens then, and the page shows it again as
// saved. See docs/core.md, "Locking by policy".
import { expect, test, type Locator, type Page } from "@playwright/test";

import { signUp, webUserFor } from "./support/web";

/** A toast message. Toasts here have no ARIA role, so find them by text. */
const toast = (page: Page, text: string) => page.getByText(text, { exact: true });

/** The longest wait's select, which shows its choice beside its search box. */
const atMost = (dialog: Locator) =>
  dialog.locator("ng-select").filter({ has: dialog.page().getByRole("combobox", { name: "At most" }) });

async function openVaultLock(page: Page, org: string, state: "On" | "Off") {
  await page.goto("/#/vault");
  await page.goto(`${org}/settings/policies`);
  await page.getByRole("button", { name: new RegExp(`^Vault lock .* ${state}$`) }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("radio", { name: /^After a time/ })).toBeVisible();
  return dialog;
}

test("an owner sets when members' vaults lock, and the page shows it as saved", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await signUp(page, webUserFor("vault-lock-owner", testInfo.repeatEachIndex));
  await page.goto("/#/create-organization");
  await page.getByRole("textbox", { name: /Organization name/ }).fill("Lakeside Dental");
  await page.getByRole("radio", { name: /A family or a group/ }).check();
  await page.getByRole("button", { name: "Create organization" }).click();
  await page.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  const org = page.url().replace(/\/members.*$/, "");

  // Off at first, offering a longest wait of 15 minutes, then locking.
  let dialog = await openVaultLock(page, org, "Off");
  await expect(dialog.getByRole("radio", { name: /^After a time/ })).toBeChecked();
  await expect(atMost(dialog)).toContainText("15 minutes");
  await expect(dialog.getByRole("radio", { name: /^Lock the vault/ })).toBeChecked();

  // On: a longest wait of 4 hours.
  await dialog.getByRole("checkbox", { name: "Turn on" }).check();
  await dialog.getByRole("combobox", { name: "At most" }).click();
  await page.getByRole("option", { name: "4 hours" }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(toast(page, "Edited policy Vault lock.")).toBeVisible();

  dialog = await openVaultLock(page, org, "On");
  await expect(dialog.getByRole("checkbox", { name: "Turn on" })).toBeChecked();
  await expect(atMost(dialog)).toContainText("4 hours");

  // Immediately, signing out: no wait to choose.
  await dialog.getByRole("radio", { name: /^Immediately/ }).check();
  await expect(dialog.getByRole("combobox", { name: "At most" })).toHaveCount(0);
  await dialog.getByRole("radio", { name: /^Sign out/ }).check();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(toast(page, "Edited policy Vault lock.")).toBeVisible();

  dialog = await openVaultLock(page, org, "On");
  await expect(dialog.getByRole("radio", { name: /^Immediately/ })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: /^Sign out/ })).toBeChecked();
});
