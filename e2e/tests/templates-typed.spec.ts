// Typed template fields (DESIGN.md, "Item templates": "Where a field's type is
// kept", "A date field that sets Expires", "The Item templates view"): a
// custom template with a date field that's new items' expiration date and a
// website field; an item from it gets a date picker that sets Expires, so the
// item is in Expiring soon, and a website check that warns without stopping a
// save; and the template is under Item templates, not in All items. Dates are
// relative to the day the test runs (browsers in tests use UTC).
import { expect, test } from "@playwright/test";

import { menuEntry, newTemplate, pick, signUp, templatePicker, webUserFor } from "./support/web";

/** "YYYY-MM-DD" for today plus some days, in UTC like the test browser. */
function isoInDays(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test("a template's date field sets new items' Expires, its website field warns without stopping a save, and the template is under Item templates", async ({
  page,
}, testInfo) => {
  await signUp(page, webUserFor("template-typed", testInfo.repeatEachIndex));

  // A template for notes, with a date that's new items' expiration date, and a website.
  await newTemplate(page, "notes");
  const editor = page.getByRole("dialog", { name: /^Add/ });
  await editor.getByRole("textbox", { name: /Item name/ }).fill("Software license");
  for (const [kind, label] of [
    ["Date", "Renews"],
    ["Website", "Vendor site"],
  ] as const) {
    await editor.getByRole("button", { name: "Add field" }).click();
    const addField = page.getByRole("dialog", { name: "Add field" });
    await addField.getByRole("combobox", { name: /Field type/ }).click();
    await page.getByRole("option", { name: kind, exact: true }).click();
    await addField.getByRole("textbox", { name: /Field label/ }).fill(label);
    if (kind === "Date") {
      await addField.getByRole("checkbox", { name: "New items expire on this date" }).check();
    }
    await addField.getByRole("button", { name: "Add", exact: true }).click();
    await expect(addField).toBeHidden();
    // The editor moves to the new field once it has announced it, a moment
    // later; a label typed before then would land in this field instead.
    await expect(editor.getByLabel(label, { exact: true })).toBeFocused();
  }
  await expect(editor.getByText("Date. New items expire on this date.")).toBeVisible();
  await expect(editor.getByText("Website.", { exact: true })).toBeVisible();
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toBeHidden();
  const templateView = page.getByRole("dialog", { name: /^View/ });
  await expect(templateView.getByTestId("keykeeper-template-definition")).toContainText(
    "New notes from this template",
  );
  await templateView.getByRole("button", { name: "Close" }).first().click();
  await expect(templateView).toBeHidden();

  // Templates leave All items: Item templates has it, with its count.
  const rows = (name: string) => page.getByRole("row").filter({ hasText: name });
  await expect(menuEntry(page, "Item templates")).toContainText("1");
  await expect(rows("Software license")).toHaveCount(0);
  await pick(page, "Item templates");
  await expect(rows("Software license").getByTestId("keykeeper-template-badge")).toHaveText(
    "Template",
  );
  await pick(page, "All items");
  await expect(rows("Software license")).toHaveCount(0);

  // An item from it: the date is a date picker, and filling it sets Expires.
  await (await templatePicker(page))
    .getByRole("region", { name: "My templates" })
    .getByRole("button", { name: "Software license", exact: true })
    .click();
  const item = page.getByRole("dialog", { name: /^Add/ });
  await item.getByRole("textbox", { name: /Item name/ }).fill("Office suite license");
  const renews = item.getByLabel("Renews", { exact: true });
  await expect(renews).toHaveAttribute("type", "date");
  await expect(item.getByText("Also when this item expires.")).toBeVisible();
  await renews.fill(isoInDays(10));
  await expect(item.getByTestId("keykeeper-expires")).toHaveValue(isoInDays(10));
  // A website that isn't one is warned about, and doesn't stop the save.
  const site = item.getByLabel("Vendor site", { exact: true });
  await expect(site).toHaveAttribute("inputmode", "url");
  await site.fill("not a site");
  await expect(item.getByTestId("keykeeper-field-warning")).toHaveText(
    "This doesn't look like a web address.",
  );
  await item.getByRole("button", { name: "Save" }).click();
  await expect(item).toBeHidden();

  // Saved with its date as the item's expiration.
  const view = page.getByRole("dialog", { name: /^View/ });
  await expect(view.getByTestId("keykeeper-template")).toHaveText("Software license");
  await expect(view.getByTestId("keykeeper-expiration")).toContainText("Expires in 10 days");
  await expect(view.getByRole("textbox", { name: "Vendor site" })).toHaveValue("not a site");
  await expect(view.getByText("keykeeper.template")).toHaveCount(0);
  await view.getByRole("button", { name: "Close" }).first().click();
  await expect(view).toBeHidden();

  // In All items, with its badge, and in Expiring soon; the template in neither.
  await expect(rows("Office suite license").getByTestId("keykeeper-expiration-badge")).toHaveText(
    "Expires in 10 days",
  );
  await pick(page, "Expiring soon");
  await expect(rows("Office suite license")).toBeVisible();
  await expect(rows("Software license")).toHaveCount(0);

  // Changing Expires changes the date field.
  await rows("Office suite license").getByText("Office suite license", { exact: true }).click();
  await view.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: /^Edit/ });
  await expect(edit.getByLabel("Renews", { exact: true })).toHaveValue(isoInDays(10));
  await edit.getByTestId("keykeeper-expires").fill(isoInDays(20));
  await expect(edit.getByLabel("Renews", { exact: true })).toHaveValue(isoInDays(20));
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  await expect(view.getByTestId("keykeeper-expiration")).toContainText("Expires in 20 days");
});
