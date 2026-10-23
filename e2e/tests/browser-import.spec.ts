// Guided import from a browser's own password manager, in the web vault and
// the extension: the steps for the person's browser, their export file in,
// what's already in the vault left out, a different password set aside to
// compare, and a reminder to delete the export. See DESIGN.md, "Browser import".
import { expect, test as webTest, type Page } from "@playwright/test";

import { addLogin } from "./support/autofill";
import {
  createAccount,
  test as extensionTest,
  logInPopup,
  openPopup,
  userFor,
} from "./support/extension";
import { signUp, webUserFor } from "./support/web";

const chromeExport = [
  "name,url,username,password,note",
  // Already in the vault.
  "bank.example.test,https://bank.example.test/,ana@example.test,same-password,",
  // A different password from the login the person has.
  "mail.example.test,https://mail.example.test/,ana,new-password,",
  // New, then the same again.
  "shop.example.test,https://shop.example.test/,ana,shop-password,",
  "shop.example.test,https://shop.example.test/,ana,shop-password,",
  // Nothing to sign in with.
  "blank.example.test,https://blank.example.test/,ana,,",
].join("\n");

const firefoxExport = [
  '"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"',
  '"https://forum.example.test","ana","forum-password",,"https://forum.example.test","{1c2d3e4f-0000-4000-8000-000000000001}","1700000000000","1700000000000","1700000000000"',
].join("\n");

const file = (name: string, contents: string) => ({
  name,
  mimeType: "text/csv",
  buffer: Buffer.from(contents),
});

/** The person already has two logins. */
async function existingLogins(page: Page) {
  for (const item of [
    { name: "Bank", username: "ana@example.test", password: "same-password", uri: "https://bank.example.test/login" },
    { name: "Mail", username: "ana", password: "old-password", uri: "https://mail.example.test" },
  ]) {
    await addLogin(page, item);
    // Saving opens the item's view; close it.
    const view = page.getByRole("dialog", { name: "View Login" });
    await view.getByRole("button", { name: "Close" }).first().click();
    await expect(view).toBeHidden();
  }
}

webTest("the web vault walks someone through importing from their browser", async ({
  page,
}, testInfo) => {
  webTest.setTimeout(120_000);
  await signUp(page, webUserFor("browser-import", testInfo.repeatEachIndex));
  await existingLogins(page);

  // The regular import page points the way.
  await page.goto("/#/tools/import");
  await page.getByTestId("browser-import-offer").getByRole("link", { name: "Import from your browser" }).click();
  await expect(page).toHaveURL(/#\/tools\/import-from-browser/);
  const guided = page.getByTestId("browser-import");

  // Each browser's own steps; a web page can't open the browser's own pages.
  await guided.getByRole("radio", { name: "Firefox" }).click();
  await expect(guided.getByTestId("browser-import-steps")).toContainText("logins.csv");
  await guided.getByRole("radio", { name: "Google Chrome" }).click();
  await expect(guided.getByRole("radio", { name: "Google Chrome" })).toHaveAttribute("aria-checked", "true");
  await expect(guided.getByTestId("browser-import-steps")).toContainText("chrome://password-manager/settings");
  await expect(guided.getByRole("button", { name: /^Open .*passwords$/ })).toHaveCount(0);

  // Something that isn't an export is refused by name.
  await guided.getByTestId("browser-import-file").setInputFiles(file("notes.csv", "just some notes"));
  await guided.getByRole("button", { name: "Import", exact: true }).click();
  await expect(guided.getByTestId("browser-import-error")).toContainText("doesn't look like a Google Chrome export");

  await guided.getByTestId("browser-import-file").setInputFiles(file("Chrome Passwords.csv", chromeExport));
  await guided.getByRole("button", { name: "Import", exact: true }).click();
  await expect(guided.getByTestId("browser-import-summary")).toHaveText(
    'Imported 2 logins. 2 were already here. 1 has a different password from a login you have for the same site, so it\'s in the folder "Check these: from Google Chrome" for you to compare. 1 had no password and was skipped.',
  );
  await expect(guided).toContainText("Delete the export now");
  await expect(guided).toContainText("Chrome Passwords.csv");
  await expect(guided.getByTestId("browser-import-turn-off")).toContainText("Offer to save passwords");
  await guided.getByRole("button", { name: "Done" }).click();
  await expect(page).toHaveURL(/#\/vault/);

  // The new login is in the vault, once; the different password is in its folder.
  await expect(page.getByRole("row").filter({ hasText: "shop.example.test" })).toHaveCount(1);
  await page.getByRole("button", { name: "Check these: from Google Chrome" }).first().click();
  await expect(page.getByRole("row").filter({ hasText: "mail.example.test" })).toHaveCount(1);
  await expect(page.getByRole("row").filter({ hasText: "shop.example.test" })).toHaveCount(0);

  // Firefox's export, with its own importer.
  await page.goto("/#/tools/import-from-browser");
  await guided.getByRole("radio", { name: "Firefox" }).click();
  await guided.getByTestId("browser-import-file").setInputFiles(file("logins.csv", firefoxExport));
  await guided.getByRole("button", { name: "Import", exact: true }).click();
  await expect(guided.getByTestId("browser-import-summary")).toHaveText("Imported 1 login.");
});

extensionTest("the extension walks someone through importing from the browser it runs in", async ({
  context,
  extensionId,
}, testInfo) => {
  extensionTest.setTimeout(120_000);
  const person = userFor("browser-import-ext", testInfo.repeatEachIndex);
  const web = await createAccount(context, person);
  await existingLogins(web);
  await web.close();
  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, person);

  // Vault settings has the way in.
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html#/vault-settings`);
  await popup.getByTestId("browser-import-entry").click();
  const guided = popup.getByTestId("browser-import");
  await expect(guided).toBeVisible();
  // The extension can open Chrome's own passwords page.
  await expect(guided.getByRole("radio", { name: "Google Chrome" })).toHaveAttribute("aria-checked", "true");
  await expect(guided.getByRole("button", { name: "Open Google Chrome's passwords" })).toBeVisible();

  await guided.getByTestId("browser-import-file").setInputFiles(file("Chrome Passwords.csv", chromeExport));
  await guided.getByRole("button", { name: "Import", exact: true }).click();
  await expect(guided.getByTestId("browser-import-summary")).toContainText("Imported 2 logins. 2 were already here.");
  await guided.getByRole("button", { name: "Done" }).click();
  await expect(popup).toHaveURL(/#\/tabs\/vault/);
});
