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

// Upstream interrupts every fresh login with an extension page, an "Are you
// sure?" dialog, and a welcome tour. Our server turns them off by default.
async function expectNoNags(page: Page) {
  await page.waitForURL(/#\/(vault|setup-extension)/);
  expect(page.url()).not.toContain("setup-extension");
  await expect(page).toHaveTitle(/Vaults/);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

async function logIn(page: Page) {
  await page.goto("/#/login");
  await page.getByLabel(/Email address/).fill(user.email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("textbox", { name: /Master password/ }).fill(user.password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expectNoNags(page);
  await expect(page).toHaveTitle(/Vaults/);
}

test("server identifies as PassBundle, links its source, and suppresses nags", async ({ request }) => {
  const config = await (await request.get("/api/config")).json();
  expect(config.server.name).toBe(brand.name);
  // AGPL-3.0 section 13: network users get a link to the server's source.
  expect(config.server.url).toBe("https://github.com/PimpinPumpkin/passbundle-server");
  expect(config.settings.suppressOnboardingInterstitials).toBe(true);
});

test("landing page carries our brand and no Bitwarden branding", async ({ page }) => {
  await page.goto("/#/login");
  await expect(page.getByLabel(/Email address/)).toBeVisible();
  await expect(page).toHaveTitle(new RegExp(brand.name));
  // The wordmark uses its own color variable in light mode; it must be ours.
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(brand.color.slice(i, i + 2), 16));
  const logoColor = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--color-marketing-logo").trim(),
  );
  expect(logoColor).toBe(`${r} ${g} ${b}`);
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
  // First, an offer to bring passwords over, from where they are now.
  await page.waitForURL(/#\/setup-import/);
  await expect(page.getByRole("heading", { name: "Bring your passwords over" })).toBeVisible();
  for (const source of ["Your browser", "Apple Passwords", "1Password", "Bitwarden", "LastPass", "Something else"]) {
    await expect(page.getByRole("button", { name: new RegExp(`^${source}`) })).toBeVisible();
  }
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expectNoNags(page);
  await expect(page).toHaveTitle(/Vaults/);
  // Skipped means skipped: the vault doesn't send it back.
  await page.goto("/#/sends");
  await page.goto("/#/vault");
  await expect(page).toHaveURL(/#\/vault/);
  await expect(page).toHaveTitle(/Vaults/);
});

test("vault page carries our brand, including logos", async ({ page }) => {
  await logIn(page);
  // Logos are SVG shapes, invisible to a text check. Ours carry data-brand.
  await expect(page.locator(`nav svg[data-brand="${brand.name}"]`).first()).toBeVisible();
  // Our color replaces upstream's blue: the theme scale and a primary button.
  const brand700 = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--color-brand-700").trim(),
  );
  expect(brand700.toLowerCase()).toBe(brand.color.toLowerCase());
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(brand.color.slice(i, i + 2), 16));
  await expect(page.getByRole("button", { name: "New", exact: true })).toHaveCSS(
    "background-color",
    `rgb(${r}, ${g}, ${b})`,
  );
  // The icon font's shield glyphs draw our mark, not Bitwarden's shield.
  for (const glyph of await page.locator(".bwi-bitwarden-shield, .bwi-shield").all()) {
    const mask = await glyph.evaluate((el) => {
      const style = getComputedStyle(el, "::before");
      return style.maskImage || style.getPropertyValue("-webkit-mask-image");
    });
    expect(mask).toContain("data:image/svg+xml");
  }
  // Secrets Manager is a Bitwarden-only product; we never advertise it.
  await expect(page.getByText("Secrets Manager")).toHaveCount(0);
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
