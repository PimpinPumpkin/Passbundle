// Item history in the browser extension (DESIGN.md, "Item history"), as the
// web vault and the apps have it: an item's page links to its earlier
// versions; one opens beside the item as it is now, its hidden values masked
// until shown; restoring one saves it as a normal edit, so the item's
// history then holds what it replaced; and the person's own item's history
// can be cleared.
import type { Page } from "@playwright/test";

import { addLogin } from "./support/autofill";
import {
  createAccount,
  expect,
  logInPopup,
  openPopup,
  serverUrl,
  test,
  userFor,
} from "./support/extension";

/** A toast message. Toasts here have no ARIA role, so find them by text. */
const toast = (page: Page, text: string) => page.getByText(text, { exact: true });

/** The history page: the popup can hold the page it left for a moment. */
const historyPage = (popup: Page) => popup.locator("app-keykeeper-item-history-page");

/** The popup's All items row for an item. */
const row = (popup: Page, name: string) =>
  popup.locator("#allItems bit-item").filter({ hasText: name });

/** Opens an item's page from the list. */
async function openItem(popup: Page, name: string) {
  await row(popup, name).getByText(name, { exact: true }).click();
  await expect(popup.getByRole("heading", { level: 1, name })).toBeVisible();
}

/** Changes the login's password from its page, through Edit, and back to its page. */
async function changePassword(popup: Page, password: string) {
  await popup.getByTestId("keykeeper-edit").click();
  const field = popup.getByRole("textbox", { name: "Password", exact: true });
  await field.fill(password);
  await popup.getByRole("button", { name: "Save" }).click();
  await expect(toast(popup, "Item saved")).toBeVisible();
  await expect(popup.getByTestId("keykeeper-edit")).toBeVisible();
}

/** The item page's password, shown. */
async function expectPassword(popup: Page, password: string) {
  const shown = popup.getByTestId("login-password-color");
  if (!(await shown.isVisible())) {
    await popup.getByTestId("toggle-password").click();
  }
  await expect(shown).toContainText(password);
}

test("an item's earlier versions show in the popup, and restoring one brings it back", async ({
  context,
  extensionId,
}, testInfo) => {
  test.setTimeout(180_000);
  const user = userFor("ext-history", testInfo.repeatEachIndex);
  const web = await createAccount(context, user);
  await web.goto(`${serverUrl}/#/vault`);
  await addLogin(web, {
    name: "Example mail",
    username: "ana@example.test",
    password: "first-password-1",
    uri: "https://mail.example.test",
  });
  await web.close();

  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, user);
  await openItem(popup, "Example mail");

  // A new item has no earlier versions yet.
  await popup.getByTestId("keykeeper-version-history").click();
  await expect(popup.getByRole("heading", { name: "Version history" })).toBeVisible();
  await expect(popup.getByTestId("keykeeper-no-versions")).toHaveText("No earlier versions yet.");
  await historyPage(popup).getByRole("button", { name: "Back" }).click();
  await expect(historyPage(popup)).toHaveCount(0);

  await changePassword(popup, "second-password-2");
  await changePassword(popup, "third-password-3");

  await popup.getByTestId("keykeeper-version-history").click();
  await expect(popup.getByTestId("keykeeper-versions-who")).toHaveText(
    "Everyone who can open this item can see its earlier versions, including old passwords.",
  );
  const versions = popup.getByTestId("keykeeper-item-version");
  await expect(versions).toHaveCount(2);
  await expect(versions.first()).toContainText("Saved by you · 1 change");

  // The oldest: the first password, beside the item now, hidden until shown.
  await versions.last().getByRole("button").click();
  // A short date and time: "Oct 27, 2026, 1:15 AM", no seconds.
  await expect(
    popup.getByRole("heading", {
      name: /^Version from [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M$/,
    }),
  ).toBeVisible();
  const password = popup.getByRole("row", { name: /Password/ });
  await expect(password).toHaveAttribute("data-changed", "true");
  await expect(password.getByText("Changed")).toBeVisible();
  await expect(password).not.toContainText("first-password-1");
  await popup.getByRole("button", { name: "Show hidden values" }).click();
  await expect(password.getByRole("cell").nth(0)).toHaveText("first-password-1");
  await expect(password.getByRole("cell").nth(1)).toHaveText("third-password-3");
  await expect(popup.getByRole("row", { name: /Username/ })).toHaveAttribute(
    "data-changed",
    "false",
  );

  // Restoring asks first, then goes back to the item, which has it again.
  await popup.getByRole("button", { name: "Restore this version" }).click();
  const confirm = popup.getByRole("dialog", { name: "Restore this version?" });
  await expect(confirm).toContainText("How it is now stays in its version history");
  await confirm.getByRole("button", { name: "Restore this version" }).click();
  await expect(toast(popup, "Version restored")).toBeVisible();
  await expect(popup.getByRole("heading", { level: 1, name: "Example mail" })).toBeVisible();
  await expectPassword(popup, "first-password-1");

  // What it replaced is history now; the person's own item's history can be cleared.
  await popup.getByTestId("keykeeper-version-history").click();
  await expect(versions).toHaveCount(3);
  await versions.first().getByRole("button").click();
  await popup.getByRole("button", { name: "Show hidden values" }).click();
  await expect(popup.getByRole("row", { name: /Password/ }).getByRole("cell").nth(0)).toHaveText(
    "third-password-3",
  );
  // Back goes to the list first, then to the item.
  await historyPage(popup).getByRole("button", { name: "Back" }).click();
  await expect(versions).toHaveCount(3);
  await popup.getByRole("button", { name: "Clear history" }).click();
  const clear = popup.getByRole("dialog", { name: "Clear this item's history?" });
  await clear.getByRole("button", { name: "Clear history" }).click();
  await expect(toast(popup, "History cleared")).toBeVisible();
  await expect(popup.getByTestId("keykeeper-no-versions")).toBeVisible();
  await expect(popup.getByRole("button", { name: "Clear history" })).toHaveCount(0);
});
