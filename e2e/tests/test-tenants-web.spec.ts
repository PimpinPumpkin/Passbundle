// The test tenants (tools/test-tenants) as their people see them in the web
// vault, on a server set up as the hosted test server is while the tool seeds
// it, the new-device check on: the first sign-in from a browser goes straight
// through (the tool's own device can't approve, and the server sends no
// email), and what the tool encrypted opens, folder permissions included.
import { expect, type Locator, type Page, test } from "@playwright/test";

import { menu } from "./support/web";
import {
  readState,
  runTool,
  startTenantsServer,
  stopTenantsServer,
  type TenantsServer,
  tenantsServer,
} from "./support/test-tenants";

test.describe.configure({ mode: "serial" });

let server: TenantsServer;

test.beforeAll(async () => {
  test.setTimeout(10 * 60_000);
  server = await startTenantsServer();
  const seeded = await runTool(server, "seed");
  expect(seeded.code, seeded.stderr).toBe(0);
});

test.afterAll(async () => {
  test.setTimeout(10 * 60_000);
  if (server) {
    const down = await runTool(server, "teardown");
    expect(down.code, down.stderr).toBe(0);
  }
  await stopTenantsServer(server);
});

/** Signs in as one of the tenants' people, with what the tool wrote down. */
async function logIn(page: Page, key: string) {
  const who = readState(server).people[key];
  await page.goto(`${tenantsServer}/#/login`);
  await page.getByLabel(/Email address/).fill(who.email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("textbox", { name: /Master password/ }).fill(who.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveTitle(/^Items/, { timeout: 30_000 });
}

/**
 * Finds an item with the menu's search and opens it, typing the master
 * password first for an item that asks for it.
 */
async function openItem(page: Page, name: string, kind = "Login", reprompt?: string) {
  await menu(page).getByPlaceholder("Search all items").fill(name);
  await page.getByRole("row").filter({ hasText: name }).getByRole("button", { name }).first().click();
  if (reprompt) {
    const confirm = page.getByRole("dialog", { name: "Master password confirmation" });
    await confirm.getByRole("textbox", { name: /Master password/ }).fill(reprompt);
    await confirm.getByRole("button", { name: "Ok" }).click();
  }
  const view = page.getByRole("dialog", { name: new RegExp(`^View ${kind}$`, "i") });
  await expect(view).toBeVisible();
  return view;
}

async function closeItem(view: Locator) {
  await view.getByRole("button", { name: "Close" }).first().click();
  await expect(view).toBeHidden();
}

test("Alex Morgan signs in from a new browser and his own items open: a passkey, a template, a card, and history", async ({ page }) => {
  await logIn(page, "alex");
  for (const folder of ["Banking", "Shopping", "Social", "Work", "Home"]) {
    await expect(menu(page).getByRole("button", { name: folder, exact: true })).toBeVisible();
  }

  const passkey = await openItem(page, "webauthn.io");
  await expect(passkey.getByText(/Passkey/).first()).toBeVisible();
  await closeItem(passkey);

  // Chase asks for the master password first.
  const chase = await openItem(page, "Chase", "Login", readState(server).people.alex.password);
  await expect(chase.getByText("Version history")).toBeVisible();
  await closeItem(chase);

  const card = await openItem(page, "Visa debit", "Card");
  await expect(card.getByRole("textbox", { name: "Cardholder name" })).toHaveValue("Alex Morgan");
  await expect(card.getByRole("textbox", { name: "Number" })).toHaveValue("4242 4242 4242 4242");
  await closeItem(card);

  await expect(page.getByText(/cannot decrypt/i)).toHaveCount(0);
});

test("Tom Alvarez sees Northwind Dental's folders he's given, and passwords only where he may", async ({ page }) => {
  await logIn(page, "tom");
  const folders = menu(page).getByRole("group", { name: "Folders" });
  await expect(folders.getByRole("button", { name: "Northwind Dental", exact: true })).toBeVisible();
  for (const name of ["Everyone", "Front desk", "Practice software", "Vendors"]) {
    await expect(folders.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await expect(folders.getByRole("button", { name: "Banking and payroll", exact: true })).toHaveCount(0);

  // Practice software: the Front desk group can view, without passwords.
  const hidden = await openItem(page, "Imaging workstation");
  await expect(hidden.getByRole("button", { name: "Toggle visibility" })).toHaveCount(0);
  await closeItem(hidden);

  // Vendors: his own grid sees passwords.
  const seen = await openItem(page, "Dental supply orders");
  await expect(seen.getByRole("button", { name: "Toggle visibility" }).first()).toBeVisible();
  await closeItem(seen);

  await expect(page.getByText(/cannot decrypt/i)).toHaveCount(0);
});
