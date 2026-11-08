// Expiration dates: set one on any item; the item and the vault list show when
// it expires; cards expire on their own expiry month. Dates are relative to the
// day the test runs (browsers in tests use UTC).
import { expect, test, type Page } from "@playwright/test";

import { menu, menuEntry, newItem, pick, signUp, signUpWithAuthenticator, webUserFor } from "./support/web";

/** "YYYY-MM-DD" for today plus some days, in UTC like the test browser. */
function isoInDays(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function openNewLogin(page: Page, name: string) {
  await newItem(page, "Login");
  const dialog = page.getByRole("dialog", { name: "Add login" });
  await dialog.getByRole("textbox", { name: /Item name/ }).fill(name);
  return dialog;
}

/** Imports items as Bitwarden (json), as a person pastes an export. */
async function importItems(page: Page, items: object[]) {
  await page.goto("/#/tools/import");
  await page.getByRole("combobox", { name: /File format/ }).click();
  await page.getByRole("option", { name: "Bitwarden (json)" }).click();
  await page
    .getByRole("textbox", { name: /copy\/paste the import file contents/ })
    .fill(JSON.stringify({ encrypted: false, folders: [], items }));
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByRole("dialog", { name: "Data successfully imported" }).getByRole("button", { name: "Ok" }).click();
}

const note = (name: string, expires?: string, remind?: string) => ({
  type: 2,
  name,
  secureNote: { type: 0 },
  fields: [
    ...(expires ? [{ name: "keykeeper.expires", value: expires, type: 0, linkedId: null }] : []),
    ...(remind ? [{ name: "keykeeper.remind", value: remind, type: 0, linkedId: null }] : []),
  ],
});

/** A card whose expiry month is this month, so it expires within 30 days. */
function cardThisMonth(name: string) {
  const now = new Date();
  return {
    type: 3,
    name,
    card: {
      cardholderName: "Alice Example",
      number: "4111111111111111",
      expMonth: String(now.getUTCMonth() + 1),
      expYear: String(now.getUTCFullYear()),
      code: "123",
    },
  };
}

/** What a badge says for a card that expires at the end of this month. */
function cardBadge() {
  const now = new Date();
  const lastDayOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  const days = lastDayOfMonth.getUTCDate() - now.getUTCDate();
  return days === 0 ? "Expires today" : days === 1 ? "Expires tomorrow" : `Expires in ${days} days`;
}

const listBadge = (page: Page, itemName: string) =>
  page
    .getByRole("row")
    .filter({ hasText: itemName })
    .getByTestId("keykeeper-expiration-badge");

test("an expiration date shows on the item and in the list, and can be cleared", async ({
  page,
}, testInfo) => {
  await signUp(page, webUserFor("expires", testInfo.repeatEachIndex));

  const dialog = await openNewLogin(page, "Example API key");
  await dialog.getByTestId("keykeeper-expires").fill(isoInDays(10));
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  // Saving a new item opens its view.
  const view = page.getByRole("dialog", { name: "View Login" });
  await expect(view.getByTestId("keykeeper-expiration")).toContainText("Expires in 10 days");
  // Keykeeper's own field never shows as a custom field.
  await expect(view.getByText("keykeeper.expires")).toHaveCount(0);
  await view.getByRole("button", { name: "Close" }).first().click();
  await expect(listBadge(page, "Example API key")).toHaveText("Expires in 10 days");

  await page.getByText("Example API key").first().click();
  // Clearing the date in the editor removes it everywhere.
  await view.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: /Edit login/i });
  await expect(edit.getByTestId("keykeeper-expires")).toHaveValue(isoInDays(10));
  await edit.getByTestId("keykeeper-expires").fill("");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  await expect(view.getByTestId("keykeeper-expiration")).toHaveCount(0);
  await view.getByRole("button", { name: "Close" }).first().click();
  // The row is there (so the list is readable) and carries no badge.
  await expect(page.getByRole("row").filter({ hasText: "Example API key" })).toBeVisible();
  await expect(listBadge(page, "Example API key")).toHaveCount(0);
});

test("setting a date and adding a custom field in one edit keeps both", async ({
  page,
}, testInfo) => {
  await signUp(page, webUserFor("expires-fields", testInfo.repeatEachIndex));

  const dialog = await openNewLogin(page, "Example server");
  await dialog.getByTestId("keykeeper-expires").fill(isoInDays(3));
  await dialog.getByRole("button", { name: "Add field" }).click();
  const addField = page.getByRole("dialog", { name: "Add field" });
  await addField.getByRole("textbox", { name: /Field label/ }).fill("Hostname");
  await addField.getByRole("button", { name: "Add", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Hostname", exact: true }).fill("db1.example.test");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  // Saving a new item opens its view.
  const view = page.getByRole("dialog", { name: "View Login" });
  await expect(view.getByRole("textbox", { name: "Hostname" })).toHaveValue("db1.example.test");
  await expect(view.getByTestId("keykeeper-expiration")).toContainText("Expires in 3 days");
});

test("an expired item and a card expiring this month are flagged", async ({ page }, testInfo) => {
  await signUp(page, webUserFor("expires-import", testInfo.repeatEachIndex));

  // The card's expiry month is this month, so it expires at the end of it.
  const now = new Date();
  const lastDayOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  const daysToMonthEnd = lastDayOfMonth.getUTCDate() - now.getUTCDate();
  const items = {
    encrypted: false,
    folders: [],
    items: [
      {
        type: 2,
        name: "Old certificate",
        secureNote: { type: 0 },
        fields: [{ name: "keykeeper.expires", value: isoInDays(-5), type: 0, linkedId: null }],
      },
      {
        type: 3,
        name: "Expiring card",
        card: {
          cardholderName: "Alice Example",
          number: "4111111111111111",
          expMonth: String(now.getUTCMonth() + 1),
          expYear: String(now.getUTCFullYear()),
          code: "123",
        },
      },
    ],
  };
  await page.goto("/#/tools/import");
  await page.getByRole("combobox", { name: /File format/ }).click();
  await page.getByRole("option", { name: "Bitwarden (json)" }).click();
  await page
    .getByRole("textbox", { name: /copy\/paste the import file contents/ })
    .fill(JSON.stringify(items));
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByRole("dialog", { name: "Data successfully imported" }).getByRole("button", { name: "Ok" }).click();

  await page.goto("/#/vault");
  await expect(listBadge(page, "Old certificate")).toHaveText("Expired 5 days ago");

  await page.getByText("Expiring card").first().click();
  const view = page.getByRole("dialog", { name: /View card/i });
  const expected =
    daysToMonthEnd === 0 ? "Expires today" : daysToMonthEnd === 1 ? "Expires tomorrow" : `Expires in ${daysToMonthEnd} days`;
  await expect(view.getByTestId("keykeeper-expiration")).toContainText(expected);
});

test("the expiring items report lists what has expired or expires soon, soonest first", async ({
  page,
}, testInfo) => {
  await signUp(page, webUserFor("expires-report", testInfo.repeatEachIndex));

  const now = new Date();
  // The card expires at the end of this month. Payments API expires in 5
  // days, or 6 when that's the same day as the card: a tie has no order.
  const lastDayOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  const daysToMonthEnd = lastDayOfMonth.getUTCDate() - now.getUTCDate();
  const paymentsDays = daysToMonthEnd === 5 ? 6 : 5;
  const note = (name: string, expires?: string) => ({
    type: 2,
    name,
    secureNote: { type: 0 },
    fields: expires ? [{ name: "keykeeper.expires", value: expires, type: 0, linkedId: null }] : [],
  });
  const items = [
    note("Old certificate", isoInDays(-5)),
    note("Payments API", isoInDays(paymentsDays)),
    note("Domain renewal", isoInDays(90)),
    note("Office door code"),
    {
      type: 3,
      name: "Expiring card",
      card: {
        cardholderName: "Alice Example",
        number: "4111111111111111",
        expMonth: String(now.getUTCMonth() + 1),
        expYear: String(now.getUTCFullYear()),
        code: "123",
      },
    },
  ];
  await page.goto("/#/tools/import");
  await page.getByRole("combobox", { name: /File format/ }).click();
  await page.getByRole("option", { name: "Bitwarden (json)" }).click();
  await page
    .getByRole("textbox", { name: /copy\/paste the import file contents/ })
    .fill(JSON.stringify({ encrypted: false, folders: [], items }));
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByRole("dialog", { name: "Data successfully imported" }).getByRole("button", { name: "Ok" }).click();

  // The report has a card on the Reports page, with our strings.
  await page.goto("/#/reports");
  await page.getByText("Expiring items", { exact: true }).click();
  await expect(page).toHaveURL(/expiring-items-report/);

  // Expired first, then by date; nothing that expires later or never.
  const expected = [
    "Old certificate",
    ...(daysToMonthEnd < paymentsDays ? ["Expiring card", "Payments API"] : ["Payments API", "Expiring card"]),
  ];
  await expect(page.getByTestId("keykeeper-report-expires")).toHaveCount(3);
  await expect(page.locator("bit-table-scroll tr td:nth-child(2) a")).toHaveText(expected);
  await expect(page.getByText("Domain renewal")).toHaveCount(0);
  await expect(page.getByText("Office door code")).toHaveCount(0);
});

test("Expiring soon in the menu lists what has expired or expires within 30 days, cards included, and Health counts them", async ({
  page,
}, testInfo) => {
  await signUp(page, webUserFor("expires-filter", testInfo.repeatEachIndex));
  // Nothing expires yet: no Expiring soon.
  await expect(menuEntry(page, "Expiring soon")).toHaveCount(0);

  await importItems(page, [
    note("Old certificate", isoInDays(-5)),
    note("Payments API", isoInDays(5)),
    note("Domain renewal", isoInDays(90)),
    note("Office door code"),
    cardThisMonth("Expiring card"),
  ]);
  await page.goto("/#/vault");

  // Under Favorites, with how many it shows.
  const entry = menuEntry(page, "Expiring soon");
  await expect(entry).toBeVisible();
  await expect(entry.locator(".keykeeper-menu-count")).toHaveText("3");
  // Health counts them too: nothing else here has anything to fix.
  await expect(menu(page).getByTestId("keykeeper-health-count")).toHaveText("3", { timeout: 30_000 });

  await pick(page, "Expiring soon");
  await expect(page).toHaveURL(/type=expiring/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Expiring soon");
  for (const name of ["Old certificate", "Payments API", "Expiring card"]) {
    await expect(page.getByRole("row").filter({ hasText: name })).toBeVisible();
  }
  await expect(page.getByRole("row").filter({ hasText: "Domain renewal" })).toHaveCount(0);
  await expect(page.getByRole("row").filter({ hasText: "Office door code" })).toHaveCount(0);
  // A card's badge in the list, from its expiry month.
  await expect(listBadge(page, "Expiring card")).toHaveText(cardBadge());
  await expect(listBadge(page, "Old certificate")).toHaveText("Expired 5 days ago");

  // Inside Personal, as a category is.
  await pick(page, "All items");
  await expect(page).not.toHaveURL(/type=expiring/);
  await expect(page.getByRole("row").filter({ hasText: "Domain renewal" })).toBeVisible();
});

test("Remind me sets an item's reminder days, which the item shows and the editor keeps", async ({
  page,
}, testInfo) => {
  await signUp(page, webUserFor("expires-remind-web", testInfo.repeatEachIndex));

  const dialog = await openNewLogin(page, "Example certificate");
  // Remind me shows once there's a date to remind about.
  await expect(dialog.getByTestId("keykeeper-remind")).toHaveCount(0);
  await dialog.getByTestId("keykeeper-expires").fill(isoInDays(20));
  await dialog.getByRole("combobox", { name: "Remind me" }).click();
  await page.getByRole("option", { name: "7 and 1 day before", exact: true }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  const view = page.getByRole("dialog", { name: "View Login" });
  await expect(view.getByTestId("keykeeper-remind-days")).toHaveText("Reminders 7 and 1 day before");
  await expect(view.getByText("keykeeper.remind")).toHaveCount(0);

  await view.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: /Edit Login/ });
  await expect(edit.getByTestId("keykeeper-remind")).toContainText("7 and 1 day before");
  await edit.getByRole("combobox", { name: "Remind me" }).click();
  await page.getByRole("option", { name: "Don't remind me", exact: true }).click();
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  await expect(view.getByTestId("keykeeper-remind-days")).toHaveText("No reminders");

  // Back to the default: nothing said, nothing stored.
  await view.getByRole("button", { name: "Edit" }).click();
  await edit.getByRole("combobox", { name: "Remind me" }).click();
  await page.getByRole("option", { name: "30, 7, and 1 day before", exact: true }).click();
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  await expect(view.getByTestId("keykeeper-expiration")).toContainText("Expires in 20 days");
  await expect(view.getByTestId("keykeeper-remind-days")).toHaveCount(0);
});

test("an organization's Reports lists its items that have expired or expire soon", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await signUpWithAuthenticator(page, webUserFor("expires-org", testInfo.repeatEachIndex));
  await page.goto("/#/create-organization");
  await page.getByRole("textbox", { name: /Organization name/ }).fill("Harbor Dental");
  await page.getByRole("radio", { name: /A business/ }).check();
  await page.getByRole("button", { name: "Create organization" }).click();
  await page.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  const org = page.url().replace(/\/members.*$/, "");

  // A login in Everyone that expires in 4 days, made in the admin console.
  await page.goto(`${org}/vault`);
  await page.getByRole("button", { name: "Everyone", exact: true }).first().click();
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Login" }).click();
  const item = page.getByRole("dialog", { name: "New Login" });
  await item.getByRole("textbox", { name: /Item name/ }).fill("Front desk certificate");
  await item.getByTestId("keykeeper-expires").fill(isoInDays(4));
  await item.getByRole("button", { name: "Save" }).click();
  await expect(item).toBeHidden();
  // Saving opens the item's view; close it.
  await page.getByRole("dialog", { name: "View Login" }).getByRole("button", { name: "Close" }).first().click();

  await page.goto(`${org}/reporting/reports`);
  await page.getByText("Expiring items", { exact: true }).click();
  await expect(page).toHaveURL(/expiring-items-report/);
  await expect(page.locator("bit-table-scroll tr td:nth-child(2) a")).toHaveText(["Front desk certificate"]);
  await expect(page.getByTestId("keykeeper-report-expires")).toContainText("Expires in 4 days");
});
