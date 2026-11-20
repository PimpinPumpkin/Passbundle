// The admin console's Export, by role (DESIGN.md, "Folders and permissions",
// B39). It opens for owners, admins, and custom roles with import and export.
// Owners and admins, and a custom role that also has access to all items,
// export the whole organization from the server, items in no folder included.
// A custom role without access to all items exports the shared folders where
// it can export, from its own synced items, as the Password Manager's Export
// does: the server's export refuses it, which used to end in an error.
import fs from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import { exportedNames, exportScenario } from "./support/organization-export";
import { type RealAccount } from "./support/vault-crypto";
import { menu } from "./support/web";

async function logIn(page: Page, account: RealAccount) {
  await page.goto("/#/login");
  await page.getByLabel(/Email address/).fill(account.email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("textbox", { name: /Master password/ }).fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(menu(page)).toBeVisible({ timeout: 30_000 });
}

/**
 * The organization's Export page's unencrypted .json, with the requests for
 * the server's export of the whole organization, and every API request
 * refused as unauthorized or forbidden (on which the web vault signs out).
 */
async function exportFromAdminConsole(page: Page, account: RealAccount, orgId: string) {
  const wholeExports: string[] = [];
  const refused: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes(`/api/organizations/${orgId}/export`)) {
      wholeExports.push(request.url());
    }
  });
  page.on("response", (response) => {
    if ([401, 403].includes(response.status()) && response.url().includes("/api/")) {
      refused.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
  await page.goto(`/#/organizations/${orgId}/settings/tools/export`);
  await expect(page.getByText(/Only items in the shared folders of .* that you can export will export/)).toBeVisible();
  await page.getByRole("combobox", { name: /File format/ }).selectOption({ label: ".json" });
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Confirm export" });
  await confirm.getByRole("textbox", { name: /Master password/ }).fill(account.password);
  // The file, or the page's error, whichever comes first.
  const failed = page.getByText("An error occurred while exporting your items").first();
  const downloaded = page.waitForEvent("download", { timeout: 30_000 }).catch(() => null);
  await confirm.getByRole("button", { name: "Continue" }).click();
  const download = await Promise.race([
    downloaded,
    failed.waitFor({ timeout: 30_000 }).then(
      () => null,
      () => null,
    ),
  ]);
  expect(download, "the export page's error instead of a file").not.toBeNull();
  const exported = JSON.parse(fs.readFileSync((await download!.path())!, "utf8"));
  expect(exported.encrypted).toBe(false);
  await expect(page.getByText("Items exported").first()).toBeVisible();
  // Still signed in, on the page.
  await expect(page).toHaveURL(/settings\/tools\/export/);
  await expect(page.getByRole("button", { name: "Export", exact: true })).toBeVisible();
  return { exported, wholeExports, refused };
}

test("the admin console's Export gives a custom role without access to all items the shared folders it can export, and the owner the whole organization", async ({
  browser,
  request,
}) => {
  test.setTimeout(180_000);
  const s = await exportScenario(request, "web-export");

  // A custom role with import and export, without access to all items:
  // Reports, where it can export, from its own items. Nothing from Payroll
  // (view only), Domain admins (passwords hidden), Archive (not its), or the
  // item in no folder; the item in Reports and Payroll goes. The server's
  // export of the whole organization isn't asked for.
  const customContext = await browser.newContext();
  const custom = await customContext.newPage();
  await logIn(custom, s.customRole);
  const theirs = await exportFromAdminConsole(custom, s.customRole, s.org.id);
  expect(exportedNames(theirs.exported)).toEqual(s.theirs);
  const sharedDrive = theirs.exported.items.find((i: { name: string }) => i.name === "Shared drive");
  expect(sharedDrive.login.password).toBe("shared-drive-password");
  expect(theirs.wholeExports).toEqual([]);
  expect(theirs.refused).toEqual([]);
  await customContext.close();

  // The owner: the whole organization, from the server, with the item in no folder.
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  await logIn(owner, s.owner);
  const everything = await exportFromAdminConsole(owner, s.owner, s.org.id);
  const names = exportedNames(everything.exported);
  expect(names.items).toEqual(s.everything);
  expect(names.folders).toEqual(expect.arrayContaining(s.folders));
  expect(everything.wholeExports).toHaveLength(1);
  expect(everything.refused).toEqual([]);
  await ownerContext.close();
});
