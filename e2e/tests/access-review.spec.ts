// Who can see what, and what to change when someone leaves (DESIGN.md,
// "Access and offboarding"). A business organization has two shared folders,
// Everyone and Admins, and a group that reaches both but hides passwords. Alex
// gets Everyone directly and joins the group, so they reach Everyone two ways
// and Admins only through the group. The Access page shows the merged
// permissions, and removing Alex lists only the logins whose passwords they
// could see. A custom role that manages members sees only the folders it opens
// itself, and nothing it opens is refused (which would sign it out). Runs on
// the test server with groups turned on.
import { generateKeyPairSync } from "node:crypto";

import { type APIRequestContext, expect, test, type Page } from "@playwright/test";

import { groupsServerPort } from "../paths.mjs";

import { Api } from "./api/support";
import { confirmMember, reloadVault, signUp, webUserFor } from "./support/web";

test.use({ baseURL: `https://127.0.0.1:${groupsServerPort}` });

/** A toast message. Toasts here have no ARIA role, so find them by text. */
const toast = (page: Page, text: string) => page.getByText(text, { exact: true });

/**
 * The web vault's own access token, from its latest API request, for the
 * setup that needs no keys: a group and an invitation.
 */
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
  await page.goto(`${org}/vault`);
  await page.getByRole("button", { name, exact: true }).first().click();
  await expect(page).toHaveURL(/collectionId=[0-9a-f-]{36}/);
  return /collectionId=([0-9a-f-]{36})/.exec(page.url())![1];
}

/** Adds an item to the shared folder picked in the admin console's vault. */
async function addItem(page: Page, kind: "Login" | "Note", name: string) {
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: kind }).click();
  const item = page.getByRole("dialog", { name: `New ${kind}` });
  await item.getByRole("textbox", { name: /Item name/ }).fill(name);
  if (kind === "Login") {
    await item.getByRole("textbox", { name: "Username", exact: true }).fill("frontdesk@harbor.test");
    await item.getByRole("textbox", { name: "Password", exact: true }).fill(`${name} 2026!`);
  }
  await item.getByRole("button", { name: "Save" }).click();
  await expect(item).toBeHidden();
  // Saving opens the item's view; close it.
  await page.getByRole("dialog", { name: `View ${kind}` }).getByRole("button", { name: "Close" }).first().click();
}

/** A real public key, since confirming someone encrypts the organization's key to it. */
function publicKey() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  }).publicKey.toString("base64");
}

/**
 * Harbor Dental: a business organization, which comes with the Everyone and
 * Admins shared folders, two logins and a note, and the Front office group,
 * which reaches both folders without passwords. Alex can edit Everyone
 * directly and is in the group.
 */
async function harborDental(page: Page, request: APIRequestContext) {
  const auth = tokenOf(page);
  await page.goto("/#/create-organization");
  await page.getByRole("textbox", { name: /Organization name/ }).fill("Harbor Dental");
  await page.getByRole("radio", { name: /A business/ }).check();
  await page.getByRole("button", { name: "Create organization" }).click();
  await page.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  const org = page.url().replace(/\/members.*$/, "");
  const orgId = /organizations\/([0-9a-f-]{36})/.exec(org)![1];

  const everyone = await openFolder(page, org, "Everyone");
  await addItem(page, "Login", "Front desk PC");
  await addItem(page, "Note", "Door codes");
  const admins = await openFolder(page, org, "Admins");
  await addItem(page, "Login", "Payroll portal");

  const api = new Api(request);
  const group = await api.call(auth(), "POST", `/api/organizations/${orgId}/groups`, {
    name: "Front office",
    accessAll: false,
    externalId: null,
    users: [],
    collections: [everyone, admins].map((id) => ({
      id,
      readOnly: true,
      hidePasswords: true,
      manage: false,
    })),
  });
  expect(group.status, JSON.stringify(group.body)).toBe(200);

  /** Invites someone with a role (2: user, 4: custom), folders, and groups. */
  const invite = async (email: string, type: number, extra: object) => {
    const invited = await api.call(auth(), "POST", `/api/organizations/${orgId}/users/invite`, {
      emails: [email],
      type,
      accessSecretsManager: false,
      permissions: {},
      collections: [],
      groups: [],
      ...extra,
    });
    expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  };

  const alex = await api.account(
    "Alex Rivera",
    `alex.rivera-${Date.now()}@api.example.test`,
    publicKey(),
  );
  await invite(alex.email, 2, {
    collections: [{ id: everyone, readOnly: false, hidePasswords: false, manage: false }],
    groups: [group.body.id],
  });
  await page.goto(`${org}/members`);
  await confirmMember(page, alex.email);
  return { org, everyone, alex, invite };
}

test("the Access page shows who reaches each shared folder and how, and removing someone lists the passwords they could see", async ({
  browser,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await context.newPage();
  const owner = webUserFor("access-owner", testInfo.repeatEachIndex);
  await signUp(page, owner);
  const { alex } = await harborDental(page, request);

  // By person: Everyone two ways, the more open one winning; Admins through
  // the group, without passwords. The owner sees every item.
  await page.getByRole("link", { name: "Access", exact: true }).click();
  await expect(page).toHaveURL(/\/access$/);
  const person = (email: string) =>
    page.locator(`[data-testid="access-person"][data-email="${email}"]`);
  const folder = (email: string, name: string) =>
    person(email).locator(`[data-testid="access-folder"][data-folder="${name}"]`);
  await expect(folder(alex.email, "Everyone").getByTestId("access-level")).toHaveText("Can edit");
  await expect(folder(alex.email, "Everyone").getByTestId("access-how")).toHaveText(
    "Directly (Can edit); Through Front office (Can view but not see passwords)",
  );
  await expect(folder(alex.email, "Admins").getByTestId("access-level")).toHaveText(
    "Can view but not see passwords",
  );
  await expect(folder(alex.email, "Admins").getByTestId("access-how")).toHaveText(
    "Through Front office",
  );
  await expect(person(owner.email).getByTestId("access-every-item")).toHaveText("Every item");

  // Expanding Alex shows how many items each folder holds.
  await person(alex.email).getByRole("button", { name: "Show item counts for Alex Rivera" }).click();
  await expect(folder(alex.email, "Everyone").getByTestId("access-items")).toHaveText("2 items");
  await expect(folder(alex.email, "Admins").getByTestId("access-items")).toHaveText("1 item");
  await expect(person(alex.email).getByTestId("access-total")).toHaveText(
    "2 shared folders, 3 items",
  );

  // By shared folder: everyone who reaches Admins, and the owner, who sees every item.
  await page.getByText("By shared folder", { exact: true }).click();
  const adminsFolder = page.locator('[data-testid="access-shared-folder"][data-folder="Admins"]');
  const alexInAdmins = adminsFolder.locator(
    `[data-testid="access-folder-person"][data-email="${alex.email}"]`,
  );
  await expect(alexInAdmins.getByTestId("access-level")).toHaveText(
    "Can view but not see passwords",
  );
  await expect(alexInAdmins.getByTestId("access-how")).toHaveText("Through Front office");
  await expect(adminsFolder.getByTestId("access-every-item-people")).toHaveText(
    `Also open to everyone who sees every item: ${owner.name} (Owner).`,
  );

  // The search narrows it down.
  await page.getByPlaceholder("Search people, groups, and shared folders").fill("everyone");
  await expect(adminsFolder).toHaveCount(0);
  await expect(
    page.locator('[data-testid="access-shared-folder"][data-folder="Everyone"]'),
  ).toBeVisible();

  // Removing Alex says what they can open first. The list shows only Alex,
  // so a reload just after the page opens (see confirmMember) can't put
  // another member's actions under the open menu.
  await page.getByRole("link", { name: "Members", exact: true }).click();
  await page.getByPlaceholder("Search members").fill(alex.email);
  await expect(page.getByRole("row").filter({ hasText: owner.email })).toHaveCount(0);
  const row = page.getByRole("row").filter({ hasText: alex.email });
  await row.getByRole("button", { name: "Options" }).click();
  await page.getByRole("menuitem", { name: "Remove" }).click();
  const confirm = page.getByRole("dialog").filter({ hasText: "Remove Alex Rivera access" });
  await expect(confirm).toContainText("Alex Rivera can open 2 shared folders with 3 items.");
  await confirm.getByRole("button", { name: "Yes" }).click();
  await expect(toast(page, "Removed user Alex Rivera.")).toBeVisible();

  // Then the logins whose passwords they could see: the one in Everyone. Not
  // Payroll portal, whose folder hid passwords from them every way, and not
  // the note.
  const seen = page.getByRole("dialog", { name: "Passwords Alex Rivera could see" });
  const logins = seen.getByTestId("seen-password");
  await expect(logins).toHaveCount(1);
  await expect(logins.first()).toHaveAttribute("data-name", "Front desk PC");
  await expect(logins.first().getByTestId("seen-password-folders")).toHaveText("Everyone");
  await expect(seen).not.toContainText("Payroll portal");
  await expect(seen).not.toContainText("Door codes");
  await expect(seen).toContainText("This list won't be shown again");

  // Copy list: names and folders, never a username or password.
  await seen.getByRole("button", { name: "Copy list" }).click();
  await expect(toast(page, "Copied the list")).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe("Name\tShared folders\nFront desk PC\tEveryone\n");

  // Open shows the item over the list, which stays open to work through.
  await seen.getByRole("button", { name: "Open Front desk PC" }).click();
  const view = page.getByRole("dialog", { name: "View Login" });
  await expect(view.getByRole("textbox", { name: "Username" })).toHaveValue("frontdesk@harbor.test");
  await view.getByRole("button", { name: "Close" }).first().click();
  await expect(view).toBeHidden();
  await expect(seen).toBeVisible();
  await seen.getByRole("button", { name: "Done" }).click();
  await expect(seen).toBeHidden();

  await context.close();
});

test("a custom role that manages members sees the shared folders it opens itself, and nothing it opens is refused", async ({
  browser,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const pocContext = await browser.newContext();
  const poc = await pocContext.newPage();
  const pocUser = webUserFor("access-poc", testInfo.repeatEachIndex);
  await signUp(poc, pocUser);

  const ownerContext = await browser.newContext();
  const page = await ownerContext.newPage();
  await signUp(page, webUserFor("access-owner-2", testInfo.repeatEachIndex));
  const { org, everyone, alex, invite } = await harborDental(page, request);

  // The point of contact manages members, and can view Everyone.
  await invite(pocUser.email, 4, {
    permissions: { manageUsers: true },
    collections: [{ id: everyone, readOnly: true, hidePasswords: false, manage: false }],
  });
  await page.goto("/#/vault");
  await page.goto(`${org}/members`);
  await confirmMember(page, pocUser.email);

  // Reloading syncs the vault, so it has Everyone's items.
  await poc.goto("/#/vault");
  await reloadVault(poc);
  await expect(poc.getByText("Front desk PC").first()).toBeVisible();

  const refused: string[] = [];
  poc.on("response", (response) => {
    if ([401, 403].includes(response.status()) && response.url().includes("/api/")) {
      refused.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
  await poc.goto(`${org}/access`);
  const alexRow = poc.locator(`[data-testid="access-person"][data-email="${alex.email}"]`);
  const alexEveryone = alexRow.locator('[data-testid="access-folder"][data-folder="Everyone"]');
  // Groups aren't theirs to list, so the group goes unnamed.
  await expect(alexEveryone.getByTestId("access-how")).toHaveText(
    "Directly (Can edit); Through a group (Can view but not see passwords)",
  );
  await expect(alexRow.locator('[data-testid="access-folder"][data-folder="Admins"]')).toHaveCount(0);
  await expect(poc.getByTestId("access-hidden-folders")).toContainText(
    "1 shared folder isn't shown, since you can't open it yourself.",
  );
  await alexRow.getByRole("button", { name: "Show item counts for Alex Rivera" }).click();
  await expect(alexEveryone.getByTestId("access-items")).toHaveText("2 items");

  await expect(poc).toHaveURL(/\/access$/);
  expect(refused).toEqual([]);

  await pocContext.close();
  await ownerContext.close();
});
