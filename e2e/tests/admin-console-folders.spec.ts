// An item's shared folders changed from the admin console (DESIGN.md,
// "Folders and permissions"). Since web-v2026.10.1, upstream's web vault
// saves that through its SDK only (CipherService.saveCollectionsWithServerAdmin),
// which our clean-room rules keep us from reading, so this checks what comes
// out of it end to end.
//
// A business organization has Everyone and Admins, and a login with a
// password and a one-time code in Everyone. Kim reaches Everyone without
// passwords. Lee can edit Everyone's items without their passwords, and can
// edit Admins. Ada is an admin. Lee can't change the login's shared folders:
// the server refuses it without see passwords. Ada adds the login to Admins
// from the admin console. Afterwards the server stores the login exactly as
// before, the owner opens the same password and one-time code, and Kim still
// can't see the password (Lee now can, through Admins, as the grid says).
import { expect, test, type Page } from "@playwright/test";

import { Api, totp } from "./api/support";
import { acceptRole, confirmMember, signUp, signUpWithAuthenticator, webUserFor } from "./support/web";

const PASSWORD = "harbor-payroll-2026!";
const TOTP_KEY = "JBSWY3DPEHPK3PXP";

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

/** Picks a shared folder in the admin console's vault, and returns its id. */
async function openFolder(page: Page, org: string, name: string) {
  await page.goto("/#/vault");
  await page.goto(`${org}/vault`);
  await page.getByRole("button", { name, exact: true }).first().click();
  await expect(page).toHaveURL(/collectionId=[0-9a-f-]{36}/);
  return /collectionId=([0-9a-f-]{36})/.exec(page.url())![1];
}

/**
 * Whether someone may see an item's password, as the server says in their
 * sync and as their web vault shows the item: no way to reveal it, and the
 * page never holds it.
 */
async function seesPassword(page: Page, token: () => { token: string }, api: Api, id: string) {
  await page.goto("/#/vault");
  await page.reload();
  await expect(page.getByText("Payroll portal").first()).toBeVisible({ timeout: 30_000 });
  const sync = await api.call(token(), "GET", "/api/sync");
  expect(sync.status).toBe(200);
  const item = sync.body.ciphers.find((c: any) => c.id === id);
  await page.getByText("Payroll portal").first().click();
  const view = page.getByRole("dialog", { name: "View Login" });
  await expect(view.getByRole("textbox", { name: "Username" })).toHaveValue("payroll@harbor.test");
  if (!item.viewPassword) {
    await expect(view.getByRole("button", { name: "Toggle visibility" })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(PASSWORD);
  }
  await view.getByRole("button", { name: "Close" }).first().click();
  await expect(view).toBeHidden();
  return item.viewPassword as boolean;
}

/** The six digits a one-time code field shows, as "123 456". */
const shown = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

test("an admin adds a login to another shared folder from the admin console, and its password, its one-time code, and who may see them stay as they were", async ({
  browser,
  request,
}, testInfo) => {
  test.setTimeout(360_000);
  const api = new Api(request);
  const index = testInfo.repeatEachIndex;
  const ownerUser = webUserFor("folders-owner", index);
  const adaUser = webUserFor("folders-admin", index);
  const kimUser = webUserFor("folders-hidden", index);
  const leeUser = webUserFor("folders-editor", index);
  const open = async () => (await browser.newContext()).newPage();
  const [owner, ada, kim, lee] = await Promise.all([open(), open(), open(), open()]);
  const ownerToken = tokenOf(owner);
  const kimToken = tokenOf(kim);
  const leeToken = tokenOf(lee);

  // A business organization's owner and admins sign in with two-step login.
  await Promise.all([
    signUpWithAuthenticator(owner, ownerUser),
    signUpWithAuthenticator(ada, adaUser),
    signUp(kim, kimUser),
    signUp(lee, leeUser),
  ]);

  await owner.goto("/#/create-organization");
  await owner.getByRole("textbox", { name: /Organization name/ }).fill("Harbor Dental");
  await owner.getByRole("radio", { name: /A business/ }).check();
  await owner.getByRole("button", { name: "Create organization" }).click();
  await owner.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  const org = owner.url().replace(/\/members.*$/, "");
  const orgId = /organizations\/([0-9a-f-]{36})/.exec(org)![1];
  const admins = await openFolder(owner, org, "Admins");
  const everyone = await openFolder(owner, org, "Everyone");

  // The owner's login in Everyone: a password and a one-time code.
  await owner.getByRole("button", { name: "Add", exact: true }).click();
  await owner.getByRole("menuitem", { name: "Login" }).click();
  const login = owner.getByRole("dialog", { name: "Add login" });
  await login.getByRole("textbox", { name: /Item name/ }).fill("Payroll portal");
  await login.getByRole("textbox", { name: "Username", exact: true }).fill("payroll@harbor.test");
  await login.getByRole("textbox", { name: "Password", exact: true }).fill(PASSWORD);
  await login.getByRole("textbox", { name: /Authenticator key/ }).fill(TOTP_KEY);
  await login.getByRole("button", { name: "Save" }).click();
  await expect(login).toBeHidden();
  await owner.getByRole("dialog", { name: "View Login" }).getByRole("button", { name: "Close" }).first().click();

  // Ada as an admin, Kim with Everyone without passwords, and Lee who can
  // edit Everyone's items without their passwords and can edit Admins.
  const invite = async (email: string, type: number, collections: object[]) => {
    const invited = await api.call(ownerToken(), "POST", `/api/organizations/${orgId}/users/invite`, {
      emails: [email],
      type,
      accessSecretsManager: false,
      permissions: {},
      collections,
      groups: [],
    });
    expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  };
  await invite(adaUser.email, 1, []);
  await invite(kimUser.email, 2, [{ id: everyone, readOnly: true, hidePasswords: true, manage: false }]);
  await invite(leeUser.email, 2, [
    { id: everyone, readOnly: false, hidePasswords: true, manage: false },
    { id: admins, readOnly: false, hidePasswords: false, manage: false },
  ]);
  await acceptRole(ada);
  await owner.goto("/#/vault");
  await owner.goto(`${org}/members`);
  for (const email of [adaUser.email, kimUser.email, leeUser.email]) {
    await confirmMember(owner, email);
  }

  // The login as stored now, which nothing below may change.
  const details = await api.call(
    ownerToken(),
    "GET",
    `/api/ciphers/organization-details?organizationId=${orgId}`,
  );
  expect(details.status, JSON.stringify(details.body)).toBe(200);
  expect(details.body.data).toHaveLength(1);
  const before = details.body.data[0];
  const id: string = before.id;
  expect(before.collectionIds).toEqual([everyone]);
  const stored = (cipher: any) => ({
    key: cipher.key,
    name: cipher.name,
    username: cipher.login.username,
    password: cipher.login.password,
    totp: cipher.login.totp,
  });

  // Neither Kim nor Lee may see its password, and Lee can't change its
  // shared folders: the server wants see passwords for that too.
  expect(await seesPassword(kim, kimToken, api, before.id), "Kim, before").toBe(false);
  expect(await seesPassword(lee, leeToken, api, before.id), "Lee, before").toBe(false);
  const leeChange = await api.call(leeToken(), "PUT", `/api/ciphers/${id}/collections_v2`, {
    collectionIds: [everyone, admins],
  });
  expect(leeChange.status, JSON.stringify(leeChange.body)).toBe(400);
  expect(JSON.stringify(leeChange.body)).toContain("permission to change this item's shared folders");

  // Ada adds it to Admins from the admin console: upstream's admin save.
  await openFolder(ada, org, "Everyone");
  const row = ada.getByRole("row").filter({ hasText: "Payroll portal" });
  await row.getByRole("button", { name: "Options" }).click();
  await ada.getByRole("menuitem", { name: "Add to shared folders" }).click();
  const assign = ada.getByRole("dialog", { name: /Add to shared folders/ });
  await assign.getByRole("combobox").first().click();
  await ada.getByRole("option", { name: "Admins" }).click();
  // Closing the list shows the dialog's buttons again.
  await assign.getByText(/Only organization members with access/).click();
  await expect(ada.getByRole("listbox")).toHaveCount(0);
  // As an admin with one item, it goes to upstream's admin route.
  const adminSave = ada.waitForRequest(
    (r) => r.url().includes(`/api/ciphers/${id}/collections-admin`) && r.method() !== "GET",
  );
  await assign.getByRole("button", { name: "Assign" }).click();
  await adminSave;
  await expect(assign).toBeHidden();

  // The server holds it in both folders, with every encrypted value as it was.
  const after = await api.call(ownerToken(), "GET", `/api/ciphers/${id}/admin`);
  expect(after.status, JSON.stringify(after.body)).toBe(200);
  expect([...after.body.collectionIds].sort()).toEqual([admins, everyone].sort());
  expect(stored(after.body)).toEqual(stored(before));

  // The owner opens the same password and one-time code.
  await owner.goto("/#/vault");
  await owner.reload();
  await owner.getByText("Payroll portal").first().click();
  const view = owner.getByRole("dialog", { name: "View Login" });
  await view.getByRole("button", { name: "Toggle visibility" }).first().click();
  await expect(view.getByRole("textbox", { name: "Password" })).toContainText(PASSWORD);
  await expect(async () => {
    const value = await view.getByRole("textbox", { name: "Verification code (TOTP)" }).inputValue();
    expect([shown(totp(TOTP_KEY)), shown(totp(TOTP_KEY, Date.now() - 30_000))]).toContain(value);
  }).toPass({ timeout: 15_000 });

  // Kim's access is as it was, and she still can't see the password. Lee
  // can now: the login is in Admins too, where Lee may see passwords, and an
  // item in several folders gets what any of them allows (DESIGN.md, "The grid").
  const members = await api.call(ownerToken(), "GET", `/api/organizations/${orgId}/users`);
  expect(members.status, JSON.stringify(members.body)).toBe(200);
  const kimMember = members.body.data.find((m: any) => m.email === kimUser.email);
  const users = await api.call(ownerToken(), "GET", `/api/organizations/${orgId}/collections/${everyone}/users`);
  expect(users.status, JSON.stringify(users.body)).toBe(200);
  expect(users.body.find((u: any) => u.id === kimMember.id)).toMatchObject({
    readOnly: true,
    hidePasswords: true,
    manage: false,
  });
  expect(await seesPassword(kim, kimToken, api, id), "Kim, after").toBe(false);
  expect(await seesPassword(lee, leeToken, api, id), "Lee, after").toBe(true);
});
