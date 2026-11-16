// Selecting several items at once in the extension's popup (DESIGN.md,
// "Selecting several items"). Select, beside the folder filter, turns the
// list that's showing (all items, a kind, a folder, or the search's results)
// into checkboxes, with Select all and how many are selected above it, and
// Move to folder, Archive, and Move to trash below it. Cancel or Escape leaves
// Select mode, and so does finishing an action.
//
// An action is offered where the single item's menu allows it, and done only
// to the items that allow it: Move to trash leaves out an item the person may
// not delete, says how many before it starts and why, and again after, and
// the server is asked only about the others.
import type { APIRequestContext, Page } from "@playwright/test";

import { expect, logInPopup, openPopup, test } from "./support/extension";
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

const auth = (account: RealAccount) => ({ Authorization: `Bearer ${account.token}` });

const login = (name: string): LoginValues => ({
  name,
  username: `${name.toLowerCase().replace(/\s+/g, "-")}@harbor.test`,
  password: `fixture-${name.toLowerCase().replace(/\s+/g, "-")}-2026`,
  uri: "https://harbor.test/login",
});

/** A row's checkbox, by the item's name: what a screen reader calls it. */
const box = (popup: Page, name: string) =>
  popup.getByRole("checkbox", { name: `Select ${name}`, exact: true });

/** The names on the rows' checkboxes, top to bottom; only the checked ones' when asked. */
async function rowNames(popup: Page, checked?: true) {
  const labels = await popup
    .getByRole("checkbox", { name: /^Select (?!all$)/, checked })
    .evaluateAll((boxes) => boxes.map((b) => b.getAttribute("aria-label") ?? ""));
  return labels.map((label) => label.replace(/^Select /, "")).sort();
}

const selectButton = (popup: Page) => popup.getByRole("button", { name: "Select", exact: true });
const actions = (popup: Page) => popup.locator('[data-keykeeper="select-actions"]');
const count = (popup: Page) => popup.locator('[data-keykeeper="select-count"]');

/** An item as the server has it. */
async function stored(request: APIRequestContext, account: RealAccount, id: string) {
  const got = await request.get(`/api/ciphers/${id}`, { headers: auth(account) });
  expect(got.status(), await got.text()).toBe(200);
  return got.json();
}

test("several items are moved to a folder, archived, and moved to the trash together, skipping one the organization doesn't let you delete", async ({
  context,
  extensionId,
  request,
}) => {
  const owner = await realAccount(request, "popup-select-owner");
  const member = await realAccount(request, "popup-select-member");
  const org = await realOrganization(request, owner, "Harbor Clinic");
  const frontDesk = await realCollection(request, owner, org, "Front desk");
  const doorCodes = await realCollection(request, owner, org, "Door codes");
  await realMember(request, owner, org, member, [
    { id: frontDesk, readOnly: false, hidePasswords: false, manage: true },
    { id: doorCodes, readOnly: true, hidePasswords: false, manage: false },
  ]);
  const printer = await realLogin(request, owner, org, frontDesk, login("Printer"));
  const router = await realLogin(request, owner, org, frontDesk, login("Router"));
  const safe = await realLogin(request, owner, org, doorCodes, login("Safe code"));
  const email = await realPersonalLogin(request, member, login("Company email"));
  const bank = await realPersonalLogin(request, member, login("Bank"));
  const folder = async (name: string) => {
    const made = await request.post("/api/folders", {
      headers: auth(member),
      data: { name: encrypt(member.userKey, name) },
    });
    expect(made.status(), await made.text()).toBe(200);
    return (await made.json()).id as string;
  };
  const work = await folder("Work");
  // Company email starts in Home, so a move nobody asked for would show.
  const home = await folder("Home");
  const filed = await request.post("/api/ciphers/move", {
    headers: auth(member),
    data: { ids: [email], folderId: home },
  });
  expect(filed.status(), await filed.text()).toBe(200);

  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, { email: member.email, name: "member", password: member.password });
  await expect(popup.getByText("Safe code", { exact: true }).first()).toBeVisible();
  const refused: string[] = [];
  popup.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 400) {
      refused.push(`${response.status()} ${response.url()}`);
    }
  });

  // Select mode: a checkbox on every row, nothing selected, and the actions waiting for some.
  await selectButton(popup).click();
  await expect(count(popup)).toHaveText("0 selected");
  await expect.poll(() => rowNames(popup)).toEqual(
    ["Bank", "Company email", "Printer", "Router", "Safe code"].sort(),
  );
  await expect(actions(popup).getByRole("button", { name: "Move to folder" })).toBeDisabled();

  // Move to folder: Cancel moves nothing and keeps the selection.
  await box(popup, "Company email").check();
  await box(popup, "Bank").check();
  await expect(count(popup)).toHaveText("2 selected");
  await actions(popup).getByRole("button", { name: "Move to folder" }).click();
  const move = popup.getByRole("dialog", { name: "Move 2 items to a folder" });
  await move.getByRole("button", { name: "Cancel" }).click();
  await expect(move).toBeHidden();
  await expect(count(popup)).toHaveText("2 selected");
  expect((await stored(request, member, email)).folderId).toBe(home);

  // Then one request for both, and Select mode ends.
  await actions(popup).getByRole("button", { name: "Move to folder" }).click();
  await move.getByRole("combobox").click();
  await popup.getByRole("option", { name: "Work" }).click();
  await move.getByRole("button", { name: "Move", exact: true }).click();
  await expect(popup.getByText("2 items moved", { exact: true })).toBeVisible();
  await expect(selectButton(popup)).toBeVisible();
  await expect(popup.getByRole("checkbox", { name: /^Select / })).toHaveCount(0);
  expect((await stored(request, member, email)).folderId).toBe(work);
  expect((await stored(request, member, bank)).folderId).toBe(work);

  // Escape leaves Select mode and lets go of what was selected.
  await selectButton(popup).click();
  await box(popup, "Printer").check();
  await popup.keyboard.press("Escape");
  await expect(selectButton(popup)).toBeVisible();
  await selectButton(popup).click();
  await expect(count(popup)).toHaveText("0 selected");

  // Archive, worded for one item when one is selected.
  await box(popup, "Router").check();
  await actions(popup).getByRole("button", { name: "Archive" }).click();
  const archive = popup.getByRole("dialog", { name: "Archive item" });
  await archive.getByRole("button", { name: "Archive" }).click();
  await expect(popup.getByText("Item archived", { exact: true })).toBeVisible();
  expect((await stored(request, member, router)).archivedDate).not.toBeNull();

  // Select all, then Move to trash: the view-only item is skipped, and said so.
  await selectButton(popup).click();
  await popup.getByRole("checkbox", { name: "Select all", exact: true }).check();
  await expect(count(popup)).toHaveText("4 selected");
  await expect.poll(() => rowNames(popup, true)).toEqual(
    ["Bank", "Company email", "Printer", "Safe code"].sort(),
  );
  await actions(popup).getByRole("button", { name: "Move to trash" }).click();
  const trash = popup.getByRole("dialog", { name: "Move 3 items to the trash" });
  await expect(trash).toContainText(
    "1 of the 4 items you selected will be skipped. Your organization doesn't let you delete it. You can restore them from the trash.",
  );
  await trash.getByRole("button", { name: "Move to trash" }).click();
  await expect(popup.getByText("3 items sent to trash", { exact: true })).toBeVisible();
  await expect(popup.getByText("1 item was skipped.", { exact: true })).toBeVisible();
  await expect(selectButton(popup)).toBeVisible();

  // The server was asked only about the three: it refused nothing, and the fourth is as it was.
  expect(refused).toEqual([]);
  for (const id of [email, bank, printer]) {
    expect((await stored(request, member, id)).deletedDate).not.toBeNull();
  }
  expect((await stored(request, owner, safe)).deletedDate).toBeNull();
});

test("Select works on the search's results, and Select all takes only what they show", async ({
  context,
  extensionId,
  request,
}) => {
  const account = await realAccount(request, "popup-select-search");
  const ids: Record<string, string> = {};
  for (const name of ["Ferry pass", "Ferry locker", "Library"]) {
    ids[name] = await realPersonalLogin(request, account, login(name));
  }

  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, { email: account.email, name: "account", password: account.password });
  await popup.getByRole("searchbox").first().fill("Ferry");
  await expect(popup.getByText("Library", { exact: true })).toHaveCount(0);

  await selectButton(popup).click();
  await popup.getByRole("checkbox", { name: "Select all", exact: true }).check();
  await expect(count(popup)).toHaveText("2 selected");
  await expect.poll(() => rowNames(popup, true)).toEqual(["Ferry locker", "Ferry pass"]);

  // Narrowing the search lets go of a row it hides, so nothing is done to an item nobody can see.
  await popup.getByRole("searchbox").first().fill("Ferry locker");
  await expect(count(popup)).toHaveText("1 selected");
  await actions(popup).getByRole("button", { name: "Move to trash" }).click();
  const trash = popup.getByRole("dialog", { name: "Move 1 item to the trash" });
  await expect(trash).toContainText("You can restore it from the trash.");
  await trash.getByRole("button", { name: "Move to trash" }).click();
  await expect(popup.getByText("Item sent to trash", { exact: true })).toBeVisible();
  expect((await stored(request, account, ids["Ferry locker"])).deletedDate).not.toBeNull();
  expect((await stored(request, account, ids["Ferry pass"])).deletedDate).toBeNull();
  expect((await stored(request, account, ids["Library"])).deletedDate).toBeNull();
});
