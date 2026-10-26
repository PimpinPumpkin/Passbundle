// The extension's popup has PassBundle's own look (DESIGN.md, "The look"): a
// calm ground in every theme (graphite glass in dark mode) and never Glass, a
// sign-in that asks where the vault is, category chips over the vault, and a
// tile for every item: the site's icon, the login's first letter, or the
// category's jewel tile.
import type { Page } from "@playwright/test";

import { brand, port } from "../paths.mjs";

import { addLogin } from "./support/autofill";
import { createAccount, expect, openPopup, serverUrl, test, userFor } from "./support/extension";
import { newItem } from "./support/web";

/** Saving an item opens its view: close it. */
async function closeView(web: Page) {
  const view = web.getByRole("dialog", { name: /^View/ });
  await view.getByRole("button", { name: "Close" }).first().click();
  await expect(view).toBeHidden();
}

/** Saves a new item of a kind with a name. */
async function saveItem(web: Page, kind: string, name: string) {
  await newItem(web, kind);
  const dialog = web.getByRole("dialog", { name: `New ${kind}` });
  await dialog.getByRole("textbox", { name: /Item name/ }).fill(name);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await closeView(web);
}

/** The look's classes on the popup's page: never pb-glass. */
const lookClasses = (popup: Page) =>
  popup.evaluate(() =>
    [...document.documentElement.classList]
      .filter((c) => c.startsWith("pb-") || c.startsWith("theme_"))
      .sort(),
  );

test("the popup's own look: where the vault is, a calm ground, category chips, and item tiles", async ({
  context,
  extensionId,
}, testInfo) => {
  // An account with two items, a sign-in, and a tour of the popup.
  test.setTimeout(120_000);
  const user = userFor("ext-look", testInfo.repeatEachIndex);
  const web = await createAccount(context, user);
  await web.goto(`${serverUrl}/#/vault`);
  await addLogin(web, {
    name: "Contoso Mail",
    username: "alex@contoso.example",
    password: "not-a-real-password-1",
    uri: "https://contoso.example.test",
  });
  await closeView(web);
  await saveItem(web, "Card", "Visa ending 4242");
  await web.close();

  const popup = await openPopup(context, extensionId);
  await expect(async () => {
    await popup.getByRole("button", { name: "Log in", exact: true }).click();
    await expect(popup).toHaveURL(/#\/login/, { timeout: 1000 });
  }).toPass();

  // Sign-in asks where the vault is: the service, or one's own server, whose
  // address goes right under it, without https:// if you like.
  await expect(popup.getByRole("heading", { name: "Sign in" })).toBeVisible();
  const where = popup.getByRole("group", { name: "Where's your vault?" });
  await expect(where.getByRole("button")).toHaveText([brand.name, "My own server"]);
  await expect(where.getByRole("button", { name: brand.name })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(popup.getByRole("textbox", { name: "Server address" })).toHaveCount(0);
  await where.getByRole("button", { name: "My own server" }).click();
  await expect(where.getByRole("button", { name: "My own server" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(popup.getByText("Just the address. We add https:// for you.")).toBeVisible();
  await popup.getByRole("textbox", { name: "Server address" }).fill(`127.0.0.1:${port}`);
  await expect(popup.getByTestId("keykeeper-new-here")).toContainText("New here?");
  await popup.getByLabel(/Email address/).fill(user.email);
  await popup.getByRole("button", { name: "Continue" }).click();
  await popup.getByRole("textbox", { name: /Master password/ }).fill(user.password);
  await popup.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(popup.getByRole("heading", { name: /Items/ }).first()).toBeVisible({
    timeout: 30_000,
  });

  // A solid ground, never Glass, light or dark like the device.
  expect(await lookClasses(popup)).toEqual(["pb-popup", "theme_light"]);
  await expect(popup.locator("body")).toHaveCSS("background-color", "rgb(238, 242, 240)");

  // The chips: All, then the kinds of item the vault has.
  const chips = popup.getByRole("group", { name: "Categories" }).getByRole("button");
  await expect(chips).toHaveText(["All", "Logins", "Cards"]);
  await expect(chips.first()).toHaveAttribute("aria-pressed", "true");
  // The rows in All items (cards also show among the page's suggestions).
  const row = (name: string) => popup.locator("#allItems bit-item").filter({ hasText: name });
  await chips.filter({ hasText: "Cards" }).click();
  await expect(row("Visa ending 4242")).toBeVisible();
  await expect(row("Contoso Mail")).toHaveCount(0);
  await chips.filter({ hasText: "All" }).click();

  // Tiles: the login's letter (its site has no icon), the card's jewel tile.
  const loginTile = row("Contoso Mail").locator("vault-keykeeper-item-tile [data-tile]").first();
  await expect(loginTile).toHaveAttribute("data-tile", "letter");
  await expect(loginTile).toHaveText("C");
  await expect(
    row("Visa ending 4242").locator('vault-keykeeper-item-tile [data-category="card"]'),
  ).toBeVisible();

  // An item's page: its name, what it is and where it lives, its password's
  // health, and the star.
  await row("Contoso Mail").getByText("Contoso Mail", { exact: true }).click();
  await expect(popup.getByRole("heading", { level: 1, name: "Contoso Mail" })).toBeVisible();
  await expect(popup.getByTestId("keykeeper-item-where")).toHaveText("Login in Personal");
  await expect(popup.getByTestId("keykeeper-password-health")).toHaveText(
    /Password (strong|good|weak) · added /,
  );
  const star = popup.getByRole("button", { name: "Favorite" });
  await expect(star).toHaveAttribute("aria-pressed", "false");
  await star.click();
  await expect(star).toHaveAttribute("aria-pressed", "true");
  await popup.getByRole("button", { name: "Back" }).click();
  await expect(
    popup.locator("#favorites").locator("bit-item").filter({ hasText: "Contoso Mail" }),
  ).toBeVisible();

  // Dark like the device, and still no Glass: graphite, not green, with its
  // faint washes, and a card of rows that's translucent white over them.
  await popup.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => lookClasses(popup)).toEqual(["pb-popup", "theme_dark"]);
  await expect(popup.locator("body")).toHaveCSS("background-color", "rgb(17, 19, 24)");
  await expect(popup.locator("body")).toHaveCSS("background-image", /radial-gradient/);
  await expect(popup.locator("#allItems bit-item-group").first()).toHaveCSS(
    "background-color",
    "rgba(255, 255, 255, 0.055)",
  );
});

test("sign-in goes only to the server shown: not with a blank or refused address, and the password step names it", async ({
  context,
  extensionId,
}) => {
  const popup = await openPopup(context, extensionId);
  await expect(async () => {
    await popup.getByRole("button", { name: "Log in", exact: true }).click();
    await expect(popup).toHaveURL(/#\/login/, { timeout: 1000 });
  }).toPass();

  const continueButton = popup.getByRole("button", { name: "Continue" });
  const passkey = popup.getByRole("button", { name: "Sign in with a passkey" });
  const passwordField = popup.getByRole("textbox", { name: /Master password/ });
  const email = popup.getByLabel(/Email address/);
  await email.fill("someone@example.test");
  await expect(continueButton).toBeEnabled();

  // My own server, and nothing typed: nothing to sign in to yet.
  await popup
    .getByRole("group", { name: "Where's your vault?" })
    .getByRole("button", { name: "My own server" })
    .click();
  await expect(continueButton).toBeDisabled();
  await expect(passkey).toBeDisabled();
  await expect(popup.getByRole("button", { name: "Use single sign-on" })).toBeDisabled();
  await email.press("Enter");
  await expect(passwordField).toBeHidden();

  // A refused address says why, and still can't go on.
  const address = popup.getByRole("textbox", { name: "Server address" });
  for (const [typed, why] of [
    [`http://127.0.0.1:${port}`, "URLs must use HTTPS."],
    [`passbundle.com@127.0.0.1:${port}`, "Use just the server's address, without @, ? or #."],
  ]) {
    await address.fill(typed);
    await address.press("Tab");
    await expect(popup.getByRole("alert")).toHaveText(why);
    await expect(continueButton).toBeDisabled();
    await email.press("Enter");
    await expect(passwordField).toBeHidden();
  }

  // A good one is saved on Continue, and the password step names the server.
  await address.fill(`127.0.0.1:${port}`);
  await expect(continueButton).toBeEnabled();
  await continueButton.click();
  await expect(passwordField).toBeVisible();
  await expect(popup.getByText(`someone@example.test · 127.0.0.1:${port}`)).toBeVisible();
});
