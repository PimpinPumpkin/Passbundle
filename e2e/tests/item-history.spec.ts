// Item history in the web vault (DESIGN.md, "Item history"): each save keeps
// the item as it was; the item's view lists its earlier versions and says who
// can see them; View puts one next to the item now with what changed marked;
// restoring one saves it as a normal edit, which keeps what the item had in
// its history too; and the history can be cleared.
import { expect, type Locator, type Page, test } from "@playwright/test";

import { newItem, signUp, webUserFor } from "./support/web";

/** Changes the password in the item's view, through Edit, and back to its view. */
async function changePassword(page: Page, view: Locator, password: string) {
  await view.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: /Edit Login/ });
  await edit.getByRole("textbox", { name: "Password", exact: true }).fill(password);
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  await expect(view).toBeVisible();
}

/** The item view's password, shown (its colored text reads each character twice: shown, and for screen readers). */
async function expectPassword(view: Locator, password: string) {
  const shown = view.getByTestId("login-password-color");
  if (!(await shown.isVisible())) {
    await view.getByTestId("toggle-password").click();
  }
  await expect(shown).toContainText(password);
}

test("a login's earlier passwords show in its history, and restoring one brings it back", async ({
  page,
}, testInfo) => {
  const user = webUserFor("history", testInfo.repeatEachIndex);
  await signUp(page, user);

  await newItem(page, "Login");
  const create = page.getByRole("dialog", { name: "New Login" });
  await create.getByRole("textbox", { name: /Item name/ }).fill("Example mail");
  await create.getByRole("textbox", { name: "Username", exact: true }).fill("ana@example.test");
  await create.getByRole("textbox", { name: "Password", exact: true }).fill("first-password-1");
  await create.getByRole("button", { name: "Save" }).click();
  await expect(create).toBeHidden();

  // Saving a new item opens its view. A new item has no earlier versions yet.
  const view = page.getByRole("dialog", { name: "View Login" });
  await expectPassword(view, "first-password-1");
  await expect(view.getByTestId("keykeeper-item-versions")).toHaveCount(0);

  await changePassword(page, view, "second-password-2");
  await changePassword(page, view, "third-password-3");

  const history = view.getByTestId("keykeeper-item-versions");
  await expect(history.getByRole("heading", { name: "Version history" })).toBeVisible();
  // It says who can see them.
  await expect(history.getByTestId("keykeeper-versions-who")).toHaveText(
    "Everyone who can open this item can see its earlier versions, including old passwords.",
  );
  const versions = history.getByTestId("keykeeper-item-version");
  await expect(versions).toHaveCount(2);
  await expect(versions.first()).toContainText("Saved by you");

  // The oldest version: the first password, next to the item now.
  await versions.last().getByRole("button", { name: /^View/ }).click();
  // A short date and time: "Oct 27, 2026, 1:15 AM", no seconds.
  const version = page.getByRole("dialog", {
    name: /^Version from [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M$/,
  });
  const password = version.getByRole("row", { name: /Password/ });
  await expect(password).toHaveAttribute("data-changed", "true");
  await expect(password.getByText("Changed")).toBeVisible();
  // Hidden until shown.
  await expect(password).not.toContainText("first-password-1");
  await version.getByRole("button", { name: "Show hidden values" }).click();
  await expect(password.getByRole("cell").nth(0)).toHaveText("first-password-1");
  await expect(password.getByRole("cell").nth(1)).toHaveText("third-password-3");
  const username = version.getByRole("row", { name: /Username/ });
  await expect(username).toHaveAttribute("data-changed", "false");

  await version.getByRole("button", { name: "Restore this version" }).click();
  const confirm = page.getByRole("dialog", { name: "Restore this version?" });
  await confirm.getByRole("button", { name: "Restore this version" }).click();
  await expect(version).toBeHidden();
  await expect(page.getByText("Version restored")).toBeVisible();

  // The item has its first password again, and the one it replaced is history.
  await expect(versions).toHaveCount(3);
  await expectPassword(view, "first-password-1");
  await versions.first().getByRole("button", { name: /^View/ }).click();
  const replaced = page.getByRole("dialog", { name: /^Version from/ });
  await replaced.getByRole("button", { name: "Show hidden values" }).click();
  await expect(replaced.getByRole("row", { name: /Password/ }).getByRole("cell").nth(0)).toHaveText(
    "third-password-3",
  );
  await replaced.getByRole("button", { name: "Close" }).last().click();
  await expect(replaced).toBeHidden();

  // It stays restored after the vault syncs again: reloading locks it, and
  // unlocking syncs.
  await view.getByRole("button", { name: "Close" }).first().click();
  await page.reload();
  await page.getByRole("textbox", { name: /^Master password/ }).fill(user.password);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.waitForURL(/#\/vault/);
  await page.getByText("Example mail").first().click();
  await expectPassword(view, "first-password-1");
  await expect(versions).toHaveCount(3);

  // Whoever can delete the item can clear its history, once they confirm.
  await history.getByRole("button", { name: "Clear history" }).click();
  const clear = page.getByRole("dialog", { name: "Clear this item's history?" });
  await clear.getByRole("button", { name: "Clear history" }).click();
  await expect(page.getByText("History cleared")).toBeVisible();
  await expect(history).toHaveCount(0);
  await expectPassword(view, "first-password-1");
});
