// The MSP console's trust pieces, in the web vault (DESIGN.md, "Key
// fingerprints", "The client sees its MSP's actions"): a client's own owner
// sees, under the MSP on their Members page, that the MSP added someone to
// their organization; and the console's Staff list shows each person's
// fingerprint phrase, the same one their own account settings show. All
// accounts are real, made through the UI, since the phrases come from real
// keys.
import { expect, test, type Page } from "@playwright/test";

import { acceptRole, chooseRole, reloadVault, signUpWithAuthenticator, webUserFor } from "./support/web";

/** A toast message. Toasts here have no ARIA role, so find them by text. */
const toast = (page: Page, text: string) => page.getByText(text, { exact: true });

/** Someone's own fingerprint phrase, as their Settings, My account shows it. */
async function ownPhrase(page: Page): Promise<string> {
  await page.goto("/#/settings/account");
  const phrase = page.locator("app-account-fingerprint code");
  await expect(phrase).toHaveText(/^[a-z]+(-[a-z]+){4}$/);
  return (await phrase.textContent())!.trim();
}

async function createMsp(page: Page, name: string) {
  await page.goto("/#/msp");
  await page.getByRole("textbox", { name: "Your MSP's name" }).fill(name);
  await page.getByRole("button", { name: "Create MSP" }).click();
  await expect(page.getByTestId("msp-name")).toContainText(name);
}

/** Invites someone to the MSP's staff from the console, and they join from the link. */
async function addStaff(admin: Page, person: Page, email: string, mspName: string) {
  await admin.getByRole("textbox", { name: "Email of someone to add" }).fill(email);
  await admin.getByRole("button", { name: "Add staff" }).click();
  await expect(toast(admin, `Invited ${email}`)).toBeVisible();
  const link = await admin.getByTestId("msp-invite-link").locator("pre").textContent();
  // From elsewhere in the web vault, as a link from the email opens it: the
  // console already open doesn't read a new invitation from its address.
  await person.goto("/#/vault");
  await person.goto(link!.slice(link!.indexOf("/#/")));
  await person.getByTestId("msp-invitation").getByRole("button", { name: `Join ${mspName}` }).click();
  await expect(toast(person, `You joined ${mspName}`)).toBeVisible();
}

test("a client's owner sees that the MSP added someone to their organization, and the Staff list shows that person's own fingerprint phrase", async ({
  browser,
}, testInfo) => {
  // Several accounts end to end; CI machines are slower.
  test.setTimeout(180_000);
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const ownerUser = webUserFor("trust-owner", testInfo.repeatEachIndex);
  await signUpWithAuthenticator(owner, ownerUser);
  const techContext = await browser.newContext();
  const tech = await techContext.newPage();
  const techUser = webUserFor("trust-tech", testInfo.repeatEachIndex);
  await signUpWithAuthenticator(tech, techUser);
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const adminUser = webUserFor("trust-admin", testInfo.repeatEachIndex);
  await signUpWithAuthenticator(admin, adminUser);

  // An MSP with one client, whose own owner the MSP adds.
  await createMsp(admin, "Woodgrove IT");
  await admin.getByRole("textbox", { name: "New client's name" }).fill("Alpine Dental");
  await admin.getByRole("button", { name: "Add client" }).click();
  await expect(toast(admin, "Added Alpine Dental")).toBeVisible();
  await admin.getByTestId("msp-client-Alpine Dental").getByRole("link", { name: "Admin console" }).click();
  await expect(admin).toHaveURL(/#\/organizations\/[^/]+\/members/);
  const membersUrl = admin.url();
  await admin.getByRole("button", { name: "Invite member" }).click();
  const invite = admin.getByRole("dialog", { name: /Invite member/ });
  await invite.getByRole("textbox", { name: /Email/ }).fill(ownerUser.email);
  await chooseRole(invite, "Owner");
  await invite.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(invite).toBeHidden();
  await acceptRole(owner);
  await admin.goto("/#/msp");
  await expect(toast(admin, "Confirmed 1 member")).toBeVisible();

  // The MSP adds a technician, and the console lets them in on its own,
  // which its Activity says.
  await addStaff(admin, tech, techUser.email, "Woodgrove IT");
  await admin.goto("/#/vault");
  await admin.goto("/#/msp");
  await expect(admin.getByTestId("msp-activity")).toContainText(
    `${adminUser.email} confirmed ${techUser.email} in Alpine Dental automatically, without comparing fingerprints`,
  );

  // The client's own owner sees it on their Members page, under the MSP.
  await reloadVault(owner);
  await owner.goto(membersUrl);
  const seen = owner.getByTestId("client-msp").getByTestId("client-msp-activity");
  await expect(seen).toContainText("What Woodgrove IT did here");
  await expect(seen).toContainText(
    `${adminUser.email} added ${techUser.email} to your organization as an admin`,
  );
  await expect(seen).toContainText(
    `${adminUser.email} confirmed ${techUser.email} in your organization automatically, without comparing fingerprints`,
  );
  await expect(seen).toContainText(`${adminUser.email} set up your organization as a client of Woodgrove IT`);
  // Nothing of the MSP's own that isn't about this organization.
  await expect(seen).not.toContainText("invited");

  // The MSP's own people see the banner without it.
  await admin.goto(membersUrl);
  await expect(admin.getByTestId("client-msp")).toContainText("Woodgrove IT manages this organization");
  await expect(admin.getByTestId("client-msp-activity")).toHaveCount(0);

  // The Staff list shows the technician's phrase, the same words their own
  // account settings show, with what to do with it.
  await admin.goto("/#/msp");
  const techRow = admin.getByTestId(`msp-staff-${techUser.email}`);
  await expect(techRow.getByTestId("msp-staff-phrase")).toHaveText(await ownPhrase(tech));
  await expect(techRow.getByTestId("msp-staff-compare")).toHaveText(
    `Ask ${techUser.name} to read the phrase in Settings, My account. If it's different, remove them and tell us.`,
  );
  // And the admin's own, on their own row.
  const adminPhrase = await ownPhrase(admin);
  await admin.goto("/#/msp");
  const adminRow = admin.getByTestId(`msp-staff-${adminUser.email}`);
  await expect(adminRow.getByTestId("msp-staff-phrase")).toHaveText(adminPhrase);
  await expect(adminRow.getByTestId("msp-staff-compare")).toHaveText(
    "Yours. Your Settings, My account shows the same phrase. If it's different, tell us.",
  );

  await ownerContext.close();
  await techContext.close();
  await adminContext.close();
});
