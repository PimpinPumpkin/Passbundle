// MSP templates in the console: an MSP admin makes a template in their own
// vault and sends it to every client; a client added later gets it too; after
// the source changes the console shows who needs it and updates them; the
// copies show once, under "From <MSP>", when making a new item; and stopping
// can take the copies away. Real keys throughout: each copy is encrypted for
// its client in the browser. See DESIGN.md, "MSP templates".
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

test("an MSP admin sends a template to every client, a new client gets it, changes reach every client, and stopping can remove the copies", async ({
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
  await expect(templates).toContainText("No templates sent yet.");
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

  // Sent to every client.
  await admin.goto("/#/msp");
  const send = admin.getByRole("form", { name: "Send a template" });
  await expect(send.getByRole("combobox", { name: "Template" })).toHaveValue(
    /.+/,
  );
  await expect(send.getByRole("radio", { name: /Every client/ })).toBeChecked();
  await send.getByRole("button", { name: "Send" }).click();
  await expect(
    toast(admin, "Sent Firewall to Acme Dental and Baker Law."),
  ).toBeVisible();
  const row = templates.getByTestId("msp-template-Firewall");
  await expect(row).toContainText("Every client");
  await expect(row.getByTestId("msp-template-status")).toHaveText("Up to date");

  // A client added later gets it right away.
  await addClient(admin, "Corner Bakery");
  await expect(toast(admin, "Sent 1 template to Corner Bakery")).toBeVisible();
  await expect(row.getByTestId("msp-template-status")).toHaveText("Up to date");

  // The admin changes the source in their vault; every client needs it.
  await admin.goto("/#/vault");
  // The admin's own, not the clients' copies the list also shows.
  await admin
    .getByRole("row")
    .filter({ hasText: "Firewall" })
    .filter({ hasText: /\bMe\b/ })
    .getByText("Firewall", { exact: true })
    .click();
  const view = admin.getByRole("dialog", { name: /^View/ });
  await view.getByRole("button", { name: "Edit", exact: true }).click();
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

  await admin.goto("/#/msp");
  await expect(row.getByTestId("msp-template-status")).toHaveText(
    "3 of 3 clients need it",
  );
  await row.getByRole("button", { name: "Update 3 clients" }).click();
  await expect(
    toast(admin, "Sent Firewall to Acme Dental, Baker Law, and Corner Bakery."),
  ).toBeVisible();
  await expect(row.getByTestId("msp-template-status")).toHaveText("Up to date");
  const activity = admin.getByTestId("msp-activity");
  await expect(activity).toContainText(
    `${adminUser.email} started sending Firewall to every client`,
  );
  await expect(activity).toContainText(
    `${adminUser.email} sent Firewall to Corner Bakery`,
  );

  // Making an item: the three clients' copies show once, from the MSP, with
  // the new field; the admin's own source shows under their own templates.
  chooser = await templateChooser(admin);
  const fromMsp = chooser.getByRole("region", { name: "From Northwind IT" });
  await expect(fromMsp.getByRole("button")).toHaveCount(1);
  await expect(
    chooser
      .getByRole("region", { name: "My templates" })
      .getByRole("button", { name: "Firewall", exact: true }),
  ).toBeVisible();
  await fromMsp.getByRole("button", { name: "Firewall", exact: true }).click();
  const item = admin.getByRole("dialog", { name: /^New/ });
  await expect(
    item.getByRole("textbox", { name: "Firmware version", exact: true }),
  ).toBeVisible();
  await item.getByRole("button", { name: "Cancel" }).click();

  // A client's copy says where it comes from.
  await admin.goto("/#/vault");
  await admin
    .getByRole("row")
    .filter({ hasText: "Firewall" })
    .filter({ hasText: "Acme Dental" })
    .getByText("Firewall", { exact: true })
    .click();
  await expect(
    admin
      .getByRole("dialog", { name: /^View/ })
      .getByTestId("keykeeper-template-definition"),
  ).toContainText("It comes from Northwind IT, which keeps it up to date.");
  await closeView(admin);

  // Stopping, with the copies removed.
  await admin.goto("/#/msp");
  await row.getByRole("button", { name: "Stop sending Firewall" }).click();
  await admin
    .getByRole("button", { name: "Stop sending", exact: true })
    .click();
  await admin.getByRole("button", { name: "Remove copies" }).click();
  await expect(toast(admin, "Stopped sending Firewall")).toBeVisible();
  await expect(templates).toContainText("No templates sent yet.");
  chooser = await templateChooser(admin);
  await expect(
    chooser.getByRole("region", { name: "My templates" }),
  ).toBeVisible();
  await expect(
    chooser.getByRole("region", { name: "From Northwind IT" }),
  ).toHaveCount(0);
  await context.close();
});
