// Joining an organization without an MSP, in the web vault: someone invited
// gets in without an owner or admin clicking Confirm (the owner's unlocked
// web vault confirms them in the background), unless the organization asks
// for approval, set on its Settings page. Real keys throughout: confirming
// encrypts the organization's key to the person's real public key. This test
// server sends no email, so an invited account is accepted at once; the mail
// tests cover the emailed link and its lifetime. See DESIGN.md, "Joining".
import { expect, test, type Page } from "@playwright/test";

import { signUp, webUserFor, type WebUser } from "./support/web";

/** A toast message. Toasts here have no ARIA role, so find them by text. */
const toast = (page: Page, text: string) => page.getByText(text, { exact: true });

/** Creates an organization from the web vault's New organization page and returns its id. */
async function createOrganization(owner: Page, name: string): Promise<string> {
  await owner.goto("/#/create-organization");
  // No license file and no plans: our own server.
  await expect(owner.getByText(/license file/i)).toHaveCount(0);
  await owner.getByRole("textbox", { name: /Organization name/ }).fill(name);
  // Upstream's kind of organization, with no preset.
  await owner.getByRole("radio", { name: /A family or a group/ }).check();
  await owner.getByRole("button", { name: "Create organization" }).click();
  await expect(toast(owner, `Created ${name}`)).toBeVisible();
  await owner.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  return /organizations\/([0-9a-f-]{36})/.exec(owner.url())![1];
}

/**
 * Opens an organization's Members page afresh. Going straight from one
 * organization's page to another's, or to the same one, keeps the page and
 * its organization as they were.
 */
async function openMembers(owner: Page, orgId: string) {
  await owner.goto("/#/vault");
  await expect(owner.getByRole("heading", { name: /vaults/i }).first()).toBeVisible();
  await owner.goto(`/#/organizations/${orgId}/members`);
  await expect(owner.getByRole("button", { name: "Invite member" })).toBeVisible();
}

async function invite(owner: Page, orgId: string, email: string) {
  await openMembers(owner, orgId);
  await owner.getByRole("button", { name: "Invite member" }).click();
  const dialog = owner.getByRole("dialog", { name: /Invite member/ });
  await dialog.getByRole("textbox", { name: /Email/ }).fill(email);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
}

/** A member's row on the Members page, after a reload so it's current. */
async function memberRow(owner: Page, orgId: string, email: string) {
  await openMembers(owner, orgId);
  return owner.getByRole("row").filter({ hasText: email });
}

test("someone invited gets in without anyone confirming them, unless the organization asks for approval", async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  const index = testInfo.repeatEachIndex;
  // The two people, signed up first so their invitations are accepted at once.
  const people: { user: WebUser; page: Page }[] = [];
  for (const prefix of ["joiner-auto", "joiner-approval"]) {
    const user = webUserFor(prefix, index);
    const page = await (await browser.newContext()).newPage();
    await signUp(page, user);
    people.push({ user, page });
  }
  const [auto, approval] = people;

  const ownerUser = webUserFor("joining-owner", index);
  const owner = await (await browser.newContext()).newPage();
  await signUp(owner, ownerUser);
  const autoOrg = await createOrganization(owner, "Corner Bakery");
  const approvalOrg = await createOrganization(owner, "Harbor Clinic");

  // Harbor Clinic asks for approval, on its Settings page.
  await owner.goto(`/#/organizations/${approvalOrg}/settings/account`);
  const joining = owner.getByTestId("org-joining");
  await expect(joining.getByTestId("org-joining-source")).toHaveText("The default.");
  await joining.getByRole("checkbox", { name: "Let people in when they accept an invitation" }).uncheck();
  await joining.getByRole("button", { name: "Save" }).click();
  await expect(toast(owner, "Saved how people join")).toBeVisible();
  await expect(joining.getByTestId("org-joining-source")).toContainText("This organization's own setting.");

  await invite(owner, autoOrg, auto.user.email);
  await invite(owner, approvalOrg, approval.user.email);

  // The owner's web vault lets Corner Bakery's new member in by itself: here
  // when the owner opens the Members page, otherwise within five minutes.
  await expect(async () => {
    const row = await memberRow(owner, autoOrg, auto.user.email);
    await expect(row).toBeVisible({ timeout: 5_000 });
    await expect(row.getByText("Needs confirmation")).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout: 60_000, intervals: [3_000] });

  // The same run left Harbor Clinic's for an owner or admin to approve.
  const waiting = await memberRow(owner, approvalOrg, approval.user.email);
  await expect(waiting.getByText("Needs confirmation")).toBeVisible();

  // The person who got in sees the organization.
  await auto.page.goto("/#/vault");
  await expect(auto.page.getByRole("button", { name: "Corner Bakery" }).first()).toBeVisible({ timeout: 30_000 });
});

test("an MSP's joining default reaches its clients, a client can have its own, and the console puts it back", async ({
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const admin = await (await browser.newContext()).newPage();
  await signUp(admin, webUserFor("joining-msp-admin", testInfo.repeatEachIndex));
  await admin.goto("/#/msp");
  await admin.getByRole("textbox", { name: "Your MSP's name" }).fill("Northwind IT");
  await admin.getByRole("button", { name: "Create MSP" }).click();
  await admin.getByRole("textbox", { name: "New client's name" }).fill("Acme Dental");
  await admin.getByRole("button", { name: "Add client" }).click();
  await expect(toast(admin, "Added Acme Dental")).toBeVisible();
  const client = admin.getByTestId("msp-client-Acme Dental");
  await client.getByRole("link", { name: "Open" }).click();
  await admin.waitForURL(/#\/organizations\/[0-9a-f-]{36}/);
  const clientId = /organizations\/([0-9a-f-]{36})/.exec(admin.url())![1];

  // The default, in the console: approval, and invitations for 2 hours.
  await admin.goto("/#/msp");
  const section = admin.getByTestId("msp-joining");
  const defaults = section.getByRole("form", { name: "Joining default" });
  await defaults.getByRole("checkbox", { name: "Let people in when they accept an invitation" }).uncheck();
  await defaults.getByRole("combobox", { name: "Invitations expire after" }).selectOption({ label: "2 hours" });
  await defaults.getByRole("button", { name: "Save default" }).click();
  await expect(toast(admin, "Saved the joining default")).toBeVisible();
  await expect(section).toContainText("An admin approves each one; invitations last 2 hours");

  // The client follows it.
  const settings = async () => {
    await admin.goto("/#/vault");
    await admin.goto(`/#/organizations/${clientId}/settings/account`);
    return admin.getByTestId("org-joining");
  };
  let card = await settings();
  await expect(card.getByTestId("org-joining-source")).toHaveText("Follows Northwind IT's default.");
  await expect(card.getByRole("checkbox", { name: "Let people in when they accept an invitation" })).not.toBeChecked();
  await expect(card.getByRole("combobox", { name: "Invitations expire after" })).toHaveValue(/2/);

  // Its own setting, there.
  await card.getByRole("checkbox", { name: "Let people in when they accept an invitation" }).check();
  await card.getByRole("button", { name: "Save" }).click();
  await expect(toast(admin, "Saved how people join")).toBeVisible();
  await expect(card.getByTestId("org-joining-source")).toContainText("This organization's own setting.");
  await expect(card.getByRole("button", { name: "Use Northwind IT's default" })).toBeVisible();

  // The console lists it, and puts it back on the default.
  await admin.goto("/#/msp");
  const own = section.getByTestId("msp-joining-Acme Dental");
  await expect(own).toContainText("Let in automatically; invitations last 2 hours");
  await own.getByRole("button", { name: "Use the default for Acme Dental" }).click();
  await expect(toast(admin, "Acme Dental uses the default")).toBeVisible();
  await expect(own).toHaveCount(0);
  card = await settings();
  await expect(card.getByTestId("org-joining-source")).toHaveText("Follows Northwind IT's default.");
});
