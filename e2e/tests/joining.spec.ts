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

/** Creates an organization in the web vault and returns its id. */
async function createOrganization(owner: Page, user: WebUser, name: string): Promise<string> {
  await owner.goto("/#/create-organization");
  await owner.getByRole("textbox", { name: /Organization name/ }).fill(name);
  await owner.getByRole("textbox", { name: /Billing email/ }).fill(user.email);
  await owner.getByRole("button", { name: "Submit" }).click();
  await owner.waitForURL(/#\/organizations\/[0-9a-f-]{36}/);
  return /organizations\/([0-9a-f-]{36})/.exec(owner.url())![1];
}

async function invite(owner: Page, orgId: string, email: string) {
  await owner.goto(`/#/organizations/${orgId}/members`);
  await owner.getByRole("button", { name: "Invite member" }).click();
  const dialog = owner.getByRole("dialog", { name: /Invite member/ });
  await dialog.getByRole("textbox", { name: /Email/ }).fill(email);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
}

/** A member's row on the Members page, after a reload so it's current. */
async function memberRow(owner: Page, orgId: string, email: string) {
  await owner.goto(`/#/organizations/${orgId}/members`);
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
  const autoOrg = await createOrganization(owner, ownerUser, "Corner Bakery");
  const approvalOrg = await createOrganization(owner, ownerUser, "Harbor Clinic");

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

  // The owner's web vault confirms Corner Bakery's new member in the
  // background (here when it loads; otherwise within five minutes).
  await owner.goto("/#/vault");
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
