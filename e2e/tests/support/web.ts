// Helpers for tests that use the web vault directly, without the extension.
import { expect, type Page } from "@playwright/test";

export type WebUser = { email: string; name: string; password: string };

export const webUserFor = (prefix: string, repeatIndex: number): WebUser => ({
  email: `${prefix}-${repeatIndex}@example.test`,
  name: prefix,
  password: "correct horse battery staple 42",
});

/** Creates an account and lands in its vault. */
export async function signUp(page: Page, user: WebUser) {
  await page.goto("/#/signup");
  await page.getByLabel(/Email address/).fill(user.email);
  await page.getByLabel("Name").fill(user.name);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("textbox", { name: /^Master password/ }).first().fill(user.password);
  await page.getByRole("textbox", { name: /Confirm master password/ }).fill(user.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/#\/vault/);
  await expect(page).toHaveTitle(/Vaults/);
}

/**
 * An owner or admin approves someone waiting on the Members page they have
 * open, with upstream's Confirm and its fingerprint dialog.
 */
export async function confirmMember(page: Page, email: string) {
  const row = page.getByRole("row").filter({ hasText: email });
  await expect(row.getByText("Needs confirmation")).toBeVisible();
  await row.getByRole("button", { name: "Options" }).click();
  await page.getByRole("menuitem", { name: "Confirm" }).click();
  const dialog = page.getByRole("dialog", { name: /Confirm user/ });
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog).toBeHidden();
  await expect(row.getByText("Needs confirmation")).toHaveCount(0);
}

/** Opens the New item picker in the vault (DESIGN.md, "Our own screens"). */
export async function openNewItem(page: Page) {
  await page.getByRole("button", { name: "New", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "What are you saving?" });
  await expect(picker).toBeVisible();
  return picker;
}

/** Starts a new item: Login, Secure note, Card, or Identity, or a kind under More. */
export async function newItem(page: Page, kind: string) {
  const picker = await openNewItem(page);
  const tile = picker.getByTestId("new-item-main").getByRole("button", { name: new RegExp(`^${kind}`) });
  if ((await tile.count()) > 0) {
    await tile.click();
    return;
  }
  await picker.getByRole("button", { name: "More categories" }).click();
  await picker.getByRole("button", { name: kind, exact: true }).click();
}

/** The picker with More open: the other kinds, and templates by group. */
export async function templatePicker(page: Page) {
  const picker = await openNewItem(page);
  await picker.getByRole("button", { name: "More categories" }).click();
  return picker;
}

/** Starts a new custom template whose items are logins or notes. */
export async function newTemplate(page: Page, items: "logins" | "notes") {
  const picker = await templatePicker(page);
  await picker.getByRole("button", { name: items === "logins" ? "a template for logins" : "for notes" }).click();
}
