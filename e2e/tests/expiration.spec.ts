// Expiration dates: set one on any item; the item and the vault list show when
// it expires; cards expire on their own expiry month. Dates are relative to the
// day the test runs (browsers in tests use UTC).
import { expect, test, type Page } from "@playwright/test";

import { newItem, signUp, webUserFor } from "./support/web";

/** "YYYY-MM-DD" for today plus some days, in UTC like the test browser. */
function isoInDays(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function openNewLogin(page: Page, name: string) {
  await newItem(page, "Login");
  const dialog = page.getByRole("dialog", { name: "New Login" });
  await dialog.getByRole("textbox", { name: /Item name/ }).fill(name);
  return dialog;
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
  const edit = page.getByRole("dialog", { name: /Edit Login/ });
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
  const view = page.getByRole("dialog", { name: /View Card/ });
  const expected =
    daysToMonthEnd === 0 ? "Expires today" : daysToMonthEnd === 1 ? "Expires tomorrow" : `Expires in ${daysToMonthEnd} days`;
  await expect(view.getByTestId("keykeeper-expiration")).toContainText(expected);
});

test("the expiring items report lists what has expired or expires soon, soonest first", async ({
  page,
}, testInfo) => {
  await signUp(page, webUserFor("expires-report", testInfo.repeatEachIndex));

  const now = new Date();
  const note = (name: string, expires?: string) => ({
    type: 2,
    name,
    secureNote: { type: 0 },
    fields: expires ? [{ name: "keykeeper.expires", value: expires, type: 0, linkedId: null }] : [],
  });
  const items = [
    note("Old certificate", isoInDays(-5)),
    note("Payments API", isoInDays(5)),
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
  const lastDayOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  const daysToMonthEnd = lastDayOfMonth.getUTCDate() - now.getUTCDate();
  const expected = ["Old certificate", ...(daysToMonthEnd < 5 ? ["Expiring card", "Payments API"] : ["Payments API", "Expiring card"])];
  await expect(page.getByTestId("keykeeper-report-expires")).toHaveCount(3);
  await expect(page.locator("bit-table-scroll tr td:nth-child(2) a")).toHaveText(expected);
  await expect(page.getByText("Domain renewal")).toHaveCount(0);
  await expect(page.getByText("Office door code")).toHaveCount(0);
});
