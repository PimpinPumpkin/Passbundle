// The MSP console's trust pieces and its choice of MSP, in the web vault
// (DESIGN.md, "Key fingerprints", "The client sees its MSP's actions",
// "Several MSPs"): a client's own owner sees, under the MSP on their Members
// page, that the MSP added someone to their organization; the console's Staff
// list shows each person's fingerprint phrase, the same one their own account
// settings show; and someone on two MSPs' staff picks which one the console
// shows, which the browser remembers. All accounts are real, made through
// the UI, since the phrases come from real keys.
import { expect, test, type Page } from "@playwright/test";

import { fingerprintPhrase } from "./support/fingerprint";
import {
  acceptRole,
  automaticConfirm,
  automaticConfirmers,
  chooseRole,
  reloadVault,
  signUpWithAuthenticator,
  webUserFor,
} from "./support/web";

/** A toast message. Toasts here have no ARIA role, so find them by text. */
const toast = (page: Page, text: string) => page.getByText(text, { exact: true });

/** Someone's own fingerprint phrase, as their Settings, My account shows it. */
async function ownPhrase(page: Page): Promise<string> {
  await page.goto("/#/settings/account");
  const phrase = page.locator("app-account-fingerprint code");
  await expect(phrase).toHaveText(fingerprintPhrase);
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
  // Opened where the person already is, which for someone on another MSP's
  // staff is the console: it shows the invitation without a reload.
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

  // The MSP adds a technician, and they're let in on their own, which its
  // Activity says: by the console as it opens, or by the client's own
  // owner's web vault if its background work gets there first (DESIGN.md,
  // "Joining"). Either is right, so this doesn't pick one.
  await addStaff(admin, tech, techUser.email, "Woodgrove IT");
  await admin.goto("/#/vault");
  await admin.goto("/#/msp");
  const confirmers = await automaticConfirmers(admin, techUser.email, "Alpine Dental", [
    adminUser.email,
    ownerUser.email,
  ]);

  // The client's own owner sees it on their Members page, under the MSP.
  await reloadVault(owner);
  await owner.goto(membersUrl);
  const seen = owner.getByTestId("client-msp").getByTestId("client-msp-activity");
  await expect(seen).toContainText("What Woodgrove IT did here");
  await expect(seen).toContainText(
    `${adminUser.email} added ${techUser.email} to your organization as an admin`,
  );
  for (const who of confirmers) {
    await expect(seen).toContainText(automaticConfirm(who, techUser.email, "your organization"));
  }
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
    `Ask ${techUser.name} to read the phrase in Settings, My account. If it's different, remove them from your staff: the key this server gave out for them isn't theirs.`,
  );
  // And the admin's own, on their own row.
  const adminPhrase = await ownPhrase(admin);
  await admin.goto("/#/msp");
  const adminRow = admin.getByTestId(`msp-staff-${adminUser.email}`);
  await expect(adminRow.getByTestId("msp-staff-phrase")).toHaveText(adminPhrase);
  await expect(adminRow.getByTestId("msp-staff-compare")).toHaveText(
    "Yours. Your Settings, My account shows the same phrase. If it's different, the key this server gives out for you isn't yours: tell your MSP's other admins.",
  );

  await ownerContext.close();
  await techContext.close();
  await adminContext.close();
});

test("someone on two MSPs' staff picks which one the console shows, and the browser remembers it", async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  const danaContext = await browser.newContext();
  const dana = await danaContext.newPage();
  await signUpWithAuthenticator(dana, webUserFor("two-msps-dana", testInfo.repeatEachIndex));
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await signUpWithAuthenticator(other, webUserFor("two-msps-other", testInfo.repeatEachIndex));
  const danaEmail = webUserFor("two-msps-dana", testInfo.repeatEachIndex).email;

  // Dana runs Northwind IT. With one MSP there's nothing to choose.
  await createMsp(dana, "Northwind IT");
  await expect(dana.getByTestId("msp-choice")).toHaveCount(0);

  // Contoso IT makes her a technician; the console shows the MSP she joined.
  await createMsp(other, "Contoso IT");
  await addStaff(other, dana, danaEmail, "Contoso IT");
  const name = dana.getByTestId("msp-name");
  await expect(name).toContainText("Contoso IT");
  await expect(name).toContainText("Technician");
  const choice = dana.getByRole("combobox", { name: "MSP", exact: true });
  await expect(choice.locator("option")).toHaveText(["Northwind IT (Admin)", "Contoso IT (Technician)"]);

  // She picks Northwind IT: everything on the page is its own.
  await choice.selectOption({ label: "Northwind IT (Admin)" });
  await expect(name).toContainText("Northwind IT");
  await expect(name).toContainText("Admin");
  await expect(dana.getByRole("button", { name: "Add client" })).toBeVisible();

  // The browser remembers it, and the other choice too.
  await reloadVault(dana);
  await expect(name).toContainText("Northwind IT");
  await choice.selectOption({ label: "Contoso IT (Technician)" });
  await expect(name).toContainText("Contoso IT");
  await expect(dana.getByRole("button", { name: "Add client" })).toHaveCount(0);
  await reloadVault(dana);
  await expect(name).toContainText("Contoso IT");

  await danaContext.close();
  await otherContext.close();
});
