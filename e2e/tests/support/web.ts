// Helpers for tests that use the web vault directly, without the extension.
import { type APIRequestContext, expect, type Page } from "@playwright/test";

import { giveAuthenticator } from "./two-step";

export type WebUser = { email: string; name: string; password: string };

export const webUserFor = (prefix: string, repeatIndex: number): WebUser => ({
  email: `${prefix}-${repeatIndex}@example.test`,
  name: prefix,
  password: "correct horse battery staple 42",
});

/** Creates an account and lands in its vault, skipping the offer to import. */
export async function signUp(page: Page, user: WebUser) {
  await startSignUp(page, user);
  await skipImport(page);
  await expect(page).toHaveTitle(/^Items/);
}

/**
 * Creates an account with an authenticator app, as someone who will own or run
 * a Business organization, or be on an MSP's staff, needs: without one, their
 * session ends at its next refresh (DESIGN.md, "Two-step login for admins").
 */
export async function signUpWithAuthenticator(
  page: Page,
  user: WebUser,
  request: APIRequestContext = page.context().request,
) {
  await signUp(page, user);
  await giveAuthenticator(request, user);
}

/** Creates an account, up to the offer to import that comes first. */
export async function startSignUp(page: Page, user: WebUser) {
  await page.goto("/#/signup");
  await page.getByLabel(/Email address/).fill(user.email);
  await page.getByLabel("Name").fill(user.name);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("textbox", { name: /^Master password/ }).first().fill(user.password);
  await page.getByRole("textbox", { name: /Confirm master password/ }).fill(user.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/#\/setup-import/);
}

/** Right after signing up, the web vault offers to import first: skip it. */
export async function skipImport(page: Page) {
  await page.waitForURL(/#\/setup-import/);
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page.waitForURL(/#\/vault/);
}

/**
 * An owner or admin approves someone waiting on the Members page they have
 * open, with upstream's Confirm and its fingerprint dialog.
 *
 * The list can reload just after the page opens (its background work, or a
 * sync after the organization changed). A reload used to hand the row whose
 * menu was open to another member, so the menu showed their actions; rows
 * keep their member now (members-menu.spec.ts). Opening the menu again until
 * Confirm opens its dialog stays, as a harmless guard.
 */
export async function confirmMember(page: Page, email: string) {
  const row = page.getByRole("row").filter({ hasText: email });
  await expect(row.getByText("Needs confirmation")).toBeVisible();
  const dialog = page.getByRole("dialog", { name: /Confirm user/ });
  await expect(async () => {
    await page.keyboard.press("Escape");
    await row.getByRole("button", { name: "Options" }).click();
    await page.getByRole("menuitem", { name: "Confirm" }).click({ timeout: 2_000 });
    await expect(dialog).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog).toBeHidden();
  await expect(row.getByText("Needs confirmation")).toHaveCount(0);
}

/**
 * Reloads the web vault, which syncs it again. Within the vault timeout a
 * reload stays unlocked (DESIGN.md, "Staying unlocked across a reload"), so
 * it waits until the page is back, unlocked, with its left menu.
 */
export async function reloadVault(page: Page) {
  await page.reload();
  await expect(menu(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("textbox", { name: /^Master password/ })).toHaveCount(0);
}

/**
 * The web vault's one left menu: search, the categories, and the folders
 * (Personal's, then each organization's), then the tools (DESIGN.md, "The
 * left menu").
 */
export function menu(page: Page) {
  return page.getByRole("navigation", { name: "Side navigation" });
}

/** One entry of the left menu, with its count. */
export function menuEntry(page: Page, name: string) {
  return menu(page)
    .locator("bit-nav-item")
    .filter({ has: page.getByRole("button", { name, exact: true }) });
}

/** Picks an entry of the left menu, which filters the vault. */
export async function pick(page: Page, name: string) {
  await menu(page).getByRole("button", { name, exact: true }).click();
}

/** Opens the New item picker in the vault (DESIGN.md, "Our own screens"). */
export async function openNewItem(page: Page) {
  await page.getByRole("button", { name: "New", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "What are you saving?" });
  await expect(picker).toBeVisible();
  return picker;
}

/**
 * Starts a new item: Login, Secure note, Card, or Identity, or a kind under
 * More. In an organization's vault in the admin console, New is still
 * upstream's menu.
 */
export async function newItem(page: Page, kind: string) {
  await page.getByRole("button", { name: "New", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "What are you saving?" });
  const menuItem = page.getByRole("menuitem", { name: kind });
  await expect(picker.or(menuItem)).toBeVisible();
  if (await menuItem.isVisible()) {
    await menuItem.click();
    return;
  }
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
