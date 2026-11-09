// A shared folder's icon and color (DESIGN.md, "Folder icons"). An owner
// makes a family's organization and two shared folders from the web vault's
// menu, giving one an icon and a color in its dialog (by mouse, then by
// keyboard) and leaving the other plain. The web vault's menu shows the
// first as a tile and the second with the plain glyph; the admin console's
// list does too, and changing the color there shows at once. Then the
// browser extension, signed in afresh, shows the tile in its folder filter
// and in the chip for the place picked, and the plain glyph for the other.
import type { Locator, Page } from "@playwright/test";

import {
  createAccount,
  expect,
  logInPopup,
  openPopup,
  serverUrl,
  test,
  userFor,
} from "./support/extension";
import { menu, menuEntry } from "./support/web";

/** The flat tiles in a place (our tile component, which the plain glyph isn't). */
const tiles = (scope: Locator) => scope.locator("vault-keykeeper-category-tile");

/** A tile's tone (its glyph's color, light) and its glyph's path. */
async function tileOf(scope: Locator) {
  const tile = tiles(scope).locator("[data-jewel]");
  await expect(tile).toBeVisible();
  return tile.evaluate((el: HTMLElement) => ({
    tone: el.style.getPropertyValue("--pb-jewel"),
    glyph: el.querySelector("path")?.getAttribute("d"),
  }));
}

const BANK = "M3 9l9-5 9 5 M5 10v7 M9.5 10v7 M14.5 10v7 M19 10v7 M3 20h18";
const GREEN = "#0E7A47";
const RED = "#A8291F";

/** A shared folder from the menu's New folder, in the organization. */
async function newSharedFolder(web: Page, org: string, name: string) {
  await menu(web).getByRole("button", { name: "New folder" }).click();
  await web.getByRole("menuitem", { name: org }).click();
  const dialog = web.getByRole("dialog", { name: /shared folder/i });
  await dialog.getByRole("textbox", { name: /^Name/ }).fill(name);
  return dialog;
}

test("an owner gives a shared folder an icon and a color in the web vault, and the extension shows them", async ({
  context,
  extensionId,
}, testInfo) => {
  test.setTimeout(360_000);
  const user = userFor("folder-icons", testInfo.repeatEachIndex);
  const web = await createAccount(context, user);

  // A family's organization, which needs no two-step login.
  await web.goto(`${serverUrl}/#/create-organization`);
  await web.getByRole("textbox", { name: /Organization name/ }).fill("Rivera Family");
  await web.getByRole("radio", { name: /A family or a group/ }).check();
  await web.getByRole("button", { name: "Create organization" }).click();
  await web.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  const org = web.url().replace(/\/members.*$/, "");
  await web.goto(`${serverUrl}/#/vault`);

  // Banking, with the bank icon, then green by keyboard.
  const banking = await newSharedFolder(web, "Rivera Family", "Banking");
  const look = banking.getByTestId("keykeeper-folder-look");
  const icons = look.getByRole("radiogroup", { name: "Icon" });
  const colors = look.getByRole("radiogroup", { name: "Color" });
  // Plain until someone picks.
  await expect(icons.getByRole("radio", { name: "Plain folder" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(tiles(look)).toHaveCount(0);
  await icons.getByRole("radio", { name: "Bank", exact: true }).click();
  // An icon first gets the first color; from there, arrow keys pick.
  const blue = colors.getByRole("radio", { name: "Blue", exact: true });
  await expect(blue).toHaveAttribute("aria-checked", "true");
  await blue.focus();
  for (let i = 0; i < 3; i++) {
    await web.keyboard.press("ArrowRight");
  }
  const green = colors.getByRole("radio", { name: "Green", exact: true });
  await expect(green).toHaveAttribute("aria-checked", "true");
  await expect(green).toBeFocused();
  await expect(blue).toHaveAttribute("tabindex", "-1");
  // The preview shows the folder as the menu will.
  await expect(look).toContainText("Banking");
  expect(await tileOf(look)).toEqual({ tone: GREEN, glyph: BANK });
  await banking.getByRole("button", { name: "Save" }).click();
  await expect(banking).toBeHidden();

  // Groceries, left plain.
  const groceries = await newSharedFolder(web, "Rivera Family", "Groceries");
  await groceries.getByRole("button", { name: "Save" }).click();
  await expect(groceries).toBeHidden();

  // The web vault's menu: Banking's tile, Groceries' plain glyph.
  await expect(menuEntry(web, "Banking")).toBeVisible();
  expect(await tileOf(menuEntry(web, "Banking"))).toEqual({ tone: GREEN, glyph: BANK });
  await expect(menuEntry(web, "Groceries")).toBeVisible();
  await expect(menuEntry(web, "Groceries").locator("vault-keykeeper-category-tile")).toHaveCount(0);
  await expect(menuEntry(web, "Groceries").locator("bit-icon")).toBeVisible();

  // The admin console's shared folders: the same, and a new color shows at once.
  await web.goto(`${org}/vault`);
  const bankingRow = web.getByRole("row").filter({ hasText: "Banking" });
  expect(await tileOf(bankingRow)).toEqual({ tone: GREEN, glyph: BANK });
  await expect(tiles(web.getByRole("row").filter({ hasText: "Groceries" }))).toHaveCount(0);
  await web.getByRole("button", { name: "Banking", exact: true }).first().click();
  await expect(web).toHaveURL(/collectionId=[0-9a-f-]{36}/);
  await web.getByRole("button", { name: "Edit shared folder" }).click();
  await web.getByRole("menuitem", { name: "Edit info" }).click();
  const edit = web.getByRole("dialog", { name: /Edit shared folder/ });
  const editLook = edit.getByTestId("keykeeper-folder-look");
  await expect(editLook.getByRole("radio", { name: "Bank", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(editLook.getByRole("radio", { name: "Green", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await editLook.getByRole("radio", { name: "Red", exact: true }).click();
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  await web.goto(`${org}/vault`);
  expect(await tileOf(web.getByRole("row").filter({ hasText: "Banking" }))).toEqual({
    tone: RED,
    glyph: BANK,
  });

  // A login in Banking, so the extension has something to filter.
  await web.getByRole("button", { name: "Banking", exact: true }).first().click();
  await expect(web).toHaveURL(/collectionId=[0-9a-f-]{36}/);
  await web.getByRole("button", { name: "Add", exact: true }).click();
  await web.getByRole("menuitem", { name: "Login" }).click();
  const login = web.getByRole("dialog", { name: "Add login" });
  await login.getByRole("textbox", { name: /Item name/ }).fill("Credit union");
  await login.getByRole("textbox", { name: "Username", exact: true }).fill("rivera");
  await login.getByRole("button", { name: "Save" }).click();
  await expect(login).toBeHidden();

  // The extension, signed in afresh: the folder filter and the chip.
  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, user);
  await popup.getByTestId("keykeeper-folder-filter").click();
  const place = (name: string) =>
    popup.getByTestId("keykeeper-place").filter({ hasText: name });
  await expect(place("Banking")).toBeVisible();
  expect(await tileOf(place("Banking"))).toEqual({ tone: RED, glyph: BANK });
  await expect(place("Groceries").locator("vault-keykeeper-category-tile")).toHaveCount(0);
  await expect(place("Groceries").locator(".bwi-collection-shared")).toBeVisible();
  await place("Banking").click();
  const chip = popup.getByTestId("keykeeper-picked-place");
  await expect(chip).toContainText("Rivera Family · Banking");
  expect(await tileOf(chip)).toEqual({ tone: RED, glyph: BANK });
  await expect(popup.getByText("Credit union", { exact: true })).toBeVisible();
});
