// Members' own passwords (DESIGN.md, "Members' own passwords"): a member's
// web vault counts the logins in their Personal items after unlocking and
// sends only the numbers; the organization's owner sees them in its Reports,
// never which items, while the organization has the setting on (a business
// does). The member's Health page names who sees them. The breach check is a
// stand-in here (the test browser reaches no outside host), so exposed is
// counted too.
import { createHash } from "node:crypto";

import { type BrowserContext, expect, type Page, test } from "@playwright/test";

import { Api } from "./api/support";
import { confirmMember, reloadVault, signUp, signUpWithAuthenticator, webUserFor } from "./support/web";

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex").toUpperCase();

const BREACHED = "Summer2026!Northwind";
const SHARED = "kq9#Vz!m2P@xL7&r-Wt4";
const WEAK = "password1";

/** The range API, padded as the real one pads, knowing one breached password. */
async function pwnedPasswords(context: BrowserContext) {
  await context.route("https://api.pwnedpasswords.com/**", async (route) => {
    const prefix = new URL(route.request().url()).pathname.slice("/range/".length);
    const lines = Array.from({ length: 400 }, (_, i) => `${sha1(`decoy ${prefix} ${i}`).slice(5)}:0`);
    if (sha1(BREACHED).startsWith(prefix)) {
      lines.push(`${sha1(BREACHED).slice(5)}:812`);
    }
    await route.fulfill({
      status: 200,
      contentType: "text/plain",
      headers: { "access-control-allow-origin": "*" },
      body: lines.sort().join("\r\n"),
    });
  });
}

/** The web vault's own access token, from its latest API request. */
function tokenOf(page: Page) {
  let token = "";
  page.on("request", (request) => {
    const header = request.headers()["authorization"];
    if (header?.startsWith("Bearer ") && request.url().includes("/api/")) {
      token = header.slice("Bearer ".length);
    }
  });
  return () => ({ token });
}

async function importLogins(page: Page, logins: [string, string][]) {
  await page.goto("/#/tools/import");
  await page.getByRole("combobox", { name: /File format/ }).click();
  await page.getByRole("option", { name: "Bitwarden (json)" }).click();
  const items = logins.map(([name, password]) => ({
    type: 1,
    name,
    login: { username: "ana@example.test", password, uris: [] },
  }));
  await page
    .getByRole("textbox", { name: /copy\/paste the import file contents/ })
    .fill(JSON.stringify({ encrypted: false, folders: [], items }));
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByRole("dialog", { name: "Data successfully imported" }).getByRole("button", { name: "Ok" }).click();
}

test("a member's own logins reach the owner as numbers only, and the member is told who sees them", async ({
  browser,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const ownerContext = await browser.newContext();
  const page = await ownerContext.newPage();
  const auth = tokenOf(page);
  await signUpWithAuthenticator(page, webUserFor("member-health-owner", testInfo.repeatEachIndex));
  await page.goto("/#/create-organization");
  await page.getByRole("textbox", { name: /Organization name/ }).fill("Harbor Dental");
  await page.getByRole("radio", { name: /A business/ }).check();
  await page.getByRole("button", { name: "Create organization" }).click();
  await page.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  const org = page.url().replace(/\/members.*$/, "");
  const orgId = /organizations\/([0-9a-f-]{36})/.exec(org)![1];

  // Ana signs up in her own browser, and the owner adds her.
  const anaContext = await browser.newContext();
  await pwnedPasswords(anaContext);
  const ana = await anaContext.newPage();
  const anaUser = webUserFor("member-health-ana", testInfo.repeatEachIndex);
  await signUp(ana, anaUser);
  await importLogins(ana, [
    ["Old forum", WEAK],
    ["Northwind Bank", BREACHED],
    ["Bank", SHARED],
    ["Bank, again", SHARED],
  ]);
  const invited = await new Api(request).call(auth(), "POST", `/api/organizations/${orgId}/users/invite`, {
    emails: [anaUser.email],
    type: 2,
    accessSecretsManager: false,
    permissions: {},
    collections: [],
    groups: [],
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  // The Members page is open already: reload it, so it lists Ana.
  await page.goto(`${org}/members`);
  await page.reload();
  await confirmMember(page, anaUser.email);

  // Ana's web vault, unlocked again as a member, counts her own logins and
  // sends the numbers; her Health page says who sees them.
  await reloadVault(ana);
  await ana.goto("/#/reports");
  await expect(ana.getByTestId("keykeeper-own-health-seen-by")).toHaveText(
    "Admins at Harbor Dental see how many of your own passwords are weak, reused, or exposed. Never which ones.",
  );

  // The owner's Reports: the numbers per member, and no item.
  await page.goto(`${org}/reporting/reports`);
  await page.getByText("Members' own passwords", { exact: true }).click();
  await expect(page).toHaveURL(/member-health-report/);
  const row = page.locator(`[data-testid="member-health-row"][data-email="${anaUser.email}"]`);
  await expect(async () => {
    await page.reload();
    await expect(row.getByTestId("member-health-logins")).toHaveText("4", { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await expect(row.getByTestId("member-health-weak")).toHaveText("1");
  await expect(row.getByTestId("member-health-reused")).toHaveText("2");
  await expect(row.getByTestId("member-health-exposed")).toHaveText("1");
  await expect(row.getByTestId("member-health-reported")).not.toBeEmpty();
  for (const name of ["Old forum", "Northwind Bank", "Bank"]) {
    await expect(page.getByText(name, { exact: true })).toHaveCount(0);
  }
  await expect(page.getByTestId("member-health-summary")).toContainText("members reported");

  await anaContext.close();
  await ownerContext.close();
});

test("a member's Reports doesn't show Members' own passwords, and its address shows them nothing", async ({
  browser,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const ownerContext = await browser.newContext();
  const page = await ownerContext.newPage();
  const auth = tokenOf(page);
  await signUpWithAuthenticator(page, webUserFor("member-health-owner-2", testInfo.repeatEachIndex));
  await page.goto("/#/create-organization");
  await page.getByRole("textbox", { name: /Organization name/ }).fill("Dune Bakery");
  await page.getByRole("radio", { name: /A business/ }).check();
  await page.getByRole("button", { name: "Create organization" }).click();
  await page.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  const org = page.url().replace(/\/members.*$/, "");
  const orgId = /organizations\/([0-9a-f-]{36})/.exec(org)![1];

  // The owner's own Reports offers it.
  await page.goto(`${org}/reporting/reports`);
  await expect(page.getByText("Members' own passwords", { exact: true })).toBeVisible();
  await expect(page.getByText("Expiring items", { exact: true })).toBeVisible();

  // A plain member gets neither the card nor the page, and nothing the page
  // would load signs them out.
  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  const memberUser = webUserFor("member-health-member", testInfo.repeatEachIndex);
  await signUp(member, memberUser);
  const invited = await new Api(request).call(auth(), "POST", `/api/organizations/${orgId}/users/invite`, {
    emails: [memberUser.email],
    type: 2,
    accessSecretsManager: false,
    permissions: {},
    collections: [],
    groups: [],
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  await page.goto(`${org}/members`);
  await page.reload();
  await confirmMember(page, memberUser.email);
  await reloadVault(member);
  await member.goto(`/#/organizations/${orgId}/reporting/reports/member-health-report`);
  await expect(member.getByTestId("member-health-row")).toHaveCount(0);
  // Still signed in: the vault is there.
  await member.goto("/#/vault");
  await expect(member.getByRole("textbox", { name: /^Master password/ })).toHaveCount(0);
  await expect(member).toHaveURL(/#\/vault/);

  await memberContext.close();
  await ownerContext.close();
});

test("an owner turns Members' own passwords off on Joining and security: the report says so, and the member is no longer told", async ({
  browser,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const ownerContext = await browser.newContext();
  const page = await ownerContext.newPage();
  const auth = tokenOf(page);
  await signUpWithAuthenticator(page, webUserFor("member-health-owner-3", testInfo.repeatEachIndex));
  await page.goto("/#/create-organization");
  await page.getByRole("textbox", { name: /Organization name/ }).fill("Coho Winery");
  await page.getByRole("radio", { name: /A business/ }).check();
  await page.getByRole("button", { name: "Create organization" }).click();
  await page.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  const org = page.url().replace(/\/members.*$/, "");
  const orgId = /organizations\/([0-9a-f-]{36})/.exec(org)![1];

  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  const memberUser = webUserFor("member-health-member-3", testInfo.repeatEachIndex);
  await signUp(member, memberUser);
  const invited = await new Api(request).call(auth(), "POST", `/api/organizations/${orgId}/users/invite`, {
    emails: [memberUser.email],
    type: 2,
    accessSecretsManager: false,
    permissions: {},
    collections: [],
    groups: [],
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  await page.goto(`${org}/members`);
  await page.reload();
  await confirmMember(page, memberUser.email);
  await reloadVault(member);
  const line = member.getByTestId("keykeeper-own-health-seen-by");
  /** Opens the member's Health page again, once the server has said who sees the numbers. */
  const openHealth = async () => {
    const answered = member.waitForResponse((r) => r.url().includes("/api/keykeeper/own-health/seen-by"));
    await member.goto("/#/vault");
    await member.goto("/#/reports");
    expect((await answered).status()).toBe(200);
  };
  await openHealth();
  await expect(line).toHaveText(
    "Admins at Coho Winery see how many of your own passwords are weak, reused, or exposed. Never which ones.",
  );

  // On for a business; turning it off asks first.
  await page.goto(`${org}/settings/joining`);
  const card = page.getByTestId("member-health-setting");
  const box = card.getByRole("checkbox", {
    name: "See how many of members' own passwords are weak, reused, or exposed",
  });
  await expect(box).toBeChecked();
  await box.uncheck();
  await card.getByRole("button", { name: "Save" }).click();
  await page
    .getByRole("dialog", { name: /Turn off Members' own passwords/ })
    .getByRole("button", { name: "Turn it off" })
    .click();
  await expect(page.getByText("Members' own passwords is off", { exact: true })).toBeVisible();
  await expect(box).not.toBeChecked();

  // The report says it's off, lists nobody, and links to where it's turned on.
  await page.goto(`${org}/reporting/reports/member-health-report`);
  await expect(page.getByTestId("member-health-off")).toContainText("Members' own passwords is off");
  await expect(page.getByTestId("member-health-row")).toHaveCount(0);
  await page.getByTestId("member-health-off").getByRole("link").click();
  await expect(page).toHaveURL(/\/settings\/joining$/);

  // The member's Health page no longer says anyone sees the numbers.
  await openHealth();
  await expect(line).toHaveCount(0);

  // On again: the line is back.
  await card.getByRole("checkbox").check();
  await card.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Members' own passwords is on", { exact: true })).toBeVisible();
  await openHealth();
  await expect(line).toContainText("Admins at Coho Winery");

  await memberContext.close();
  await ownerContext.close();
});
