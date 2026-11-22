// An organization that already uses PassBundle joins an MSP with a code the
// MSP gives its owner, in the web vault (DESIGN.md, "An organization that
// already uses PassBundle"): the MSP's admin makes a code in the console; the
// organization's owner enters it on its Members page, reads what it means,
// joins, and confirms the MSP's admin with the fingerprint phrase shown,
// which is the one the admin's own account settings show; nothing confirms
// anyone on its own before that; and the MSP's console then lists the client.
// Once its admin confirms the client by name, the rest of its staff are let
// in as in any client, by whichever owner's device gets there first (the
// admin's console or the owner's own web vault), and both sides' Activity
// name that person. All accounts are real, made through the UI, since the
// phrases come from real keys.
import { expect, test, type Page } from "@playwright/test";

import { fingerprintPhrase } from "./support/fingerprint";
import {
  automaticConfirm,
  automaticConfirmers,
  reloadVault,
  signUpWithAuthenticator,
  webUserFor,
} from "./support/web";

/** A toast message. Toasts here have no ARIA role, so find them by text. */
const toast = (page: Page, text: string | RegExp) => page.getByText(text, { exact: typeof text === "string" });

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

/** Creates an organization from the web vault's New organization page, landing on its Members page. */
async function createOrganization(owner: Page, name: string): Promise<string> {
  await owner.goto("/#/create-organization");
  await owner.getByRole("textbox", { name: /Organization name/ }).fill(name);
  await owner.getByRole("button", { name: "Create organization" }).click();
  await expect(toast(owner, `Created ${name}`)).toBeVisible();
  await owner.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  return /organizations\/([0-9a-f-]{36})/.exec(owner.url())![1];
}

/** Invites someone to the MSP's staff from the console, and they join from the link. */
async function addStaff(admin: Page, person: Page, email: string, mspName: string) {
  await admin.getByRole("textbox", { name: "Email of someone to add" }).fill(email);
  await admin.getByRole("button", { name: "Add staff" }).click();
  await expect(toast(admin, `Invited ${email}`)).toBeVisible();
  const link = await admin.getByTestId("msp-invite-link").locator("pre").textContent();
  await person.goto(link!.slice(link!.indexOf("/#/")));
  await person.getByTestId("msp-invitation").getByRole("button", { name: `Join ${mspName}` }).click();
  await expect(toast(person, `You joined ${mspName}`)).toBeVisible();
}

/** A member's row on the Members page, by email. */
const memberRow = (page: Page, email: string) => page.getByRole("row").filter({ hasText: email });

test("the owner of an organization that already uses PassBundle joins it to an MSP with a code and confirms the MSP's admin with the phrase shown, and the console then lists the client", async ({
  browser,
}, testInfo) => {
  // Several accounts end to end; CI machines are slower.
  test.setTimeout(240_000);
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const adminUser = webUserFor("link-admin", testInfo.repeatEachIndex);
  await signUpWithAuthenticator(admin, adminUser);
  const techContext = await browser.newContext();
  const tech = await techContext.newPage();
  const techUser = webUserFor("link-tech", testInfo.repeatEachIndex);
  await signUpWithAuthenticator(tech, techUser);
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const ownerUser = webUserFor("link-owner", testInfo.repeatEachIndex);
  await signUpWithAuthenticator(owner, ownerUser);

  // An MSP with a technician, and a code its admin makes for Alpine Dental.
  await createMsp(admin, "Woodgrove IT");
  await addStaff(admin, tech, techUser.email, "Woodgrove IT");
  const codes = admin.getByTestId("msp-link-codes");
  await expect(codes).toContainText("Bring in an organization that already uses PassBundle");
  await codes.getByRole("textbox", { name: /Who it's for/ }).fill("Alpine Dental");
  await codes.getByRole("button", { name: "Make a code" }).click();
  const shown = codes.getByTestId("msp-link-code");
  await expect(shown).toHaveText(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/);
  const code = (await shown.textContent())!.trim();
  await expect(codes.getByTestId("msp-link-code-open")).toContainText("Alpine Dental");

  // Alpine Dental already uses PassBundle: its owner made it.
  await createOrganization(owner, "Alpine Dental");
  const membersUrl = owner.url();
  await owner.getByTestId("client-msp-join-open").click();
  await owner.getByRole("textbox", { name: "Code from your MSP" }).fill(code.toLowerCase());
  await owner.getByRole("button", { name: "Check code" }).click();

  // What joining means, before anything changes.
  const join = owner.getByTestId("client-msp-join");
  await expect(join.getByTestId("client-msp-join-msp")).toHaveText("Join Woodgrove IT?");
  const adding = join.getByTestId("client-msp-join-adding");
  await expect(adding).toContainText(`${adminUser.name} (${adminUser.email}), as an owner`);
  await expect(adding).toContainText(`${techUser.name} (${techUser.email}), as an admin`);
  await expect(join).toContainText(
    "None of them can open its items until an owner here confirms each of them on this page, after comparing their fingerprint phrase with what they read you.",
  );
  await expect(join).toContainText("Alpine Dental keeps its members, items, collections, policies, and plan.");
  await expect(join).toContainText("You can remove Woodgrove IT at any time, on this page.");
  await join.getByRole("button", { name: "Join Woodgrove IT" }).click();
  await expect(toast(owner, /Woodgrove IT now manages Alpine Dental\./)).toBeVisible();

  // The MSP's people wait, each with their phrase and what to compare. The
  // owner's own web vault doesn't let them in on its own, page open or not.
  const banner = owner.getByTestId("client-msp");
  await expect(banner).toContainText("Woodgrove IT manages this organization");
  await reloadVault(owner);
  await owner.goto(membersUrl);
  await expect(memberRow(owner, adminUser.email).getByText("Needs confirmation")).toBeVisible();
  await expect(memberRow(owner, techUser.email).getByText("Needs confirmation")).toBeVisible();
  const waiting = banner.getByTestId(`client-msp-waiting-${adminUser.email}`);
  const phrase = waiting.getByTestId("client-msp-waiting-phrase");
  await expect(phrase).toHaveText(fingerprintPhrase);
  await expect(waiting.getByTestId("client-msp-waiting-compare")).toHaveText(
    `Ask ${adminUser.name} to read the phrase in Settings, My account, and confirm them only if it's the same: otherwise the key this server gave out for them isn't theirs.`,
  );
  // The admin reads theirs: the same words.
  const shownPhrase = (await phrase.textContent())!.trim();
  expect(await ownPhrase(admin)).toBe(shownPhrase);

  // The owner confirms the admin, and only the admin.
  await waiting.getByRole("button", { name: `Confirm ${adminUser.email}` }).click();
  await expect(toast(owner, `Confirmed ${adminUser.email}`)).toBeVisible();
  await expect(banner.getByTestId(`client-msp-waiting-${adminUser.email}`)).toHaveCount(0);
  await expect(memberRow(owner, adminUser.email).getByText("Needs confirmation")).toHaveCount(0);
  await expect(memberRow(owner, techUser.email).getByText("Needs confirmation")).toBeVisible();

  // The MSP's console lists the client, joined with a code; the code is used up.
  await admin.goto("/#/vault");
  await reloadVault(admin);
  await admin.goto("/#/msp");
  const row = admin.getByTestId("msp-client-Alpine Dental");
  await expect(row).toBeVisible();
  await expect(admin.getByTestId("msp-link-joined-Alpine Dental")).toContainText(
    "you're confirmed there. Use Confirm client on its row.",
  );
  await expect(admin.getByTestId("msp-link-code-open")).toHaveCount(0);

  // The admin confirms the client by name; from then on the rest of the
  // staff are let in as in any client (DESIGN.md, "Joining"), by the
  // background work of whichever owner's device gets there first: the
  // admin's console, or the owner's web vault, still open on the Members
  // page. Either is right, so this doesn't pick one.
  await row.getByTestId("msp-client-confirm").click();
  await admin.getByRole("dialog").getByRole("button", { name: "Confirm client" }).click();
  await expect(toast(admin, "Confirmed Alpine Dental")).toBeVisible();
  await expect(admin.getByTestId("msp-link-joined-Alpine Dental")).toContainText(
    "your staff get in as in any client.",
  );
  // Opening the console lets in anyone still waiting before it lists its Activity.
  await admin.goto("/#/vault");
  await admin.goto("/#/msp");
  // The owner confirmed the admin by hand, after comparing.
  const adminConfirmed = admin
    .getByTestId("msp-activity")
    .locator("li")
    .filter({ hasText: `confirmed ${adminUser.email} in Alpine Dental` });
  await expect(adminConfirmed.locator("div").first()).toHaveText(
    `${ownerUser.email} confirmed ${adminUser.email} in Alpine Dental`,
  );
  // The technician was let in automatically, without comparing, by the admin
  // or the owner: whoever it was is named.
  const confirmers = await automaticConfirmers(admin, techUser.email, "Alpine Dental", [
    adminUser.email,
    ownerUser.email,
  ]);
  // The owner sees the same under the MSP on their Members page, and the
  // technician no longer waits.
  await owner.goto("/#/vault");
  await owner.goto(membersUrl);
  await expect(memberRow(owner, techUser.email).getByText("Needs confirmation")).toHaveCount(0);
  const seen = banner.getByTestId("client-msp-activity");
  for (const who of confirmers) {
    await expect(seen).toContainText(automaticConfirm(who, techUser.email, "your organization"));
  }

  await adminContext.close();
  await techContext.close();
  await ownerContext.close();
});
