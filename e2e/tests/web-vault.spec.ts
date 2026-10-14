import { expect, test, type Page } from "@playwright/test";

import { brand } from "../paths.mjs";

// One account for the whole file. Tests run in order and build on each other,
// against a server that starts empty for every run.
const user = {
  email: "alice@example.test",
  name: "Alice",
  password: "correct horse battery staple 42",
};

test.describe.configure({ mode: "serial" });

// Upstream nags after signup and after every login in a fresh browser: an
// extension page, an "Are you sure?" dialog, then a welcome tour. We will
// remove all three; until then, step past them.
async function skipNags(page: Page) {
  await page.waitForURL(/#\/(vault|setup-extension)/);
  if (page.url().includes("setup-extension")) {
    await page.getByRole("button", { name: "Add it later" }).click();
    await page.getByRole("link", { name: "Skip to web app" }).click();
  }
  await expect(page).toHaveTitle(/Vaults/);
  await page.waitForLoadState("networkidle");
  const tour = page.getByRole("dialog").getByRole("button", { name: "Skip" });
  if (await tour.count()) await tour.click();
}

async function logIn(page: Page) {
  await page.goto("/#/login");
  await page.getByLabel(/Email address/).fill(user.email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("textbox", { name: /Master password/ }).fill(user.password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await skipNags(page);
  await expect(page).toHaveTitle(/Vaults/);
}

test("landing page carries our brand and no Bitwarden branding", async ({ page }) => {
  await page.goto("/#/login");
  await expect(page.getByLabel(/Email address/)).toBeVisible();
  await expect(page).toHaveTitle(new RegExp(brand.name));
  // GPLv3 requires keeping Bitwarden's copyright notice, so that line is allowed.
  const text = (await page.locator("body").innerText()).replaceAll(
    `Bitwarden Inc. and ${brand.name} contributors`,
    "",
  );
  expect(text).not.toContain("Bitwarden");
});

test("create an account", async ({ page }) => {
  await page.goto("/#/login");
  await page.getByRole("link", { name: "Create account" }).click();
  await page.getByLabel(/Email address/).fill(user.email);
  await page.getByLabel("Name").fill(user.name);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("textbox", { name: /^Master password/, exact: false }).first().fill(user.password);
  await page.getByRole("textbox", { name: /Confirm master password/ }).fill(user.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await skipNags(page);
  await expect(page).toHaveTitle(/Vaults/);
});

test("vault page carries our brand, including logos", async ({ page }) => {
  await logIn(page);
  // Logos are SVG shapes, invisible to a text check. Ours carry data-brand.
  await expect(page.locator(`nav svg[data-brand="${brand.name}"]`).first()).toBeVisible();
  const html = (await page.content()).replaceAll(`Bitwarden Inc. and ${brand.name} contributors`, "");
  const leftovers = html.match(/.{0,60}\bBitwarden\b.{0,60}/g) ?? [];
  expect(leftovers).toEqual([]);
});

test("a saved login survives logging out and back in", async ({ page }) => {
  await logIn(page);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Login" }).click();
  const dialog = page.getByRole("dialog", { name: "New Login" });
  await dialog.getByRole("textbox", { name: /Item name/ }).fill("Example Bank");
  await dialog.getByRole("textbox", { name: "Username", exact: true }).fill("alice-bank");
  await dialog.getByRole("textbox", { name: "Password", exact: true }).fill("not-a-real-password-1");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Example Bank").first()).toBeVisible();

  await page.context().clearCookies();
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
  await logIn(page);
  await expect(page.getByText("Example Bank").first()).toBeVisible();
});
