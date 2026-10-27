// MSP templates in the console: an MSP admin makes a template in an
// organization the MSP's admins share (never their own vault) and adds it for
// every client, and it applies to all of them, a client added later included;
// editing it changes every client's copy without anything else to click; the
// copies show once, where the template is, when making a new item, and
// nothing says who a template came from; narrowing it to one client can take
// the others' copies away; and removing it can take the copies away. Real
// keys throughout: each copy is encrypted for its client in the browser, and
// only into clients this browser made, which carry its client seal. See
// DESIGN.md, "MSP templates".
import { expect, test, type Page } from "@playwright/test";

import { menu, newTemplate, pick, signUp, templatePicker, webUserFor } from "./support/web";

/** A toast message. Toasts here have no ARIA role, so find them by text. */
const toast = (page: Page, text: string) =>
  page.getByText(text, { exact: true });

async function addClient(page: Page, name: string) {
  await page.getByRole("textbox", { name: "New client's name" }).fill(name);
  await page.getByRole("button", { name: "Add client" }).click();
  await expect(toast(page, `Added ${name}`)).toBeVisible();
}

/** A family-style organization of the admin's own, which isn't a client. */
async function createOrganization(page: Page, name: string) {
  await page.goto("/#/create-organization");
  await page.getByRole("textbox", { name: /Organization name/ }).fill(name);
  await page.getByRole("radio", { name: /A family or a group/ }).check();
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(toast(page, `Created ${name}`)).toBeVisible();
  await page.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
}

/** Saving an item opens its View dialog; closes it. */
async function closeView(page: Page) {
  const view = page.getByRole("dialog", { name: /^View/ });
  await view.getByRole("button", { name: "Close" }).first().click();
  await expect(view).toBeHidden();
}

/** Opens the New item picker's templates in the vault. */
async function templateChooser(page: Page) {
  await page.goto("/#/vault");
  return templatePicker(page);
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

  // A template in the MSP's own organization, in its shared folder.
  await createOrganization(admin, "Northwind Team");
  await admin.goto("/#/vault");
  await pick(admin, "Northwind Team");
  await pick(admin, "Default shared folder");
  await newTemplate(admin, "notes");
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
  // Acme Dental's copy, in its Templates collection, gets the new field.
  await expect(async () => {
    await admin.goto("/#/vault");
    await pick(admin, "Acme Dental");
    await pick(admin, "Templates");
    await admin
      .getByRole("row")
      .filter({ hasText: "Acme Dental" })
      .getByText("Firewall", { exact: true })
      .click();
    const copy = admin.getByRole("dialog", { name: /^View/ });
    try {
      await expect(copy.getByText("Firmware version", { exact: true })).toBeVisible({
        timeout: 1000,
      });
    } finally {
      await copy.getByRole("button", { name: "Close" }).first().click();
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

  // Making an item: the three clients' copies are the same as the template,
  // so it shows once, where it is; nothing says who it came from.
  let chooser = await templateChooser(admin);
  await expect(chooser.getByRole("button", { name: "Firewall", exact: true })).toHaveCount(1);
  await expect(
    chooser
      .getByRole("region", { name: "Northwind Team" })
      .getByRole("button", { name: "Firewall", exact: true }),
  ).toBeVisible();
  await expect(chooser.getByRole("region", { name: /^From / })).toHaveCount(0);
  await admin.keyboard.press("Escape");

  // A client's copy isn't in the vault's lists, only in the client's Templates
  // collection, and says where it comes from there.
  await admin.goto("/#/vault");
  const firewalls = admin.getByRole("row").filter({ hasText: "Firewall" });
  await expect(firewalls.first()).toBeVisible();
  await expect(firewalls.filter({ hasText: "Acme Dental" })).toHaveCount(0);
  // In the left menu: Acme Dental, then its Templates collection under it,
  // the only one once Acme Dental is picked.
  await pick(admin, "Acme Dental");
  await expect(admin).toHaveURL(/(organizationId|vaultId)=/);
  await expect(menu(admin).getByRole("button", { name: "Templates", exact: true })).toHaveCount(1);
  await pick(admin, "Templates");
  await firewalls.filter({ hasText: "Acme Dental" }).getByText("Firewall", { exact: true }).click();
  await expect(
    admin
      .getByRole("dialog", { name: /^View/ })
      .getByTestId("keykeeper-template-definition"),
  ).toContainText("It's a copy of a template kept up to date elsewhere");
  await closeView(admin);

  // Only one client now: the others' copies can go to their trash.
  await admin.goto("/#/msp");
  await row.getByRole("button", { name: "Change clients for Firewall" }).click();
  const appliesTo = admin.getByRole("dialog", { name: /Applies to/ });
  await expect(appliesTo.getByRole("radio", { name: /Every client/ })).toBeChecked();
  await appliesTo.getByRole("radio", { name: /Only the clients chosen here/ }).check();
  await appliesTo.getByRole("checkbox", { name: "Acme Dental" }).check();
  await appliesTo.getByRole("button", { name: "Save" }).click();
  await expect(admin.getByText("2 of them have it.", { exact: false })).toBeVisible();
  await admin.getByRole("button", { name: "Remove from those clients" }).click();
  await expect(toast(admin, "Firewall now applies to Acme Dental.")).toBeVisible();
  await expect(row).toContainText("Acme Dental");
  await expect(row).not.toContainText("Every client");
  await expect(row.getByTestId("msp-template-status")).toHaveText("Up to date");
  chooser = await templateChooser(admin);
  await expect(chooser.getByRole("button", { name: "Firewall", exact: true })).toHaveCount(1);
  await admin.keyboard.press("Escape");

  // Removing it, from the clients too.
  await admin.goto("/#/msp");
  await row.getByRole("button", { name: "Remove Firewall" }).click();
  await admin.getByRole("button", { name: "Remove", exact: true }).click();
  await admin.getByRole("button", { name: "Remove from clients" }).click();
  await expect(toast(admin, "Removed Firewall")).toBeVisible();
  await expect(templates).toContainText("No templates yet.");
  chooser = await templateChooser(admin);
  await expect(
    chooser
      .getByRole("region", { name: "Northwind Team" })
      .getByRole("button", { name: "Firewall", exact: true }),
  ).toBeVisible();
  await expect(chooser.getByRole("region", { name: "Acme Dental" })).toHaveCount(0);
  await context.close();
});
