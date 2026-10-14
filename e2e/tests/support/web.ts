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
