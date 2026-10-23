// The web vault's one left menu, like 1Password's: search, All items,
// Favorites, Health, the categories with items, the vaults with their
// collections, the folders, Archive, and Trash, then the tools. Picking an
// entry filters the vault the way the old filter panel did. See DESIGN.md,
// "The left menu".
import { expect, test, type Page } from "@playwright/test";

import { menu, menuEntry, newItem, pick, signUp, webUserFor } from "./support/web";

/** Saves a new item of a kind with a name; saving opens its view, which this closes. */
async function save(page: Page, kind: string, name: string) {
  await newItem(page, kind);
  const dialog = page.getByRole("dialog", { name: `New ${kind}` });
  await dialog.getByRole("textbox", { name: /Item name/ }).fill(name);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  const view = page.getByRole("dialog", { name: /^View/ });
  await view.getByRole("button", { name: "Close" }).first().click();
  await expect(view).toBeHidden();
}

const row = (page: Page, name: string) => page.getByRole("row").filter({ hasText: name });

test("the menu filters the vault: categories with counts, folders, and search", async ({
  page,
}, testInfo) => {
  await signUp(page, webUserFor("vault-menu", testInfo.repeatEachIndex));
  const nav = menu(page);

  // No items, no categories. The filter panel is gone; the menu has the search.
  await expect(nav.getByRole("button", { name: "All items", exact: true })).toBeVisible();
  await expect(nav.getByRole("group", { name: "Categories" })).toHaveCount(0);
  await expect(page.getByText("Filters", { exact: true })).toHaveCount(0);

  await save(page, "Login", "Northwind Bank");
  await save(page, "Card", "Visa ending 4242");
  await expect(menuEntry(page, "All items")).toContainText("2");
  await expect(menuEntry(page, "Login")).toContainText("1");
  await expect(menuEntry(page, "Card")).toContainText("1");
  // Only categories with items.
  await expect(nav.getByRole("button", { name: "Identity", exact: true })).toHaveCount(0);

  // A category: only its items, in the address the way the panel put it.
  await pick(page, "Card");
  await expect(page).toHaveURL(/type=card/);
  await expect(row(page, "Visa ending 4242")).toBeVisible();
  await expect(row(page, "Northwind Bank")).toHaveCount(0);

  // A folder, made from the button beside Folders: empty so far.
  await nav.getByRole("button", { name: "New folder" }).click();
  const folder = page.getByRole("dialog", { name: /New folder|Add folder/ });
  await folder.getByRole("textbox", { name: /Folder name/ }).fill("Bills");
  await folder.getByRole("button", { name: "Save" }).click();
  await expect(folder).toBeHidden();
  await expect(menuEntry(page, "Bills")).toContainText("0");
  await pick(page, "Bills");
  await expect(page).toHaveURL(/folderId=/);
  await expect(row(page, "Visa ending 4242")).toHaveCount(0);

  // All items shows everything again, and the menu's search narrows it.
  await pick(page, "All items");
  await expect(row(page, "Northwind Bank")).toBeVisible();
  await expect(row(page, "Visa ending 4242")).toBeVisible();
  await nav.getByPlaceholder("Search all items").fill("visa");
  await expect(page).toHaveURL(/search=visa/);
  await expect(row(page, "Northwind Bank")).toHaveCount(0);
  await expect(row(page, "Visa ending 4242")).toBeVisible();
});

test("the tools come after the vault in the same menu, and every page has it", async ({
  page,
}, testInfo) => {
  await signUp(page, webUserFor("vault-menu-tools", testInfo.repeatEachIndex));
  const nav = menu(page);

  const order = ["Health", "Generator", "Send", "Import and export", "Settings"];
  const links = await nav.getByRole("link").allInnerTexts();
  expect(links.map((l) => l.trim()).filter((l) => order.includes(l))).toEqual(order);
  await expect(nav.getByRole("link", { name: "Health" })).toHaveAttribute("href", "#/reports");

  // From another page, an entry opens the vault with it.
  await nav.getByRole("link", { name: "Send", exact: true }).click();
  await expect(page).toHaveURL(/#\/sends/);
  await pick(page, "Trash");
  await expect(page).toHaveURL(/#\/vault\?.*type=trash/);
});

test("on a phone, a Menu button opens the menu, and a pick closes it", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signUp(page, webUserFor("vault-menu-phone", testInfo.repeatEachIndex));

  const menuButton = page.getByRole("button", { name: "Menu", exact: true });
  await expect(menuButton).toHaveAttribute("aria-expanded", "false");
  await menuButton.click();
  await expect(menuButton).toHaveAttribute("aria-expanded", "true");
  await pick(page, "Trash");
  await expect(page).toHaveURL(/type=trash/);
  await expect(menuButton).toHaveAttribute("aria-expanded", "false");

  // The checklist's title gets the card's width, not a narrow column beside
  // its icon and progress (which move out of its way on a phone).
  await page.goto("/#/vault");
  const title = page.getByText("Get started with your vault", { exact: true });
  await expect(title).toBeVisible();
  expect((await title.boundingBox())!.width).toBeGreaterThan(150);

  // Wider, the side nav has room, and the button goes.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(menuButton).toBeHidden();
});
