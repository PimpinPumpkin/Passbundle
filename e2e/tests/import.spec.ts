// Moving from Bitwarden: its own export imports with everything intact.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { signUp, startSignUp, webUserFor, type WebUser } from "./support/web";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "import");
const bitwardenExport = () => fs.readFileSync(path.join(fixtures, "bitwarden-export.json"), "utf8");

/** Imports file contents as "Bitwarden (json)"; answers the file password prompt if asked. */
async function importBitwardenJson(page: Page, contents: string, filePassword?: string) {
  await page.goto("/#/tools/import");
  await page.getByRole("combobox", { name: /File format/ }).click();
  await page.getByRole("option", { name: "Bitwarden (json)" }).click();
  await page.getByRole("textbox", { name: /copy\/paste the import file contents/ }).fill(contents);
  await page.getByRole("button", { name: "Import", exact: true }).click();
  if (filePassword) {
    const prompt = page.getByRole("dialog").filter({ has: page.getByRole("textbox", { name: /password/i }) });
    await prompt.getByRole("textbox", { name: /password/i }).first().fill(filePassword);
    await prompt.getByRole("button", { name: /Import|Confirm|Continue|Submit/ }).first().click();
  }
  return page.getByRole("dialog", { name: "Data successfully imported" });
}

test("imports a Bitwarden export with every item, folder, and detail intact", async ({
  page,
}, testInfo) => {
  await signUp(page, webUserFor("import-bitwarden", testInfo.repeatEachIndex));

  const result = await importBitwardenJson(page, bitwardenExport());

  await expect(result.getByText("A total of 4 items were imported.")).toBeVisible();
  for (const [type, count] of [["Login", "1"], ["Card", "1"], ["Identity", "1"], ["Secure note", "1"], ["Folders", "1"]]) {
    await expect(result.getByRole("row", { name: `${type} ${count}` })).toBeVisible();
  }
  await result.getByRole("button", { name: "Ok" }).click();

  // The login keeps its URL, TOTP secret, notes, and custom fields.
  await page.goto("/#/vault");
  await page.getByText("Example Git host").first().click();
  const view = page.getByRole("dialog", { name: "View Login" });
  await expect(view.getByRole("textbox", { name: "Username" })).toHaveValue("alice-git");
  await expect(view.getByRole("textbox", { name: "Website" })).toHaveValue("git.example.test");
  await expect(view.getByRole("textbox", { name: "Verification code (TOTP)" })).toHaveValue(/^\d{3} \d{3}$/);
  await expect(view.getByRole("textbox", { name: "Note" })).toHaveValue("Recovery codes are in the safe.");
  await expect(view.getByRole("textbox", { name: "Recovery email" })).toHaveValue("alice.recovery@example.test");
  await expect(view.getByRole("textbox", { name: "Backup code" })).toBeVisible();
  await expect(view.getByRole("button", { name: "Password history" })).toBeVisible();
  await view.getByRole("button", { name: "Close" }).click();

  // The folder came along with its two items, and the other types are there.
  await page.getByRole("button", { name: "Work" }).first().click();
  await expect(page.getByText("Example Git host").first()).toBeVisible();
  await expect(page.getByText("Office door code").first()).toBeVisible();
  await page.goto("/#/vault");
  await expect(page.getByText("Test Visa").first()).toBeVisible();
  await expect(page.getByText("Alice at home").first()).toBeVisible();
});

test("a new account brings a Bitwarden export over before its vault opens", async ({ page }, testInfo) => {
  await startSignUp(page, webUserFor("setup-import", testInfo.repeatEachIndex));
  await page.getByRole("button", { name: /^Bitwarden/ }).click();
  await expect(page.getByRole("heading", { name: "From Bitwarden", exact: true })).toBeVisible();
  await expect(page.getByText("In Bitwarden's web vault, open Tools, then Export vault.")).toBeVisible();

  // The importer is already set to Bitwarden's export: paste it and import.
  await page.getByRole("textbox", { name: /copy\/paste the import file contents/ }).fill(bitwardenExport());
  await page.getByRole("button", { name: "Import", exact: true }).click();
  const result = page.getByRole("dialog", { name: "Data successfully imported" });
  await expect(result.getByText("A total of 4 items were imported.")).toBeVisible();
  await result.getByRole("button", { name: "Ok" }).click();

  // Then a reminder about the export, and on to the vault, with the items.
  await expect(page.getByText("Delete the export now")).toBeVisible();
  await page.getByRole("button", { name: "Go to my vault" }).click();
  await page.waitForURL(/#\/vault/);
  await expect(page.getByText("Example Git host").first()).toBeVisible();
  await expect(page.getByText("Test Visa").first()).toBeVisible();
});

test("a password-protected export moves everything to another account, with no plaintext on disk", async ({
  page,
}, testInfo) => {
  const alice: WebUser = webUserFor("export-from", testInfo.repeatEachIndex);
  await signUp(page, alice);
  const imported = await importBitwardenJson(page, bitwardenExport());
  await imported.getByRole("button", { name: "Ok" }).click();

  // Export, encrypted with a file password.
  await page.goto("/#/tools/export");
  await page.getByRole("combobox", { name: /File format/ }).selectOption({ label: ".json (Encrypted)" });
  await page.getByRole("radio", { name: /Password protected/ }).check();
  await page.getByRole("textbox", { name: /^File password/ }).fill("file-password-123");
  await page.getByRole("textbox", { name: /^Confirm file password/ }).fill("file-password-123");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Confirm vault export" });
  await confirm.getByRole("textbox", { name: /Master password/ }).fill(alice.password);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    confirm.getByRole("button", { name: "Continue" }).click(),
  ]);
  const exportPath = testInfo.outputPath("export.json");
  await download.saveAs(exportPath);
  const exported = fs.readFileSync(exportPath, "utf8");
  const parsed = JSON.parse(exported);
  expect(parsed.encrypted).toBe(true);
  expect(parsed.passwordProtected).toBe(true);
  for (const secret of ["alice-git", "not-a-real-password-git", "JBSWY3DPEHPK3PXP", "4111111111111111", "Example Git host"]) {
    expect(exported).not.toContain(secret);
  }

  // A different account imports it with the file password.
  await page.context().clearCookies();
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
  await signUp(page, webUserFor("export-to", testInfo.repeatEachIndex));
  const result = await importBitwardenJson(page, exported, "file-password-123");
  await expect(result.getByText("A total of 4 items were imported.")).toBeVisible();
  await result.getByRole("button", { name: "Ok" }).click();
  await page.goto("/#/vault");
  await page.getByText("Example Git host").first().click();
  const view = page.getByRole("dialog", { name: "View Login" });
  await expect(view.getByRole("textbox", { name: "Username" })).toHaveValue("alice-git");
  await expect(view.getByRole("textbox", { name: "Recovery email" })).toHaveValue("alice.recovery@example.test");
});
