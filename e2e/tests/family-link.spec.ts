// A family's invite link in the web vault (DESIGN.md, "A family's invite
// link"): the owner makes a family and turns the link on; a second account
// opens the link, joins, and the owner lets them in with one tap on the
// Members page, after its fingerprint phrase matches the one the joiner sees;
// with automatic on, a third joins and the owner's web vault lets them in with
// no click, and the owner sees who joined. The sheet to print shows the QR
// code and nothing that unlocks a vault, and the suggestion to add a legacy
// contact shows until No thanks.
//
// A family is an organization whose plan is Families, which the operator sets
// on the admin page, so this starts a server of its own that enforces plans.
import { type Browser, expect, type Page, test } from "@playwright/test";

import { brand, familyLinkUiServerPort } from "../paths.mjs";

import { DAY, fromNow, type PlansServer, startPlansServer } from "./support/plans";
import { reloadVault, signUp, webUserFor, type WebUser } from "./support/web";

test.describe.configure({ mode: "serial" });

let server: PlansServer;

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(150_000);
  server = await startPlansServer(playwright, familyLinkUiServerPort, true);
});

test.afterAll(async () => {
  await server?.stop();
});

const FAMILY = "Rivera family";

/** A new account in a browser of its own, signed in and in its vault. */
async function person(browser: Browser, prefix: string, repeat: number) {
  const user: WebUser = { ...webUserFor(prefix, repeat), email: `${prefix}-${repeat}-${Date.now()}@example.test` };
  const context = await browser.newContext({ baseURL: server.url, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await signUp(page, user);
  return { user, context, page };
}

/** New organization, for a family or a group; its id. */
async function createFamily(page: Page, name: string): Promise<string> {
  await page.goto("/#/create-organization");
  await page.getByRole("textbox", { name: /Organization name/ }).fill(name);
  await page.getByRole("radio", { name: /A family or a group/ }).check();
  await page.getByRole("button", { name: "Create organization" }).click();
  await page.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  return /organizations\/([0-9a-f-]{36})/.exec(page.url())![1];
}

/** Opens the invite link and joins; the fingerprint phrase the page shows. */
async function joinWithLink(page: Page, link: string): Promise<string> {
  await page.goto(link);
  await expect(page.getByTestId("family-join-invited")).toHaveText(`family-owner invited you to join ${FAMILY}.`);
  await page.getByTestId("family-join-button").click();
  const phrase = page.getByTestId("family-join-phrase");
  await expect(phrase).toHaveText(/^[a-z]+(-[a-z]+){4}$/);
  return (await phrase.textContent())!;
}

test("a family's owner shares the link: one person gets in with one tap, the next automatically, and the owner sees who joined", async ({
  browser,
}, testInfo) => {
  test.setTimeout(420_000);
  const repeat = testInfo.repeatEachIndex;
  const owner = await person(browser, "family-owner", repeat);
  const orgId = await createFamily(owner.page, FAMILY);
  await server.operator.setPlan("organizations", orgId, {
    plan: "families",
    standing: "until",
    until: fromNow(365 * DAY),
    renews: true,
  });

  // The link's card, on Joining and security: one tap unless the owner
  // chooses otherwise, and one sentence on what automatic means.
  await owner.page.goto(`/#/organizations/${orgId}/settings/joining`);
  const card = owner.page.getByTestId("family-link");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole("radio", { name: /one tap/ })).toBeChecked();
  await expect(card.getByTestId("family-link-automatic")).toContainText("Anyone who has the link gets in without you.");
  await card.getByTestId("family-link-make").click();
  await expect(card.getByTestId("family-link-qr")).toBeVisible();
  const link = await card.getByTestId("family-link-address").inputValue();
  expect(link).toMatch(
    new RegExp(`^${server.url.replace(/[.]/g, "\\.")}/#/family-join\\?o=${orgId}&t=[A-Za-z0-9_-]{43}&s=[A-Za-z0-9_-]{43}$`),
  );
  await expect(card.getByTestId("family-link-ends")).toContainText("Works until");

  // Someone who isn't signed in learns the family's name and who invited
  // them, and is asked to sign in or create an account.
  const stranger = await browser.newContext({ baseURL: server.url, ignoreHTTPSErrors: true });
  const strangerPage = await stranger.newPage();
  await strangerPage.goto(link);
  await expect(strangerPage.getByTestId("family-join-invited")).toHaveText(`family-owner invited you to join ${FAMILY}.`);
  await expect(strangerPage.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(strangerPage.getByRole("link", { name: "Create account" })).toBeVisible();
  // A link with a wrong token, opened as a link is, in a page of its own:
  // the one answer, and no family's name.
  const wrongPage = await stranger.newPage();
  await wrongPage.goto(link.replace(/t=[A-Za-z0-9_-]{43}/, `t=${"B".repeat(43)}`));
  await expect(wrongPage.getByTestId("family-join-bad")).toHaveText(
    "This invite link doesn't work. Ask whoever sent it for a new one.",
  );
  await expect(wrongPage.getByText(FAMILY)).toHaveCount(0);
  await stranger.close();

  // Ben joins, and waits for a tap.
  const ben = await person(browser, "family-ben", repeat);
  const benPhrase = await joinWithLink(ben.page, link);
  await expect(ben.page.getByTestId("family-join-done")).toContainText("An owner or admin lets you in.");

  // The owner's Members page lists him with the same phrase, and Confirm.
  await owner.page.goto(`/#/organizations/${orgId}/members`);
  const waitingBen = owner.page.getByTestId("family-waiting").locator(`[data-email="${ben.user.email}"]`);
  await expect(waitingBen.getByTestId("family-waiting-phrase")).toHaveText(benPhrase);
  await waitingBen.getByTestId("family-waiting-confirm").click();
  await expect(owner.page.getByText(`${ben.user.email} is in ${FAMILY}`)).toBeVisible();
  await expect(waitingBen).toHaveCount(0);
  const benRow = owner.page.getByRole("row").filter({ hasText: ben.user.email });
  await expect(benRow).toBeVisible();
  await expect(benRow.getByText("Needs confirmation")).toHaveCount(0);
  // Ben has the family's key now: the family shows in his vault.
  await ben.page.goto("/#/vault");
  await reloadVault(ben.page);
  await expect(ben.page.getByRole("navigation").getByText(FAMILY).first()).toBeVisible();

  // The owner lets people in automatically.
  await owner.page.goto(`/#/organizations/${orgId}/settings/joining`);
  await expect(card.getByTestId("family-link-qr")).toBeVisible();
  await card.getByRole("radio", { name: /Automatically/ }).check();
  await card.getByTestId("family-link-save-approval").click();
  await expect(owner.page.getByText("People who join with the link get in without you")).toBeVisible();
  // The same link still works: approval changed, the link didn't.
  await expect(card.getByTestId("family-link-address")).toHaveValue(link);

  // Cy joins, and the owner's open web vault lets her in with no click.
  const cy = await person(browser, "family-cy", repeat);
  await joinWithLink(cy.page, link);
  await expect(cy.page.getByTestId("family-join-done")).toContainText("lets you in when it's open");
  await owner.page.goto(`/#/organizations/${orgId}/members`);
  await expect(owner.page.getByText(`Let ${cy.user.email} into ${FAMILY}`)).toBeVisible({ timeout: 60_000 });
  const cyRow = owner.page.getByRole("row").filter({ hasText: cy.user.email });
  await expect(cyRow).toBeVisible();
  await expect(cyRow.getByText("Needs confirmation")).toHaveCount(0);

  // The owner sees who joined with the link, and how.
  await owner.page.goto(`/#/organizations/${orgId}/settings/joining`);
  const joins = card.getByTestId("family-link-joins");
  await expect(joins.locator(`[data-email="${cy.user.email}"]`)).toContainText("Let in automatically");
  await expect(joins.locator(`[data-email="${ben.user.email}"]`)).toContainText("· In");

  // The sheet to print: the family's name, where to go, the QR code while the
  // link works, and nothing that unlocks a vault.
  await card.getByTestId("family-link-sheet").click();
  const sheet = owner.page.getByTestId("family-sheet");
  await expect(sheet.getByRole("heading", { name: `${FAMILY}: how to get in` })).toBeVisible();
  await expect(sheet.getByTestId("family-sheet-vault")).toHaveText(server.url);
  await expect(sheet.getByTestId("family-sheet-download")).toHaveText(`${brand.urls.website}/download/`);
  await expect(sheet.getByTestId("family-sheet-qr")).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(sheet.getByTestId("family-sheet-ends")).toContainText("Anyone who scans it gets in until");
  const [, token, secret] = /t=([A-Za-z0-9_-]{43})&s=([A-Za-z0-9_-]{43})/.exec(link)!;
  const text = await sheet.innerText();
  const markup = (await sheet.innerHTML()).replace(/src="data:[^"]*"/g, "");
  for (const secretThing of [owner.user.password, token, secret]) {
    expect(text).not.toContain(secretThing);
    expect(markup).not.toContain(secretThing);
  }
  // Nothing encrypted, and no line to write a master password on.
  expect(markup).not.toMatch(/2\.[A-Za-z0-9+/=]+\|/);
  expect(text).toContain("Don't write your master password on this sheet.");
  // Printed, it's the sheet alone.
  await owner.page.emulateMedia({ media: "print" });
  await expect(sheet.getByRole("button", { name: "Print" })).toBeHidden();
  await owner.page.emulateMedia({ media: "screen" });

  // The suggestion to add a legacy contact shows on the vault page, and No
  // thanks keeps it away. Members never see it.
  await owner.page.goto("/#/vault");
  const suggestion = owner.page.getByTestId("legacy-contact-suggestion");
  await expect(suggestion).toContainText(
    "Add a legacy contact: someone you trust who can ask for your vault if something happens to you.",
  );
  await expect(suggestion.getByRole("link", { name: "Add one" })).toHaveAttribute("href", /#\/settings\/emergency-access$/);
  await suggestion.getByRole("button", { name: "No thanks" }).click();
  await expect(suggestion).toHaveCount(0);
  await reloadVault(owner.page);
  await owner.page.waitForLoadState("networkidle");
  await expect(owner.page.getByTestId("legacy-contact-suggestion")).toHaveCount(0);
  await ben.page.goto("/#/vault");
  await ben.page.waitForLoadState("networkidle");
  await expect(ben.page.getByTestId("legacy-contact-suggestion")).toHaveCount(0);

  for (const someone of [owner, ben, cy]) {
    await someone.context.close();
  }
});
