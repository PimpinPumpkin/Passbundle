// Selecting several templates in the MSP console (DESIGN.md, "Selecting
// several items"). An MSP admin's Templates table has a checkbox per row and
// one in its header; a click toggles a row and Shift+click takes the range.
// The bar at the bottom says how many are selected and offers what each row's
// own links offer: Clients, Update when a selected template is behind, and
// Remove. One choice and one confirmation cover the whole selection, and the
// result says how many templates it was done to.
import { expect, test, type Page } from "@playwright/test";

import { newTemplate, pick, signUpWithAuthenticator, webUserFor } from "./support/web";

/** A toast message. Toasts here have no ARIA role, so find them by text. */
const toast = (page: Page, text: string) => page.getByText(text, { exact: true });

/** The bar at the bottom, there only while something is selected. */
const bar = (page: Page) => page.getByRole("toolbar", { name: "Bulk actions" });

/** A row's checkbox, by the template's name: what a screen reader calls it. */
const box = (page: Page, name: string) =>
  page.getByRole("checkbox", { name: `Select ${name}`, exact: true });

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

/** Makes a secure note template in the shared folder the vault is showing. */
async function makeTemplate(page: Page, name: string) {
  await newTemplate(page, "notes");
  const editor = page.getByRole("dialog", { name: /^Add/ });
  await editor.getByRole("textbox", { name: /Item name/ }).fill(name);
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toBeHidden();
  const view = page.getByRole("dialog", { name: /^View/ });
  await view.getByRole("button", { name: "Close" }).first().click();
  await expect(view).toBeHidden();
}

/** Adds a template of the admin's for every client, from the console's form. */
async function addForEveryClient(page: Page, name: string) {
  const add = page.getByRole("form", { name: "Add a template" });
  await add.getByRole("combobox", { name: "Template" }).selectOption({ label: name });
  await expect(add.getByRole("radio", { name: /Every client/ })).toBeChecked();
  await add.getByRole("button", { name: "Add template" }).click();
  await expect(toast(page, `${name} now applies to every client.`)).toBeVisible();
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

test("an MSP admin selects several templates and changes their clients, then removes them, together", async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const context = await browser.newContext();
  const admin = await context.newPage();
  await signUpWithAuthenticator(admin, webUserFor("msp-admin-select", testInfo.repeatEachIndex));
  await admin.goto("/#/msp");
  await admin.getByRole("textbox", { name: "Your MSP's name" }).fill("Northwind IT");
  await admin.getByRole("button", { name: "Create MSP" }).click();
  await addClient(admin, "Acme Dental");
  await addClient(admin, "Baker Law");

  // Three templates in the MSP's own organization, each added for every client.
  await createOrganization(admin, "Northwind Team");
  await admin.goto("/#/vault");
  await pick(admin, "Northwind Team");
  await pick(admin, "Default shared folder");
  const names = ["Firewall", "Printer", "Switch"];
  for (const name of names) {
    await makeTemplate(admin, name);
  }
  await admin.goto("/#/msp");
  const templates = admin.getByTestId("msp-templates");
  for (const name of names) {
    await addForEveryClient(admin, name);
    await expect(
      templates.getByTestId(`msp-template-${name}`).getByTestId("msp-template-status"),
    ).toHaveText("Up to date");
  }
  const rows = templates.getByRole("checkbox", { name: /^Select (?!all templates$)/ });
  const selected = templates.getByRole("checkbox", {
    name: /^Select (?!all templates$)/,
    checked: true,
  });
  await expect(rows).toHaveCount(3);
  // The rows in the order the table shows them, whatever that is.
  const order = (
    await rows.evaluateAll((boxes) => boxes.map((b) => b.getAttribute("aria-label")!))
  ).map((label) => label.replace(/^Select /, ""));
  expect([...order].sort()).toEqual(names);

  // Nothing selected: no bar. A click selects one row, and the bar says so.
  await expect(bar(admin)).toBeHidden();
  await box(admin, order[0]).click();
  await expect(box(admin, order[0])).toBeChecked();
  await expect(bar(admin)).toContainText("1 selected");

  // Shift+click takes everything from the last clicked row to this one.
  await box(admin, order[2]).click({ modifiers: ["Shift"] });
  await expect(selected).toHaveCount(3);
  await expect(bar(admin)).toContainText("3 selected");
  await expect(admin.getByRole("checkbox", { name: "Select all templates" })).toBeChecked();

  // A plain click takes one back out; Clear on the bar lets go of the rest.
  await box(admin, order[1]).click();
  await expect(selected).toHaveCount(2);
  await expect(bar(admin)).toContainText("2 selected");
  await bar(admin).getByRole("button", { name: "Clear" }).click();
  await expect(selected).toHaveCount(0);
  await expect(bar(admin)).toBeHidden();

  // Two of them now go to one client only: one choice for both, one question
  // about the copies the other client has, and one result.
  await box(admin, "Firewall").click();
  await box(admin, "Switch").click();
  await expect(bar(admin)).toContainText("2 selected");
  await act(admin, "Clients");
  const appliesTo = admin.getByRole("dialog", { name: /Applies to/ });
  await expect(appliesTo).toContainText("2 templates");
  await expect(appliesTo.getByRole("radio", { name: /Every client/ })).toBeChecked();
  await appliesTo.getByRole("radio", { name: /Only the clients chosen here/ }).check();
  await appliesTo.getByRole("checkbox", { name: "Acme Dental" }).check();
  await appliesTo.getByRole("button", { name: "Save" }).click();
  const leftBehind = admin.getByRole("dialog", {
    name: "Remove them from the clients that no longer get them?",
  });
  await expect(leftBehind).toContainText(
    "2 copies are in clients that no longer get these templates.",
  );
  await leftBehind.getByRole("button", { name: "Remove from those clients" }).click();
  await expect(toast(admin, "2 templates now apply to Acme Dental.")).toBeVisible();
  for (const name of ["Firewall", "Switch"]) {
    const row = templates.getByTestId(`msp-template-${name}`);
    await expect(row).toContainText("Acme Dental");
    await expect(row).not.toContainText("Every client");
  }
  await expect(templates.getByTestId("msp-template-Printer")).toContainText("Every client");
  // The selection is let go of once the action is done.
  await expect(selected).toHaveCount(0);
  await expect(bar(admin)).toBeHidden();

  // The header's checkbox takes every template; removing them asks once, with
  // how many, and once about the clients' copies.
  await admin.getByRole("checkbox", { name: "Select all templates" }).check();
  await expect(selected).toHaveCount(3);
  await expect(bar(admin)).toContainText("3 selected");
  await act(admin, "Remove");
  const confirm = admin.getByRole("dialog", { name: "Remove 3 templates?" });
  await expect(confirm).toContainText(
    "Clients you add later won't get them, and their copies won't change anymore.",
  );
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  const copies = admin.getByRole("dialog", { name: "Remove them from your clients too?" });
  // Firewall and Switch are left in Acme Dental only; Printer is in both clients.
  await expect(copies).toContainText("Your clients have 4 copies of them.");
  await copies.getByRole("button", { name: "Remove from clients" }).click();
  await expect(toast(admin, "Removed 3 templates")).toBeVisible();
  await expect(templates).toContainText("No templates yet.");
  await expect(bar(admin)).toBeHidden();
  await context.close();
});
