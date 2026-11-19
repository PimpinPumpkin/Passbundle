// A client's point of contact with a custom role, through the web vault: the
// MSP gives them "Manage users" only; they see the Members page but not
// Policies, can invite a regular member and open their edit dialog, and can't
// invite an admin, and their Options menu leaves out a member's event log. A
// custom role that only views event logs opens the event log and sees who
// acted, and one that also manages members opens a member's event log. The
// member dialog offers every permission the server enforces, together: one
// that manages shared folders makes one on the Collections page and gives a
// member access, and one that only manages members, opening the Collections
// page by its address, is told "You can't do that here." and stays signed in
// (DESIGN.md, "Roles and permissions", B30). On the Collections page, a custom
// role that manages shared folders sees the items in the folders it reaches,
// and no others.
import { expect, test, type Page } from "@playwright/test";

import { Api } from "./api/support";
import {
  encryptTo,
  realAccount,
  realCollection,
  realLogin,
  realOrganization,
  type LoginValues,
  type RealAccount,
} from "./support/vault-crypto";
import {
  acceptRole,
  chooseRole,
  confirmMember,
  menu,
  reloadVault,
  roleOption,
  signUp,
  signUpWithAuthenticator,
  webUserFor,
} from "./support/web";

const toast = (page: Page, text: string | RegExp) => page.getByText(text).first();

/**
 * The API calls the server refused as unauthorized or forbidden. The web vault
 * signs out on either, so a page that makes one is broken for that person.
 */
function refusedCalls(page: Page) {
  const refused: string[] = [];
  page.on("response", (response) => {
    if ([401, 403].includes(response.status()) && response.url().includes("/api/")) {
      refused.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
  return refused;
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

/** A business organization of the owner's, from New organization, and its address. */
async function business(owner: Page, name: string) {
  await owner.goto("/#/create-organization");
  await owner.getByRole("textbox", { name: /Organization name/ }).fill(name);
  await owner.getByRole("radio", { name: /A business/ }).check();
  await owner.getByRole("button", { name: "Create organization" }).click();
  await owner.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  const org = owner.url().replace(/\/members.*$/, "");
  return { org, orgId: /organizations\/([0-9a-f-]{36})/.exec(org)![1] };
}

test("an MSP admin gives a client's point of contact a custom role that manages members, and nothing more", async ({
  browser,
}, testInfo) => {
  test.setTimeout(150_000);
  const pocContext = await browser.newContext();
  const poc = await pocContext.newPage();
  // A point of contact who manages members, and the MSP's admin, sign in with
  // two-step login (DESIGN.md, "Two-step login for admins").
  const pocUser = webUserFor("poc", testInfo.repeatEachIndex);
  await signUpWithAuthenticator(poc, pocUser);

  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await signUpWithAuthenticator(admin, webUserFor("roles-admin", testInfo.repeatEachIndex));
  await admin.goto("/#/msp");
  await admin.getByRole("textbox", { name: "Your MSP's name" }).fill("Roles IT");
  await admin.getByRole("button", { name: "Create MSP" }).click();
  await admin.getByRole("textbox", { name: "New client's name" }).fill("Fabrikam Dental");
  await admin.getByRole("button", { name: "Add client" }).click();
  await admin.getByTestId("msp-client-Fabrikam Dental").getByRole("link", { name: "Admin console" }).click();
  await expect(admin).toHaveURL(/#\/organizations\/[^/]+\/members/);
  const orgUrl = admin.url().replace(/\/members.*$/, "");

  // The MSP admin invites the point of contact with a Custom role: manage users only.
  await admin.getByRole("button", { name: "Invite member" }).click();
  const invite = admin.getByRole("dialog", { name: /Invite member/ });
  await invite.getByRole("textbox", { name: /Email/ }).fill(pocUser.email);
  await chooseRole(invite, "Custom");
  // Every permission the server enforces, together, in plain words, and not
  // upstream's Manage all shared folders, which reaches every one.
  await invite.getByRole("checkbox", { name: "Manage users" }).check();
  for (const name of [
    "Manage groups",
    "Manage shared folders",
    "Access reports",
    "Access to all items",
  ]) {
    // Each one's name starts with its label; a line in plain words follows.
    const box = invite.getByRole("checkbox", { name: new RegExp(`^${name}`) });
    await expect(box).toBeVisible();
    await expect(box).toBeEnabled();
  }
  await expect(invite.getByRole("checkbox", { name: "Manage all shared folders" })).toHaveCount(0);
  await expect(invite.getByText(/only shared folders they reach/)).toBeVisible();
  await invite.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(invite).toBeHidden();
  await acceptRole(poc);
  await admin.goto("/#/msp");
  await expect(toast(admin, "Confirmed 1 member")).toBeVisible();

  // The point of contact opens the organization, lands on Members, and sees
  // nothing else of the admin console.
  await reloadVault(poc);
  const refused = refusedCalls(poc);
  await poc.goto(orgUrl);
  await expect(poc).toHaveURL(/#\/organizations\/[^/]+\/members/);
  await expect(poc.getByRole("button", { name: "Invite member" })).toBeVisible();
  await expect(poc.getByRole("link", { name: "Members" })).toBeVisible();
  await expect(poc.getByRole("link", { name: "Policies" })).toHaveCount(0);

  // A member's Options menu doesn't offer their event log, which this role
  // can't view: opening it would be refused and sign them out.
  const ownRow = poc.getByRole("row").filter({ hasText: pocUser.email });
  await ownRow.getByRole("button", { name: "Options" }).click();
  await expect(poc.getByRole("menu")).toBeVisible();
  await expect(poc.getByRole("menuitem", { name: "Event logs" })).toHaveCount(0);
  await poc.keyboard.press("Escape");
  await expect(poc.getByRole("menu")).toBeHidden();

  const newHire = `front-desk-${testInfo.repeatEachIndex}@example.test`;
  await poc.getByRole("button", { name: "Invite member" }).click();
  const pocInvite = poc.getByRole("dialog", { name: /Invite member/ });
  await pocInvite.getByRole("textbox", { name: /Email/ }).fill(newHire);
  await pocInvite.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(pocInvite).toBeHidden();
  // A row, since the first text match is the avatar's hidden title.
  const newHireRow = poc.getByRole("row").filter({ hasText: newHire });
  await expect(newHireRow).toBeVisible();

  // Their edit dialog loads the member, the organization's groups, and the
  // collections, all within the role.
  await newHireRow.getByRole("button", { name: newHire }).click();
  const edit = poc.getByRole("dialog", { name: /Edit member/ });
  await expect(edit.getByRole("tab", { name: "Groups" })).toBeVisible();
  await edit.getByRole("button", { name: "Close" }).click();
  await expect(edit).toBeHidden();

  // The server refuses anything beyond a regular member, whatever the dialog offers.
  await poc.getByRole("button", { name: "Invite member" }).click();
  const adminInvite = poc.getByRole("dialog", { name: /Invite member/ });
  await adminInvite.getByRole("textbox", { name: /Email/ }).fill(`would-be-admin-${testInfo.repeatEachIndex}@example.test`);
  await adminInvite.getByRole("combobox", { name: /Member role/ }).click();
  const adminOption = roleOption(adminInvite, "Admin");
  if ((await adminOption.getAttribute("aria-disabled")) !== "true") {
    await adminOption.click();
    await adminInvite.getByRole("button", { name: "Invite", exact: true }).click();
    await expect(toast(poc, /Only Owners can invite|only add regular members/)).toBeVisible();
  } else {
    await poc.keyboard.press("Escape");
  }
  await expect(poc.getByText(`would-be-admin-${testInfo.repeatEachIndex}@example.test`)).toHaveCount(0);

  // Nothing they opened was refused, so they were never signed out.
  await expect(poc).toHaveURL(/#\/organizations\/[^/]+\/members/);
  expect(refused).toEqual([]);

  await pocContext.close();
  await adminContext.close();
});

test("a custom role that manages shared folders makes one on the Collections page and gives a member access, never signed out", async ({
  browser,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const api = new Api(request);
  const index = testInfo.repeatEachIndex;
  const ownerUser = webUserFor("folders-role-owner", index);
  const pocUser = webUserFor("folders-role-poc", index);
  const memberUser = webUserFor("folders-role-member", index);
  const open = async () => (await browser.newContext()).newPage();
  const [owner, poc, member] = await Promise.all([open(), open(), open()]);
  const ownerToken = tokenOf(owner);
  // A business's owner and anyone who manages shared folders sign in with
  // two-step login (DESIGN.md, "Two-step login for admins").
  await Promise.all([
    signUpWithAuthenticator(owner, ownerUser),
    signUpWithAuthenticator(poc, pocUser),
    signUp(member, memberUser),
  ]);
  const { org, orgId } = await business(owner, "Lakeside Clinic");

  // The owner invites the point of contact: Custom, Manage shared folders.
  await owner.getByRole("button", { name: "Invite member" }).click();
  const invite = owner.getByRole("dialog", { name: /Invite member/ });
  await invite.getByRole("textbox", { name: /Email/ }).fill(pocUser.email);
  await chooseRole(invite, "Custom");
  await invite.getByRole("checkbox", { name: /^Manage shared folders/ }).check();
  await invite.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(invite).toBeHidden();
  // And a regular member.
  const invited = await api.call(ownerToken(), "POST", `/api/organizations/${orgId}/users/invite`, {
    emails: [memberUser.email],
    type: 2,
    permissions: {},
    collections: [],
    groups: [],
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  // The test servers send no email: the member joins at once, and the point
  // of contact, whose role needs two-step login, accepts it.
  await acceptRole(poc);
  await owner.goto("/#/vault");
  await owner.goto(`${org}/members`);
  // The owner's web vault confirms whoever it invited itself, once they
  // accept; the member invited by the API is confirmed by hand.
  await confirmMember(owner, memberUser.email);
  await expect(
    owner.getByRole("row").filter({ hasText: pocUser.email }).getByText(/Needs confirmation|Invited/),
  ).toHaveCount(0, { timeout: 30_000 });

  // The point of contact opens the organization and lands on its shared
  // folders, the page their role opens.
  await reloadVault(poc);
  const refused = refusedCalls(poc);
  await poc.goto(org);
  await expect(poc).toHaveURL(/#\/organizations\/[^/]+\/vault/);
  await expect(poc.getByRole("link", { name: "Members" })).toHaveCount(0);

  // A new shared folder, which the member can view.
  await poc.getByRole("button", { name: "Add", exact: true }).click();
  await poc.getByRole("menuitem", { name: "Shared folder" }).click();
  const dialog = poc.getByRole("dialog", { name: /shared folder/i });
  await dialog.getByRole("textbox", { name: /^Name/ }).fill("Front desk");
  await dialog.getByRole("tab", { name: "Access" }).click();
  await dialog.getByRole("combobox", { name: /Select groups and members/ }).click();
  await poc.keyboard.type("folders-role-member");
  await poc.getByRole("option", { name: new RegExp(memberUser.email) }).click();
  // Closing the list adds who was picked.
  await dialog.getByText(/Grant groups or members access/).click();
  const memberRow = dialog.getByRole("row").filter({ hasText: memberUser.email });
  await expect(memberRow).toBeVisible();
  await memberRow.getByRole("combobox").click();
  await poc.getByRole("option", { name: "Can view", exact: true }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  // It's on their page, and the server gave the member Can view and the
  // point of contact every permission there but manage.
  await poc.getByRole("button", { name: "Front desk", exact: true }).first().click();
  await expect(poc).toHaveURL(/collectionId=[0-9a-f-]{36}/);
  const id = /collectionId=([0-9a-f-]{36})/.exec(poc.url())![1];
  const listed = await api.call(ownerToken(), "GET", `/api/organizations/${orgId}/users`);
  const idOf = (email: string) =>
    listed.body.data.find((m: { email: string }) => m.email === email).id;
  const access = await api.call(ownerToken(), "GET", `/api/organizations/${orgId}/collections/${id}/users`);
  expect(access.status, JSON.stringify(access.body)).toBe(200);
  const grant = (email: string) => access.body.find((u: { id: string }) => u.id === idOf(email));
  expect(grant(memberUser.email)).toMatchObject({ readOnly: true, manage: false });
  expect(grant(pocUser.email)).toMatchObject({ readOnly: false, manage: false });
  expect(grant(pocUser.email).keykeeper).toMatchObject({ delete: true, export: true, manage: false });

  // Nothing they opened was refused, so they were never signed out.
  expect(refused).toEqual([]);

  await Promise.all([owner.context().close(), poc.context().close(), member.context().close()]);
});

test("a custom role that manages shared folders sees the items in the folders it reaches on the Collections page, and no others", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const api = new Api(request);
  // An organization with real keys, so the web vault opens its items: a
  // folder the role reaches and one it doesn't, a login in each, one in both,
  // and one the owner took out of every folder.
  const owner = await realAccount(request, "oda-owner");
  const org = await realOrganization(request, owner, "Lakeside Clinic");
  const twoStep = await api.call(owner, "GET", `/api/keykeeper/organizations/${org.id}/admin-two-step`);
  expect(twoStep.body.required, "this organization doesn't require two-step login for admins").toBe(false);
  const frontDesk = await realCollection(request, owner, org, "oda-front-desk");
  const billing = await realCollection(request, owner, org, "oda-billing");
  const login = (name: string): LoginValues => ({
    name,
    username: `${name.toLowerCase().replace(/\s+/g, "-")}@lakeside.test`,
    password: `fixture-${name.toLowerCase().replace(/\s+/g, "-")}-2026`,
    uri: "https://lakeside.test/login",
  });
  const folders = async (id: string, collectionIds: string[]) => {
    const moved = await api.call(owner, "PUT", `/api/ciphers/${id}/collections-admin`, { collectionIds });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  };
  const visits = await realLogin(request, owner, org, frontDesk, login("Visit scheduler"));
  const fax = await realLogin(request, owner, org, frontDesk, login("Shared fax"));
  await folders(fax, [frontDesk, billing]);
  await realLogin(request, owner, org, billing, login("Billing portal"));
  const loose = await realLogin(request, owner, org, frontDesk, login("Loose login"));
  await folders(loose, []);

  // The point of contact: Custom, Manage shared folders, Can edit in the
  // front desk folder, confirmed with the organization's key.
  const poc: RealAccount = await realAccount(request, "oda-poc");
  const invited = await api.call(owner, "POST", `/api/organizations/${org.id}/users/invite`, {
    emails: [poc.email],
    type: 4,
    permissions: { keykeeperManageCollections: true },
    collections: [{ id: frontDesk, readOnly: false, hidePasswords: false, manage: false }],
    groups: [],
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  await api.acceptRole(poc, org.id);
  const pocId = (await api.members(owner, org.id)).find((m) => m.email === poc.email)!.id;
  const confirmed = await api.call(owner, "POST", `/api/organizations/${org.id}/users/${pocId}/confirm`, {
    key: encryptTo(poc.publicKey, org.key),
  });
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);

  await page.goto("/#/login");
  await page.getByLabel(/Email address/).fill(poc.email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("textbox", { name: /Master password/ }).fill(poc.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(menu(page)).toBeVisible({ timeout: 30_000 });

  // The Collections page asks for its items, and the server answers with
  // the ones in the folder it reaches.
  const refused = refusedCalls(page);
  const assigned = page.waitForResponse(
    (r) => r.url().includes("/api/ciphers/organization-details/assigned") && r.request().method() === "GET",
  );
  await page.goto(`/#/organizations/${org.id}/vault`);
  const answer = await assigned;
  expect(answer.status()).toBe(200);
  const items: { id: string; collectionIds: string[] }[] = (await answer.json()).data;
  expect(items.map((c) => c.id).sort()).toEqual([visits, fax].sort());
  expect(items.find((c) => c.id === fax)!.collectionIds).toEqual([frontDesk]);

  // The page shows them in the folder, and nothing of the other folder.
  await expect(page.getByRole("button", { name: "oda-billing", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "oda-front-desk", exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`organizations/${org.id}/vault\\?.*collectionId=${frontDesk}`));
  const rows = page.getByRole("row");
  await expect(rows.filter({ hasText: "Visit scheduler" })).toBeVisible();
  await expect(rows.filter({ hasText: "Shared fax" })).toBeVisible();
  await expect(page.getByText("Billing portal")).toHaveCount(0);
  await expect(page.getByText("Loose login")).toHaveCount(0);

  // Nothing they opened was refused, so they were never signed out.
  expect(refused).toEqual([]);
});

test("a custom role that only manages members opens the Collections and Groups pages by their address, is told it can't do that here, and stays signed in", async ({
  browser,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const api = new Api(request);
  const index = testInfo.repeatEachIndex;
  const ownerUser = webUserFor("refused-owner", index);
  const pocUser = webUserFor("refused-poc", index);
  const open = async () => (await browser.newContext()).newPage();
  const [owner, poc] = await Promise.all([open(), open()]);
  const ownerToken = tokenOf(owner);
  await Promise.all([signUpWithAuthenticator(owner, ownerUser), signUpWithAuthenticator(poc, pocUser)]);
  const { org, orgId } = await business(owner, "Tailspin Clinic");
  const invited = await api.call(ownerToken(), "POST", `/api/organizations/${orgId}/users/invite`, {
    emails: [pocUser.email],
    type: 4,
    permissions: { manageUsers: true },
    collections: [],
    groups: [],
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  await acceptRole(poc);
  await owner.goto("/#/vault");
  await owner.goto(`${org}/members`);
  await confirmMember(owner, pocUser.email);

  await reloadVault(poc);
  const refused = refusedCalls(poc);
  for (const page of ["vault", "groups"]) {
    await poc.goto(`${org}/${page}`);
    // Told in the server's words, and taken to the Members page they have.
    await expect(poc.getByText("You can't do that here.").first()).toBeVisible();
    await expect(poc).toHaveURL(/#\/organizations\/[^/]+\/members/);
    await expect(poc.getByRole("button", { name: "Invite member" })).toBeVisible();
    await expect(poc.getByRole("link", { name: /Shared folders|Collections/ })).toHaveCount(0);
  }

  // Still signed in: their vault opens without asking for the master password.
  await poc.goto("/#/vault");
  await expect(poc.getByRole("textbox", { name: /^Master password/ })).toHaveCount(0);
  await expect(poc).toHaveTitle(/^Items/);
  expect(refused).toEqual([]);

  await Promise.all([owner.context().close(), poc.context().close()]);
});

test("a client's custom role that only views event logs opens the event log and sees who acted", async ({
  browser,
}, testInfo) => {
  test.setTimeout(150_000);
  const viewerContext = await browser.newContext();
  const viewer = await viewerContext.newPage();
  const viewerUser = webUserFor("log-viewer", testInfo.repeatEachIndex);
  await signUp(viewer, viewerUser);

  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const adminUser = webUserFor("events-admin", testInfo.repeatEachIndex);
  await signUpWithAuthenticator(admin, adminUser);
  await admin.goto("/#/msp");
  await admin.getByRole("textbox", { name: "Your MSP's name" }).fill("Events IT");
  await admin.getByRole("button", { name: "Create MSP" }).click();
  await admin.getByRole("textbox", { name: "New client's name" }).fill("Northwind Dental");
  await admin.getByRole("button", { name: "Add client" }).click();
  await admin.getByTestId("msp-client-Northwind Dental").getByRole("link", { name: "Admin console" }).click();
  await expect(admin).toHaveURL(/#\/organizations\/[^/]+\/members/);
  const orgUrl = admin.url().replace(/\/members.*$/, "");

  // The MSP admin invites them with a Custom role: view event logs only.
  await admin.getByRole("button", { name: "Invite member" }).click();
  const invite = admin.getByRole("dialog", { name: /Invite member/ });
  await invite.getByRole("textbox", { name: /Email/ }).fill(viewerUser.email);
  await chooseRole(invite, "Custom");
  await invite.getByRole("checkbox", { name: /event logs/i }).check();
  await invite.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(invite).toBeHidden();
  await admin.goto("/#/msp");
  await expect(toast(admin, "Confirmed 1 member")).toBeVisible();

  // They open the organization and land on its event log, which names the
  // MSP admin who invited them.
  await reloadVault(viewer);
  const refused = refusedCalls(viewer);
  await viewer.goto(orgUrl);
  await expect(viewer).toHaveURL(/#\/organizations\/[^/]+\/reporting\/events/);
  await expect(
    viewer.getByRole("row").filter({ hasText: adminUser.name }).first(),
  ).toBeVisible();
  await expect(viewer.getByRole("link", { name: "Members" })).toHaveCount(0);

  // Nothing they opened was refused, so they were never signed out.
  await expect(viewer).toHaveURL(/#\/organizations\/[^/]+\/reporting\/events/);
  expect(refused).toEqual([]);

  await viewerContext.close();
  await adminContext.close();
});

test("a custom role that manages members and views event logs opens a member's event log from the Members page", async ({
  browser,
}, testInfo) => {
  test.setTimeout(150_000);
  const pocContext = await browser.newContext();
  const poc = await pocContext.newPage();
  const pocUser = webUserFor("poc-both", testInfo.repeatEachIndex);
  await signUpWithAuthenticator(poc, pocUser);

  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await signUpWithAuthenticator(admin, webUserFor("both-admin", testInfo.repeatEachIndex));
  await admin.goto("/#/msp");
  await admin.getByRole("textbox", { name: "Your MSP's name" }).fill("Both IT");
  await admin.getByRole("button", { name: "Create MSP" }).click();
  await admin.getByRole("textbox", { name: "New client's name" }).fill("Tailspin Dental");
  await admin.getByRole("button", { name: "Add client" }).click();
  await admin.getByTestId("msp-client-Tailspin Dental").getByRole("link", { name: "Admin console" }).click();
  await expect(admin).toHaveURL(/#\/organizations\/[^/]+\/members/);
  const orgUrl = admin.url().replace(/\/members.*$/, "");

  // The MSP admin invites them with a Custom role: manage users and view
  // event logs.
  await admin.getByRole("button", { name: "Invite member" }).click();
  const invite = admin.getByRole("dialog", { name: /Invite member/ });
  await invite.getByRole("textbox", { name: /Email/ }).fill(pocUser.email);
  await chooseRole(invite, "Custom");
  await invite.getByRole("checkbox", { name: "Manage users" }).check();
  await invite.getByRole("checkbox", { name: /event logs/i }).check();
  await invite.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(invite).toBeHidden();
  await acceptRole(poc);
  await admin.goto("/#/msp");
  await expect(toast(admin, "Confirmed 1 member")).toBeVisible();

  // On the Members page, a member's Options menu offers their event log, and
  // it opens.
  await reloadVault(poc);
  const refused = refusedCalls(poc);
  await poc.goto(orgUrl);
  await expect(poc).toHaveURL(/#\/organizations\/[^/]+\/members/);
  const ownRow = poc.getByRole("row").filter({ hasText: pocUser.email });
  await ownRow.getByRole("button", { name: "Options" }).click();
  await poc.getByRole("menuitem", { name: "Event logs" }).click();
  const events = poc.getByRole("dialog", { name: /Event logs/ });
  await expect(events.getByRole("button", { name: "Refresh" })).toBeVisible();
  await poc.keyboard.press("Escape");
  await expect(events).toBeHidden();

  // Nothing they opened was refused, so they were never signed out.
  await expect(poc).toHaveURL(/#\/organizations\/[^/]+\/members/);
  expect(refused).toEqual([]);

  await pocContext.close();
  await adminContext.close();
});
