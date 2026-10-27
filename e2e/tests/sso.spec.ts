// Sign in with Microsoft Entra ID, in the web vault (DESIGN.md, "Sign in with
// Microsoft Entra ID"), against the local stand-in for Entra
// (e2e/entra-standin.mjs): an owner sets it up on the organization's Single
// sign-on page and verifies a domain; a member with an account links it from
// their own session (Link SSO in the organization's menu, their master
// password, Microsoft, and their confirmation), then types their email, is
// sent to the organization's sign-in, picks their Microsoft account, and
// unlocks with their master password; someone outside the organization is
// told why not; and with "Require single sign-on" on, a member's password
// sends them to it, a member not linked yet links first, and the owner's
// password still works. Real keys throughout.
import { expect, test, type Browser, type Page } from "@playwright/test";

import { port } from "../paths.mjs";

import { newDomain, newIdentifier, setTxt, Tenant } from "./support/entra";
import { signUp, type WebUser } from "./support/web";

const origin = `https://127.0.0.1:${port}`;
const password = "correct horse battery staple 42";

/** A toast message. Toasts here have no ARIA role, so find them by text. */
const toast = (page: Page, text: string | RegExp) => page.getByText(text, { exact: typeof text === "string" });

async function newPage(browser: Browser) {
  return (await browser.newContext()).newPage();
}

async function createBusiness(owner: Page, name: string): Promise<string> {
  await owner.goto("/#/create-organization");
  await owner.getByRole("textbox", { name: /Organization name/ }).fill(name);
  await owner.getByRole("radio", { name: /A business/ }).check();
  await owner.getByRole("button", { name: "Create organization" }).click();
  await expect(toast(owner, `Created ${name}`)).toBeVisible();
  await owner.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  return /organizations\/([0-9a-f-]{36})/.exec(owner.url())![1];
}

async function invite(owner: Page, orgId: string, email: string) {
  await owner.goto("/#/vault");
  await owner.goto(`/#/organizations/${orgId}/members`);
  await owner.getByRole("button", { name: "Invite member" }).click();
  const dialog = owner.getByRole("dialog", { name: /Invite member/ });
  await dialog.getByRole("textbox", { name: /Email/ }).fill(email);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
}

/** The organization's Single sign-on page, opened from its Settings menu. */
async function openSso(owner: Page, orgId: string) {
  await owner.goto("/#/vault");
  await owner.goto(`/#/organizations/${orgId}/settings/policies`);
  await owner.getByRole("link", { name: "Single sign-on" }).click();
  await owner.waitForURL(/settings\/sso/);
  return owner.getByTestId("sso");
}

/** An owner's organization with single sign-on on and a verified domain, set up on the page. */
async function setUp(browser: Browser, index: number, name: string) {
  const domain = newDomain();
  const tenant = await new Tenant().register();
  const identifier = newIdentifier("web");
  const ownerUser: WebUser = { email: `owner-${index}@${domain}`, name: "Owner", password };
  const owner = await newPage(browser);
  await signUp(owner, ownerUser);
  const orgId = await createBusiness(owner, name);

  const sso = await openSso(owner, orgId);
  await expect(sso.getByTestId("sso-status")).toHaveText("Single sign-on is off.");
  await expect(sso.getByTestId("sso-callback-url")).toHaveText(`${origin}/identity/connect/oidc-signin`);
  await expect(sso.getByTestId("sso-steps")).toContainText("App registrations");
  const form = sso.getByRole("form", { name: "Single sign-on settings" });
  await form.getByRole("textbox", { name: "SSO identifier" }).fill(identifier);
  await form.getByRole("textbox", { name: "Directory (tenant) ID" }).fill(tenant.tenantId);
  await form.getByRole("textbox", { name: "Application (client) ID" }).fill(tenant.clientId);
  await form.getByLabel("Client secret value").fill(tenant.clientSecret);
  await form.getByRole("checkbox", { name: "Turn on single sign-on" }).check();
  await form.getByRole("button", { name: "Save" }).click();
  await expect(toast(owner, "Single sign-on is on")).toBeVisible();
  await expect(sso.getByTestId("sso-status")).toContainText("Single sign-on is on.");
  // The secret is never shown again; the field is empty and says it's saved.
  await expect(form.getByLabel("Client secret value")).toHaveValue("");
  await expect(sso.getByTestId("sso-secret-hint")).toContainText("Saved");
  await expect(sso.getByTestId("sso-sign-in-url")).toContainText(`${origin}/#/sso?identifier=${identifier}`);

  // The domain, proved with its TXT record.
  const domains = sso.getByRole("form", { name: "Add an email domain" });
  await domains.getByRole("textbox", { name: "Domain" }).fill(domain);
  await domains.getByRole("button", { name: "Add domain" }).click();
  const row = sso.getByTestId("sso-domains").getByRole("listitem").filter({ hasText: domain });
  await expect(row.getByText("Not verified")).toBeVisible();
  await row.getByRole("button", { name: "Verify" }).click();
  await expect(toast(owner, new RegExp(`The TXT record for ${domain.replaceAll(".", "\\.")} isn't there yet`))).toBeVisible();
  const txt = (await row.getByTestId("sso-domain-txt").textContent())!.trim();
  await setTxt(domain, [txt]);
  await row.getByRole("button", { name: "Verify" }).click();
  await expect(toast(owner, `Verified ${domain}`)).toBeVisible();
  await expect(row.getByText("Verified", { exact: true })).toBeVisible();
  return { owner, ownerUser, orgId, tenant, identifier, domain };
}

/**
 * An account with keys links itself to the organization's single sign-on
 * from its own signed-in session: Link SSO in the organization's menu, its
 * master password, Microsoft (the stand-in's account picker), and its
 * confirmation on the linking page, then back to the vault, which unlocks
 * with the master password. Its owner's web vault confirms it first.
 */
async function linkSso(owner: Page, orgId: string, orgName: string, user: WebUser, page: Page) {
  // The organization's menu shows when its entry in the side menu is hovered.
  const orgEntry = page.getByRole("navigation", { name: "Side navigation" }).getByText(orgName, { exact: true });
  const openOrgMenu = async () => {
    await orgEntry.hover();
    await page.getByRole("button", { name: "Toggle Organization Menu" }).click();
  };
  // The owner's web vault lets the new member in when the Members page opens.
  await owner.goto("/#/vault");
  await owner.goto(`/#/organizations/${orgId}/members`);
  await expect(owner.getByRole("row").filter({ hasText: user.email })).toBeVisible();
  await expect(async () => {
    await page.goto("/#/vault");
    await page.reload();
    if (page.url().includes("lock")) {
      await page.getByLabel(/Master password/).fill(user.password);
      await page.getByRole("button", { name: "Unlock", exact: true }).click();
    }
    await expect(orgEntry).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  await openOrgMenu();
  await page.getByRole("menuitem", { name: "Link SSO" }).click();
  const verify = page.getByRole("dialog");
  await verify.getByLabel(/Master password/).fill(user.password);
  await verify.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("link", { name: `Sign in as ${user.email}` }).click();
  // The linking page says which Microsoft account it is, and this session
  // confirms it.
  await page.waitForURL(/#\/sso-link\?code=/);
  await expect(page.getByTestId("sso-link-microsoft")).toContainText(user.email);
  await expect(page.getByTestId("sso-link-account")).toHaveText(user.email);
  await page.getByRole("button", { name: "Link accounts" }).click();
  // Back in the vault, which reloaded, so it's locked.
  await expect(page.getByRole("button", { name: "Unlock", exact: true })).toBeVisible();
  await page.getByLabel(/Master password/).fill(user.password);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(orgEntry).toBeVisible();
  // The organization's menu now offers Unlink SSO.
  await openOrgMenu();
  await expect(page.getByRole("menuitem", { name: "Unlink SSO" })).toBeVisible();
  await page.keyboard.press("Escape");
}

/** Types an email on the sign-in page and chooses single sign-on. */
async function startSso(page: Page, email: string) {
  await page.goto("/#/login");
  await page.getByLabel(/Email address/).fill(email);
  await page.getByRole("button", { name: "Use single sign-on" }).click();
}

test("an owner sets up single sign-on and a member signs in with it, then unlocks with their master password", async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  const index = testInfo.repeatEachIndex;
  const { owner, orgId, tenant, domain } = await setUp(browser, index, "Lakeside Dental");

  // A member, invited by email (this server sends no email, so they join at
  // once). Her account has keys, so she links it herself, signed in.
  const ana: WebUser = { email: `ana-${index}@${domain}`, name: "Ana", password };
  const anaVault = await newPage(browser);
  await signUp(anaVault, ana);
  await invite(owner, orgId, ana.email);
  await tenant.person(ana.email, undefined, "Ana Lima");
  await linkSso(owner, orgId, "Lakeside Dental", ana, anaVault);
  await anaVault.context().close();

  // In a fresh browser: their email's domain finds the organization's sign-in,
  // they pick their Microsoft account, and their master password unlocks.
  const page = await newPage(browser);
  await startSso(page, ana.email);
  await page.getByRole("link", { name: `Sign in as ${ana.email}` }).click();
  await page.waitForURL(/#\/lock/);
  await page.getByLabel(/Master password/).fill(ana.password);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.waitForURL(/#\/vault/);
  await expect(page).toHaveTitle(/^Items/);

  // The owner sees the link on the page and the sign-in in the event log.
  const sso = await openSso(owner, orgId);
  await expect(sso.getByTestId("sso-links")).toContainText(ana.email);
  await owner.goto(`/#/organizations/${orgId}/reporting/events`);
  await expect(owner.getByText(/signed in with single sign-on\./).first()).toBeVisible({ timeout: 30_000 });
  await expect(owner.getByText(/linked their Microsoft account and signed in with single sign-on for the first time/).first()).toBeVisible();
});

test("someone outside the organization is told why single sign-on can't sign them in", async ({ browser }, testInfo) => {
  test.setTimeout(150_000);
  const index = testInfo.repeatEachIndex;
  const { tenant, identifier, domain } = await setUp(browser, index, "Harbor Clinic");

  // An account at the domain that belongs to another organization.
  const bob: WebUser = { email: `bob-${index}@${domain}`, name: "Bob", password };
  const bobPage = await newPage(browser);
  await signUp(bobPage, bob);
  await createBusiness(bobPage, "Bob's Bikes");
  await bobPage.context().close();
  await tenant.person(bob.email);

  const page = await newPage(browser);
  await page.goto(`/#/sso?identifier=${identifier}`);
  await page.getByRole("link", { name: `Sign in as ${bob.email}` }).click();
  await expect(page.getByText(new RegExp(`${bob.email.replaceAll(".", "\\.")} isn't a member of Harbor Clinic`))).toBeVisible();
  // The sign-in page stays, with the identifier, for another try.
  await expect(page.getByRole("textbox", { name: "SSO identifier" })).toHaveValue(identifier);
});

/** Signs in with an email and master password on the sign-in page. */
async function passwordSignIn(page: Page, user: WebUser) {
  await page.goto("/#/login");
  await page.getByLabel(/Email address/).fill(user.email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("textbox", { name: /Master password/ }).fill(user.password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
}

test("with Require single sign-on, a member's password sends them to it, one not linked yet links first, and the owner still signs in with theirs", async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const index = testInfo.repeatEachIndex;
  const { owner, ownerUser, orgId, tenant, domain } = await setUp(browser, index, "Pine Street Law");
  const cy: WebUser = { email: `cy-${index}@${domain}`, name: "Cy", password };
  const cyVault = await newPage(browser);
  await signUp(cyVault, cy);
  await invite(owner, orgId, cy.email);
  await tenant.person(cy.email);
  await linkSso(owner, orgId, "Pine Street Law", cy, cyVault);
  await cyVault.context().close();
  // Dee joins too, and doesn't link.
  const dee: WebUser = { email: `dee-${index}@${domain}`, name: "Dee", password };
  const deeVault = await newPage(browser);
  await signUp(deeVault, dee);
  await invite(owner, orgId, dee.email);
  await tenant.person(dee.email, undefined, "Dee Park");
  await owner.goto("/#/vault");
  await owner.goto(`/#/organizations/${orgId}/members`);
  await expect(owner.getByRole("row").filter({ hasText: dee.email })).toBeVisible();
  await deeVault.context().close();

  // The policy, turned on from the Policies page (the Business preset has
  // Single organization on). The dialog says who isn't linked yet.
  await owner.goto("/#/vault");
  await owner.goto(`/#/organizations/${orgId}/settings/policies`);
  await owner.getByRole("button", { name: /^Require single sign-on/ }).click();
  const dialog = owner.getByRole("dialog");
  await expect(dialog).toContainText("IT provider's staff");
  await expect(dialog.getByTestId("require-sso-unlinked")).toContainText(dee.email);
  await expect(dialog.getByTestId("require-sso-unlinked")).not.toContainText(cy.email);
  await dialog.getByRole("checkbox", { name: /Turn on/ }).check();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(owner.getByRole("button", { name: /^Require single sign-on .* On$/ })).toBeVisible();

  // Cy's password checks out, then sends them to single sign-on.
  const page = await newPage(browser);
  await passwordSignIn(page, cy);
  await page.getByRole("link", { name: `Sign in as ${cy.email}` }).click();
  await page.waitForURL(/#\/lock/);
  await page.getByLabel(/Master password/).fill(cy.password);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.waitForURL(/#\/vault/);

  // Dee isn't linked: her password takes her to linking first, then
  // Microsoft signs her in, and her master password unlocks.
  const deePage = await newPage(browser);
  await passwordSignIn(deePage, dee);
  await deePage.waitForURL(/#\/sso-link/);
  await deePage.getByRole("button", { name: "Continue with Microsoft" }).click();
  await deePage.getByRole("link", { name: `Sign in as ${dee.email}` }).click();
  await deePage.waitForURL(/#\/sso-link\?code=/);
  await expect(deePage.getByTestId("sso-link-microsoft")).toContainText("Dee Park");
  await deePage.getByRole("button", { name: "Link accounts" }).click();
  await deePage.getByRole("link", { name: `Sign in as ${dee.email}` }).click();
  await deePage.waitForURL(/#\/lock/);
  await deePage.getByLabel(/Master password/).fill(dee.password);
  await deePage.getByRole("button", { name: "Unlock", exact: true }).click();
  await deePage.waitForURL(/#\/vault/);
  const sso = await openSso(owner, orgId);
  await expect(sso.getByTestId("sso-links")).toContainText(dee.email);

  // The owner is never locked out.
  const ownerAgain = await newPage(browser);
  await ownerAgain.goto("/#/login");
  await ownerAgain.getByLabel(/Email address/).fill(ownerUser.email);
  await ownerAgain.getByRole("button", { name: "Continue" }).click();
  await ownerAgain.getByRole("textbox", { name: /Master password/ }).fill(ownerUser.password);
  await ownerAgain.getByRole("button", { name: "Log in", exact: true }).click();
  await ownerAgain.waitForURL(/#\/vault/);
  await expect(ownerAgain).toHaveTitle(/^Items/);
});
