// MSP templates in the console: an MSP admin makes a template in their own
// vault and adds it for every client, and it applies to all of them, a client
// added later included; editing it changes every client's copy without
// anything else to click; the copies show once, under "From <MSP>", when
// making a new item; and removing it can take the copies away. Real keys
// throughout: each copy is encrypted for its client in the browser. See
// DESIGN.md, "MSP templates".
import { expect, test, type Page } from "@playwright/test";

import { signUp, webUserFor } from "./support/web";

/** A toast message. Toasts here have no ARIA role, so find them by text. */
const toast = (page: Page, text: string) =>
  page.getByText(text, { exact: true });

async function addClient(page: Page, name: string) {
  await page.getByRole("textbox", { name: "New client's name" }).fill(name);
  await page.getByRole("button", { name: "Add client" }).click();
  await expect(toast(page, `Added ${name}`)).toBeVisible();
}

/** Saving an item opens its View dialog; closes it. */
async function closeView(page: Page) {
  const view = page.getByRole("dialog", { name: /^View/ });
  await view.getByRole("button", { name: "Close" }).first().click();
  await expect(view).toBeHidden();
}

/** Opens "New item from a template" in the vault. */
async function templateChooser(page: Page) {
  await page.goto("/#/vault");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "From template" }).click();
  return page.getByRole("dialog", { name: "New item from a template" });
}

test("a template added for every client applies to all of them, a new client included, edits reach every client on their own, and removing it can take the copies away", async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const context = await browser.newContext();
  const admin = await context.newPage();
  const adminUser = webUserFor("msp-admin-templates", testInfo.repeatEachIndex);
  await signUp(admin, adminUser);
  await admin.goto("/#/msp");
  await admin
    .getByRole("textbox", { name: "Your MSP's name" })
    .fill("Northwind IT");
  await admin.getByRole("button", { name: "Create MSP" }).click();
  await addClient(admin, "Acme Dental");
  await addClient(admin, "Baker Law");

  // Nothing to send yet: the console says how to make a template.
  const templates = admin.getByTestId("msp-templates");
  await expect(templates).toContainText("No templates yet.");
  await expect(templates).toContainText("Make a template first");

  // A template in the admin's own vault.
  let chooser = await templateChooser(admin);
  await chooser.getByRole("button", { name: "Create template" }).click();
  await admin
    .getByRole("dialog", { name: "New template" })
    .getByRole("button", { name: "Notes" })
    .click();
  const editor = admin.getByRole("dialog", { name: /^New/ });
  await editor.getByRole("textbox", { name: /Item name/ }).fill("Firewall");
  await editor.getByRole("button", { name: "Add field" }).click();
  const addField = admin.getByRole("dialog", { name: "Add field" });
  await addField
    .getByRole("textbox", { name: /Field label/ })
    .fill("Management URL");
  await addField.getByRole("button", { name: "Add", exact: true }).click();
  await expect(addField).toBeHidden();
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toBeHidden();
  await closeView(admin);

  // Added for every client: it applies to both.
  await admin.goto("/#/msp");
  const add = admin.getByRole("form", { name: "Add a template" });
  await expect(add.getByRole("combobox", { name: "Template" })).toHaveValue(
    /.+/,
  );
  await expect(add.getByRole("radio", { name: /Every client/ })).toBeChecked();
  await add.getByRole("button", { name: "Add template" }).click();
  await expect(
    toast(admin, "Firewall now applies to every client."),
  ).toBeVisible();
  const row = templates.getByTestId("msp-template-Firewall");
  await expect(row).toContainText("Every client");
  await expect(row.getByTestId("msp-template-status")).toHaveText("Up to date");

  // A client added later gets it right away.
  await addClient(admin, "Corner Bakery");
  await expect(row.getByTestId("msp-template-status")).toHaveText("Up to date");

  // The admin edits it from the console. Saving is all: the vault updates
  // every client's copy in the background.
  await row.getByRole("link", { name: "Edit Firewall" }).click();
  const edit = admin.getByRole("dialog", { name: /^Edit/ });
  await edit.getByRole("button", { name: "Add field" }).click();
  await addField
    .getByRole("textbox", { name: /Field label/ })
    .fill("Firmware version");
  await addField.getByRole("button", { name: "Add", exact: true }).click();
  await expect(addField).toBeHidden();
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  await closeView(admin);
  await expect(async () => {
    const picker = await templateChooser(admin);
    await picker
      .getByRole("region", { name: "From Northwind IT" })
      .getByRole("button", { name: "Firewall", exact: true })
      .click();
    const item = admin.getByRole("dialog", { name: /^New/ });
    try {
      await expect(
        item.getByRole("textbox", { name: "Firmware version", exact: true }),
      ).toBeVisible({ timeout: 1000 });
    } finally {
      await item.getByRole("button", { name: "Cancel" }).click();
    }
  }).toPass({ timeout: 60_000, intervals: [2_000] });

  await admin.goto("/#/msp");
  await expect(row.getByTestId("msp-template-status")).toHaveText("Up to date");
  await expect(
    row.getByRole("button", { name: "Update Firewall" }),
  ).toHaveCount(0);
  const activity = admin.getByTestId("msp-activity");
  await expect(activity).toContainText(
    `${adminUser.email} added the template Firewall for every client`,
  );
  await expect(activity).toContainText(
    `Firewall was applied to Corner Bakery (by ${adminUser.email})`,
  );
  await expect(activity).toContainText(
    `Firewall was applied to 3 clients (by ${adminUser.email})`,
  );

  // Making an item: the three clients' copies show once, from the MSP; the
  // admin's own shows under their own templates.
  chooser = await templateChooser(admin);
  const fromMsp = chooser.getByRole("region", { name: "From Northwind IT" });
  await expect(fromMsp.getByRole("button")).toHaveCount(1);
  await expect(
    chooser
      .getByRole("region", { name: "My templates" })
      .getByRole("button", { name: "Firewall", exact: true }),
  ).toBeVisible();
  await admin.keyboard.press("Escape");

  // A client's copy isn't in the vault's lists, only in the client's Templates
  // collection, and says where it comes from there.
  await admin.goto("/#/vault");
  const firewalls = admin.getByRole("row").filter({ hasText: "Firewall" });
  await expect(firewalls.first()).toBeVisible();
  await expect(firewalls.filter({ hasText: "Acme Dental" })).toHaveCount(0);
  await admin.getByRole("button", { name: "vault: Acme Dental" }).click();
  await admin.getByRole("button", { name: "Filter: Templates" }).click();
  await firewalls.filter({ hasText: "Acme Dental" }).getByText("Firewall", { exact: true }).click();
  await expect(
    admin
      .getByRole("dialog", { name: /^View/ })
      .getByTestId("keykeeper-template-definition"),
  ).toContainText("It comes from Northwind IT, which keeps it up to date.");
  await closeView(admin);

  // Removing it, from the clients too.
  await admin.goto("/#/msp");
  await row.getByRole("button", { name: "Remove Firewall" }).click();
  await admin.getByRole("button", { name: "Remove", exact: true }).click();
  await admin.getByRole("button", { name: "Remove from clients" }).click();
  await expect(toast(admin, "Removed Firewall")).toBeVisible();
  await expect(templates).toContainText("No templates yet.");
  chooser = await templateChooser(admin);
  await expect(
    chooser.getByRole("region", { name: "My templates" }),
  ).toBeVisible();
  await expect(
    chooser.getByRole("region", { name: "From Northwind IT" }),
  ).toHaveCount(0);
  await context.close();
});
