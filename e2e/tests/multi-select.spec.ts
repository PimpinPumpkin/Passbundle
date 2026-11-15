// Selecting several items at once in the web vault (DESIGN.md, "Selecting
// several items"). Every row of an item list has a checkbox, shown under the
// pointer and whenever anything is selected. A click toggles one, Shift+click
// takes the range, the header's checkbox and Cmd/Ctrl+A take everything shown,
// and Escape clears. The bar at the bottom says how many are selected and
// offers what the list's own item menu offers: Favorite, Add to folder, Add to
// shared folders, Delete, and in Trash Restore and Permanently delete.
//
// An action is offered when at least one selected item allows it and is done
// only to those: the confirmation says how many will be skipped and why, and
// a message afterwards says how many were. The server is asked only for the
// items the person may change, so nothing is refused halfway.
//
// What is selected is always in the list: a sync keeps the selected rows that
// are still there, and a row that left (deleted elsewhere, or hidden by a
// search) is let go of.
import { type APIRequestContext, expect, test, type Page } from "@playwright/test";

import {
  encrypt,
  realAccount,
  realCollection,
  realLogin,
  realMember,
  realOrganization,
  realPersonalLogin,
  type LoginValues,
  type RealAccount,
} from "./support/vault-crypto";
import { menu, pick, reloadVault } from "./support/web";

const auth = (account: RealAccount) => ({ Authorization: `Bearer ${account.token}` });

const login = (name: string): LoginValues => ({
  name,
  username: `${name.toLowerCase().replace(/\s+/g, "-")}@northwind.test`,
  password: `fixture-${name.toLowerCase().replace(/\s+/g, "-")}-2026`,
  uri: "https://northwind.test/login",
});

async function logIn(page: Page, account: RealAccount) {
  await page.goto("/#/login");
  await page.getByLabel(/Email address/).fill(account.email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("textbox", { name: /Master password/ }).fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(menu(page)).toBeVisible({ timeout: 30_000 });
}

/** A row's checkbox, by the item's name: what a screen reader calls it. */
const box = (page: Page, name: string) =>
  page.getByRole("checkbox", { name: `Select ${name}`, exact: true });

/** The bar at the bottom, there only while something is selected. */
const bar = (page: Page) => page.getByRole("toolbar", { name: "Bulk actions" });

/** Toasts have no role of their own: by their text. */
const toast = (page: Page, text: string) => page.getByText(text, { exact: true });

/** The names on the rows' checkboxes, top to bottom; only the selected rows' when asked. */
async function rowNames(page: Page, checked?: true) {
  const labels = await page
    .getByRole("checkbox", { name: /^Select (?!all$)/, checked })
    .evaluateAll((boxes) => boxes.map((b) => b.getAttribute("aria-label") ?? ""));
  return labels.map((label) => label.replace(/^Select /, ""));
}

/** How a list of names is compared: as shown, or as a set where the order is the list's own business. */
type Order = { anyOrder?: boolean };
const arranged = (names: string[], { anyOrder }: Order) => (anyOrder ? [...names].sort() : names);

/** The items the list shows, top to bottom. */
async function expectListed(page: Page, names: string[], order: Order = {}) {
  await expect
    .poll(async () => arranged(await rowNames(page), order))
    .toEqual(arranged(names, order));
}

/** The names of the selected rows, top to bottom. */
async function expectSelected(page: Page, names: string[], order: Order = {}) {
  await expect
    .poll(async () => arranged(await rowNames(page, true), order))
    .toEqual(arranged(names, order));
  if (names.length === 0) {
    await expect(bar(page)).toBeHidden();
  } else {
    await expect(bar(page)).toContainText(`${names.length} selected`);
  }
}

/** Picks one of the bar's actions, from the bar or from its menu when the bar is too narrow for it. */
async function act(page: Page, label: string) {
  // Clear comes first; the actions show once the bar knows which of them fit.
  await expect(bar(page).getByRole("button").nth(1)).toBeVisible();
  const button = bar(page).getByRole("button", { name: label, exact: true });
  if (await button.isVisible()) {
    await button.click();
    return;
  }
  await bar(page).getByRole("button", { name: "Additional actions" }).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
}

/** What the bar offers, wherever it put it. */
async function offered(page: Page) {
  await expect(bar(page).getByRole("button").nth(1)).toBeVisible();
  const labels = (await bar(page).getByRole("button").allInnerTexts()).map((label) => label.trim());
  const more = bar(page).getByRole("button", { name: "Additional actions" });
  if (await more.isVisible()) {
    await more.click();
    labels.push(...(await page.getByRole("menuitem").allInnerTexts()).map((label) => label.trim()));
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menuitem")).toHaveCount(0);
  }
  return labels.filter((label) => label !== "Clear" && label !== "Additional actions");
}

/** Opens one of an organization's shared folders in the admin console. */
async function openSharedFolder(page: Page, org: string, name: string) {
  await page.goto(`/#/organizations/${org}/vault`);
  // The admin console's own menu is there first: your vault, which may still
  // be on screen for a moment, has a button by the folder's name too.
  await expect(page.getByRole("link", { name: "Members", exact: true })).toBeVisible();
  await page.getByRole("button", { name, exact: true }).first().click();
  await expect(page).toHaveURL(/collectionId=[0-9a-f-]{36}/);
}

/** An item as the server has it. */
async function stored(request: APIRequestContext, account: RealAccount, id: string) {
  const got = await request.get(`/api/ciphers/${id}`, { headers: auth(account) });
  expect(got.status(), await got.text()).toBe(200);
  return got.json();
}

test("rows are selected with a click, a Shift+click, the header's checkbox and Cmd/Ctrl+A, and Escape clears", async ({
  page,
  request,
}) => {
  const account = await realAccount(request, "select-gestures");
  const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
  for (const name of names) {
    await realPersonalLogin(request, account, login(name));
  }
  await logIn(page, account);
  await expectListed(page, names);

  // With nothing selected a row's checkbox shows under the pointer only.
  await page.mouse.move(0, 0);
  await expect(box(page, "Echo")).toHaveCSS("opacity", "0");
  await page.getByRole("row").filter({ hasText: "Echo" }).hover();
  await expect(box(page, "Echo")).toHaveCSS("opacity", "1");
  await expect(box(page, "Alpha")).toHaveCSS("opacity", "0");

  // One click selects a row, and the bar says how many, to a screen reader too.
  await box(page, "Bravo").click();
  await expectSelected(page, ["Bravo"]);
  await expect(page.getByRole("status").filter({ hasText: "1 item(s) selected." })).toHaveCount(1);
  // Every checkbox shows while anything is selected.
  await expect(box(page, "Alpha")).toHaveCSS("opacity", "1");

  // Shift+click takes everything from the last row clicked to this one.
  await box(page, "Delta").click({ modifiers: ["Shift"] });
  await expectSelected(page, ["Bravo", "Charlie", "Delta"]);

  // A plain click on a selected row takes only that one out.
  await box(page, "Charlie").click();
  await expectSelected(page, ["Bravo", "Delta"]);

  // Upward works as well: from Charlie, the last one clicked, to Alpha.
  await box(page, "Alpha").click({ modifiers: ["Shift"] });
  await expectSelected(page, ["Alpha", "Bravo", "Charlie", "Delta"]);

  // Escape clears, with the keyboard still in the list.
  await page.keyboard.press("Escape");
  await expectSelected(page, []);
  await expect(page.getByRole("status").filter({ hasText: "Selection cleared" })).toHaveCount(1);

  // The header's checkbox selects everything shown, and the bar's Clear lets go of it.
  await page.getByRole("checkbox", { name: "Select all", exact: true }).check();
  await expectSelected(page, names);
  await bar(page).getByRole("button", { name: "Clear", exact: true }).click();
  await expectSelected(page, []);

  // Cmd/Ctrl+A selects everything while the list has the keyboard.
  await box(page, "Charlie").focus();
  await page.keyboard.press("ControlOrMeta+a");
  await expectSelected(page, names);

  // Escape in the bar clears too.
  await bar(page).getByRole("button", { name: "Clear", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expectSelected(page, []);

  // What is selected is always in the list: a search that hides a selected
  // row lets go of it, and it stays let go of when the search is cleared.
  await box(page, "Alpha").check();
  await box(page, "Echo").check();
  await expectSelected(page, ["Alpha", "Echo"]);
  const search = page.getByRole("searchbox").first();
  await search.fill("Alpha");
  await expectListed(page, ["Alpha"]);
  await expectSelected(page, ["Alpha"]);
  await search.fill("");
  await expectListed(page, names);
  await expectSelected(page, ["Alpha"]);
  await bar(page).getByRole("button", { name: "Clear", exact: true }).click();
  await expectSelected(page, []);

  // In a search box Cmd/Ctrl+A stays the browser's own: nothing is selected.
  await search.fill("a");
  await search.press("ControlOrMeta+a");
  await expect(bar(page)).toBeHidden();
});

test("a selection stays through a sync: rows still in the list stay selected, and one that left is let go of", async ({
  page,
  request,
}) => {
  const account = await realAccount(request, "select-sync");
  const ids: Record<string, string> = {};
  for (const name of ["Alpha", "Bravo", "Charlie"]) {
    ids[name] = await realPersonalLogin(request, account, login(name));
  }
  await logIn(page, account);
  await expectListed(page, ["Alpha", "Bravo", "Charlie"]);
  await box(page, "Alpha").check();
  await box(page, "Bravo").check();
  await expectSelected(page, ["Alpha", "Bravo"]);

  // Something is added from another device. The server tells this browser,
  // the list is read again, and the selection is as it was.
  await realPersonalLogin(request, account, login("Delta"));
  await expectListed(page, ["Alpha", "Bravo", "Charlie", "Delta"]);
  await expectSelected(page, ["Alpha", "Bravo"]);

  // A selected item is deleted from the other device: its row goes, and the
  // bar stops counting it, so nothing can be done to an item nobody sees.
  const deleted = await request.put(`/api/ciphers/${ids["Bravo"]}/delete`, {
    headers: auth(account),
  });
  expect(deleted.status(), await deleted.text()).toBe(200);
  await expectListed(page, ["Alpha", "Charlie", "Delta"]);
  await expectSelected(page, ["Alpha"]);

  // What is left selected is acted on as usual.
  await act(page, "Delete");
  const confirm = page.getByRole("dialog", { name: "Delete item" });
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(toast(page, "Item sent to trash")).toBeVisible();
  await expectListed(page, ["Charlie", "Delta"]);
  expect((await stored(request, account, ids["Alpha"])).deletedDate).not.toBeNull();
  expect((await stored(request, account, ids["Charlie"])).deletedDate).toBeNull();
});

test("several of your own items are favorited, added to a folder, deleted, restored and permanently deleted together", async ({
  page,
  request,
}) => {
  const account = await realAccount(request, "select-personal");
  const ids: Record<string, string> = {};
  for (const name of ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]) {
    ids[name] = await realPersonalLogin(request, account, login(name));
  }
  const folder = await request.post("/api/folders", {
    headers: auth(account),
    data: { name: encrypt(account.userKey, "Clients") },
  });
  expect(folder.status(), await folder.text()).toBe(200);
  const folderId: string = (await folder.json()).id;
  await logIn(page, account);
  await expectListed(page, ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]);

  // Favorite: one request per item, and one message for all of them.
  await box(page, "Alpha").check();
  await box(page, "Bravo").check();
  await act(page, "Favorite");
  await expect(toast(page, "2 items added to favorites")).toBeVisible();
  await expectSelected(page, []);
  expect((await stored(request, account, ids["Alpha"])).favorite).toBe(true);
  expect((await stored(request, account, ids["Bravo"])).favorite).toBe(true);
  expect((await stored(request, account, ids["Charlie"])).favorite).toBe(false);
  await pick(page, "Favorites");
  await expectListed(page, ["Alpha", "Bravo"]);

  // All of the selected ones are favorites here, so the bar offers to take them out.
  await page.getByRole("checkbox", { name: "Select all", exact: true }).check();
  await act(page, "Unfavorite");
  await expect(toast(page, "2 items removed from favorites")).toBeVisible();
  expect((await stored(request, account, ids["Alpha"])).favorite).toBe(false);
  await pick(page, "All items");
  await expectListed(page, ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]);

  // Add to folder.
  await box(page, "Charlie").check();
  await box(page, "Delta").check();
  await act(page, "Add to folder");
  const move = page.getByRole("dialog", { name: "Add to folder" });
  await expect(move).toContainText("2 selected item(s)");
  await move.getByRole("combobox").click();
  await page.getByRole("option", { name: "Clients" }).click();
  await move.getByRole("button", { name: "Save" }).click();
  await expect(toast(page, "Items moved")).toBeVisible();
  await expectSelected(page, []);
  expect((await stored(request, account, ids["Charlie"])).folderId).toBe(folderId);
  expect((await stored(request, account, ids["Delta"])).folderId).toBe(folderId);
  expect((await stored(request, account, ids["Echo"])).folderId).toBeNull();
  await pick(page, "Clients");
  await expectListed(page, ["Charlie", "Delta"]);
  await pick(page, "All items");

  // Delete: one confirmation that says how many, and they go to Trash.
  await box(page, "Alpha").click();
  await box(page, "Charlie").click({ modifiers: ["Shift"] });
  await expectSelected(page, ["Alpha", "Bravo", "Charlie"]);
  await act(page, "Delete");
  const confirmDelete = page.getByRole("dialog", { name: "Delete 3 items" });
  await expect(confirmDelete).toContainText("These items will be sent to your trash.");
  await confirmDelete.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(toast(page, "Items sent to trash")).toBeVisible();
  await expectListed(page, ["Delta", "Echo"]);
  await expectSelected(page, []);

  // In Trash the bar offers Restore and Permanently delete, and nothing else.
  await pick(page, "Trash");
  await expectListed(page, ["Alpha", "Bravo", "Charlie"]);
  await box(page, "Alpha").check();
  await box(page, "Bravo").check();
  expect(await offered(page)).toEqual(["Restore", "Permanently delete"]);
  await act(page, "Restore");
  await expect(toast(page, "Items restored")).toBeVisible();
  await expectListed(page, ["Charlie"]);

  // Selecting again right away holds: the sync that follows a bulk action
  // doesn't take the new selection with it.
  await box(page, "Charlie").check();
  await act(page, "Permanently delete");
  const confirmForever = page.getByRole("dialog", { name: "Delete item permanently" });
  await expect(confirmForever).toContainText("You will not be able to recover this item.");
  await confirmForever.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(toast(page, "Item permanently deleted")).toBeVisible();
  await expectListed(page, []);
  // The server no longer has it at all, in Trash or anywhere else.
  const left = await request.get("/api/ciphers", { headers: auth(account) });
  expect(left.status(), await left.text()).toBe(200);
  const leftIds = ((await left.json()).data as { id: string }[]).map((item) => item.id);
  expect(leftIds).not.toContain(ids["Charlie"]);
  expect(leftIds).toHaveLength(4);

  await pick(page, "All items");
  await expectListed(page, ["Alpha", "Bravo", "Delta", "Echo"]);
});

test("several of your own items move into an organization's shared folder together, and open there as before", async ({
  page,
  request,
}) => {
  const owner = await realAccount(request, "select-move");
  const org = await realOrganization(request, owner, "Northwind Dental");
  const finance = await realCollection(request, owner, org, "Finance");
  const payroll = await realPersonalLogin(request, owner, login("Payroll"));
  const bank = await realPersonalLogin(request, owner, login("Bank"));
  await realPersonalLogin(request, owner, login("Stays mine"));
  await logIn(page, owner);
  await expectListed(page, ["Bank", "Payroll", "Stays mine"]);

  await box(page, "Bank").check();
  await box(page, "Payroll").check();
  await act(page, "Add to shared folders");
  const assign = page.getByRole("dialog", { name: /Add to shared folders/ });
  await expect(assign).toContainText("2 items");
  // The same dialog as one item's Add to shared folders. With one organization
  // to move to it is already chosen, and the dialog says what moving means.
  await expect(assign).toContainText(
    "2 items will be permanently transferred to Northwind Dental. You will no longer own these items.",
  );
  await assign.getByRole("combobox").last().click();
  await page.getByRole("option", { name: "Finance" }).click();
  await assign.getByText(/Only organization members with access/).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await assign.getByRole("button", { name: /^(Assign|Transfer and add)$/ }).click();
  await expect(toast(page, "Items moved to shared folder")).toBeVisible({ timeout: 30_000 });
  await expect(assign).toBeHidden();
  await expectSelected(page, []);

  // The server has both in the organization's folder, and the third where it was.
  for (const id of [payroll, bank]) {
    const item = await stored(request, owner, id);
    expect(item.organizationId).toBe(org.id);
    expect(item.collectionIds).toEqual([finance]);
  }

  // They were encrypted again for the organization by the same code one
  // item's move uses: after a fresh read of the vault they open as before.
  await reloadVault(page);
  await pick(page, "Finance");
  await expectListed(page, ["Bank", "Payroll"]);
  await page
    .getByRole("row")
    .filter({ hasText: "Payroll" })
    .getByText("Payroll", { exact: true })
    .click();
  const view = page.getByRole("dialog", { name: /^View/ });
  await expect(view.getByRole("textbox", { name: "Username" })).toHaveValue(
    login("Payroll").username,
  );
});

test("selected items the organization doesn't let you delete are skipped: the confirmation says how many, and so does the result", async ({
  page,
  request,
}) => {
  const owner = await realAccount(request, "select-skip-owner");
  const member = await realAccount(request, "select-skip-member");
  const org = await realOrganization(request, owner, "Harbor Clinic");
  const open = await realCollection(request, owner, org, "Front desk");
  const locked = await realCollection(request, owner, org, "Door codes");
  await realMember(request, owner, org, member, [
    { id: open, readOnly: false, hidePasswords: false, manage: true },
    { id: locked, readOnly: true, hidePasswords: false, manage: false },
  ]);
  const printer = await realLogin(request, owner, org, open, login("Printer"));
  const router = await realLogin(request, owner, org, open, login("Router"));
  const safe = await realLogin(request, owner, org, locked, login("Safe code"));
  await logIn(page, member);
  await expectListed(page, ["Printer", "Router", "Safe code"]);

  // An item they can only view has a checkbox like the others, but nothing
  // the bar could do to it: it offers no Delete, and says why.
  await box(page, "Safe code").check();
  await expectSelected(page, ["Safe code"]);
  expect(await offered(page)).not.toContain("Delete");
  await page.keyboard.press("Escape");
  await expectSelected(page, []);

  // All three: Delete is offered for the two that allow it.
  await page.getByRole("checkbox", { name: "Select all", exact: true }).check();
  await expectSelected(page, ["Printer", "Router", "Safe code"]);
  const refused: string[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 400) {
      refused.push(`${response.status()} ${response.url()}`);
    }
  });
  await act(page, "Delete");
  const confirm = page.getByRole("dialog", { name: "Delete 2 items" });
  await expect(confirm).toContainText(
    "1 of the 3 items you selected will be skipped. Your organization doesn't let you delete it.",
  );
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(toast(page, "Items sent to trash")).toBeVisible();
  await expect(toast(page, "1 item was skipped.")).toBeVisible();
  await expectListed(page, ["Safe code"]);
  await expectSelected(page, []);

  // The server was asked only for the two: it refused nothing, and the third is as it was.
  expect(refused).toEqual([]);
  expect((await stored(request, owner, printer)).deletedDate).not.toBeNull();
  expect((await stored(request, owner, router)).deletedDate).not.toBeNull();
  expect((await stored(request, owner, safe)).deletedDate).toBeNull();
});

test("in the admin console several of an organization's items are added to another shared folder, deleted and restored together", async ({
  page,
  request,
}) => {
  const owner = await realAccount(request, "select-admin");
  const org = await realOrganization(request, owner, "Corner Bakery");
  const ovens = await realCollection(request, owner, org, "Ovens");
  const suppliers = await realCollection(request, owner, org, "Suppliers");
  const flour = await realLogin(request, owner, org, ovens, login("Flour order"));
  const gas = await realLogin(request, owner, org, ovens, login("Gas meter"));
  const till = await realLogin(request, owner, org, ovens, login("Till"));
  await logIn(page, owner);

  // The organization's shared folders are rows too, each with its own name on its checkbox.
  await page.goto(`/#/organizations/${org.id}/vault`);
  await expect(box(page, "Ovens")).toHaveCount(1);
  await expect(box(page, "Suppliers")).toHaveCount(1);

  // The same gestures as in your own vault, in whatever order this list shows its rows.
  const all = ["Flour order", "Gas meter", "Till"];
  await openSharedFolder(page, org.id, "Ovens");
  await expectListed(page, all, { anyOrder: true });
  const shown = await rowNames(page);
  await box(page, shown[0]).click();
  await box(page, shown[2]).click({ modifiers: ["Shift"] });
  await expectSelected(page, shown);
  await box(page, "Till").click();
  await expectSelected(page, ["Flour order", "Gas meter"], { anyOrder: true });

  // Add to shared folders: both go into Suppliers as well.
  await act(page, "Add to shared folders");
  const assign = page.getByRole("dialog", { name: /Add to shared folders/ });
  await expect(assign).toContainText("2 items");
  await assign.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "Suppliers" }).click();
  await assign.getByText(/Only organization members with access/).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await assign.getByRole("button", { name: "Assign" }).click();
  // Two folders now: the one the list is showing stays chosen in the dialog.
  await expect(toast(page, "Items moved to shared folders")).toBeVisible({ timeout: 30_000 });
  await expect(assign).toBeHidden();
  for (const id of [flour, gas]) {
    expect([...(await stored(request, owner, id)).collectionIds].sort()).toEqual(
      [ovens, suppliers].sort(),
    );
  }
  expect((await stored(request, owner, till)).collectionIds).toEqual([ovens]);

  // Delete, then Restore from the organization's Trash.
  await openSharedFolder(page, org.id, "Ovens");
  await expectListed(page, all, { anyOrder: true });
  await box(page, "Gas meter").check();
  await box(page, "Till").check();
  await act(page, "Delete");
  const confirm = page.getByRole("dialog", { name: "Delete 2 items" });
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(toast(page, "Items sent to trash")).toBeVisible();
  await expectListed(page, ["Flour order"]);

  await page.getByRole("button", { name: "Filter: Trash", exact: true }).click();
  await expectListed(page, ["Gas meter", "Till"], { anyOrder: true });
  await page.getByRole("checkbox", { name: "Select all", exact: true }).check();
  await expectSelected(page, ["Gas meter", "Till"], { anyOrder: true });
  expect(await offered(page)).toEqual(["Restore", "Permanently delete"]);
  await act(page, "Restore");
  await expect(toast(page, "Items restored")).toBeVisible();
  await expectListed(page, []);
  expect((await stored(request, owner, gas)).deletedDate).toBeNull();
  expect((await stored(request, owner, till)).deletedDate).toBeNull();
});
