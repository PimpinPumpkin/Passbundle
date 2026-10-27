// A shared folder's permissions in the browser extension (DESIGN.md,
// "Folders and permissions"). An owner makes a business organization with a
// login (password, one-time code, and a hidden field), a card, and an
// identity (SSN, passport and license numbers) in its Everyone folder, and a
// login in its Admins folder, and gives Dana:
// Everyone as "Can view but not see passwords", and Admins as Custom (see
// passwords, create, edit, delete, and view item history, without share).
// Dana's extension then lists her folders by owner with counts; can't
// reveal, copy, or drag any secret of the Everyone items, in their pages,
// the list, the right-click menu, password history, or version history
// (dates and who only, without Clear); can't move the Admins login out of
// its folder, which says why; and gets Clear there, where she has view item
// history and delete. Her web vault hides the identity's numbers too: one
// rule for what see passwords covers, everywhere. Neither will copy an item
// she can't see the passwords of, even by its address. Runs on the test
// server with groups turned on.
import type { Browser, Locator, Page } from "@playwright/test";

import { groupsServerPort } from "../paths.mjs";

import {
  createAccount,
  expect,
  logInPopup,
  openPopup,
  test,
  userFor,
} from "./support/extension";
import { confirmMember, menu, signUpWithAuthenticator, webUserFor } from "./support/web";

const server = `https://127.0.0.1:${groupsServerPort}`;

/** Saving an item in the admin console opens its view: close it. */
async function closeView(page: Page) {
  const view = page.getByRole("dialog", { name: /^View/ });
  await view.getByRole("button", { name: "Close" }).first().click();
  await expect(view).toBeHidden();
}

/** Shows one of the organization's shared folders in the admin console. */
async function showFolder(owner: Page, org: string, name: string) {
  await owner.goto(`${org}/vault`);
  await owner.getByRole("button", { name, exact: true }).first().click();
  await expect(owner).toHaveURL(/collectionId=[0-9a-f-]{36}/);
}

/** Starts a new item of a kind in the shared folder showing. */
async function newOrgItem(owner: Page, kind: string) {
  await owner.getByRole("button", { name: "New", exact: true }).click();
  await owner.getByRole("menuitem", { name: kind }).click();
  return owner.getByRole("dialog", { name: `New ${kind}` });
}

/** Changes a login's password in the admin console, so it has an earlier version. */
async function changeOrgPassword(owner: Page, name: string, password: string) {
  await owner.getByRole("row").filter({ hasText: name }).getByText(name, { exact: true }).click();
  const view = owner.getByRole("dialog", { name: "View Login" });
  await view.getByRole("button", { name: "Edit" }).click();
  const edit = owner.getByRole("dialog", { name: /Edit Login/ });
  await edit.getByRole("textbox", { name: "Password", exact: true }).fill(password);
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  await closeView(owner);
}

/**
 * Gives someone access to the shared folder showing: a preset, or Custom,
 * which starts from Can view, with capabilities checked and unchecked.
 */
async function grant(
  owner: Page,
  email: string,
  preset: string,
  custom: { check?: string[]; uncheck?: string[] } = {},
) {
  await owner.getByRole("button", { name: "Edit shared folder" }).click();
  await owner.getByRole("menuitem", { name: "Access" }).click();
  const access = owner.getByRole("dialog", { name: /Edit shared folder/ });
  await access.getByRole("combobox", { name: /Select groups and members/ }).click();
  await owner.keyboard.type(email.split("@")[0]);
  await owner.getByRole("option", { name: new RegExp(email) }).click();
  // Closing the list adds who was picked.
  await access.getByText(/Grant groups or members access/).click();
  const personRow = access.getByRole("row").filter({ hasText: email });
  await expect(personRow).toBeVisible();
  await personRow.getByRole("combobox").click();
  await owner.getByRole("option", { name: preset, exact: true }).click();
  const grid = access.getByTestId("keykeeper-folder-grid");
  for (const name of custom.check ?? []) {
    await grid.getByRole("checkbox", { name, exact: true }).check();
  }
  for (const name of custom.uncheck ?? []) {
    await grid.getByRole("checkbox", { name, exact: true }).uncheck();
  }
  await access.getByRole("button", { name: "Save" }).click();
  await expect(access).toBeHidden();
}

/** The owner's organization, with Dana in it and the items above. */
async function setUpOrganization(
  browser: Browser,
  danaEmail: string,
  ownerUser: ReturnType<typeof webUserFor>,
) {
  const ownerContext = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: server });
  const owner = await ownerContext.newPage();
  // A business's owner signs in with two-step login (DESIGN.md, "Two-step
  // login for admins").
  await signUpWithAuthenticator(owner, ownerUser);

  await owner.goto("/#/create-organization");
  await owner.getByRole("textbox", { name: /Organization name/ }).fill("Lakeside Clinic");
  await owner.getByRole("radio", { name: /A business/ }).check();
  await owner.getByRole("button", { name: "Create organization" }).click();
  await owner.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  const org = owner.url().replace(/\/members.*$/, "");

  await owner.getByRole("button", { name: "Invite member" }).click();
  const invite = owner.getByRole("dialog", { name: /Invite member/ });
  await invite.getByRole("textbox", { name: /Email/ }).fill(danaEmail);
  await invite.getByRole("button", { name: "Save" }).click();
  await expect(invite).toBeHidden();
  await confirmMember(owner, danaEmail);

  // Everyone: a login with a one-time code and a hidden field, changed once,
  // and a card.
  await showFolder(owner, org, "Everyone");
  const wifi = await newOrgItem(owner, "Login");
  await wifi.getByRole("textbox", { name: /Item name/ }).fill("Clinic Wi-Fi");
  await wifi.getByRole("textbox", { name: "Username", exact: true }).fill("frontdesk");
  await wifi.getByRole("textbox", { name: "Password", exact: true }).fill("lakeside-guest-2026");
  await wifi.getByRole("textbox", { name: /Authenticator key/ }).fill("JBSWY3DPEHPK3PXP");
  await wifi.getByRole("button", { name: "Add field" }).click();
  const addField = owner.getByRole("dialog", { name: "Add field" });
  await addField.getByRole("combobox", { name: /Field type/ }).click();
  await owner.getByRole("option", { name: "Hidden", exact: true }).click();
  await addField.getByRole("textbox", { name: /Field label/ }).fill("Router PIN");
  await addField.getByRole("button", { name: "Add", exact: true }).click();
  await expect(addField).toBeHidden();
  await wifi.getByRole("textbox", { name: "Router PIN", exact: true }).fill("4421-8830");
  await wifi.getByRole("button", { name: "Save" }).click();
  await expect(wifi).toBeHidden();
  await closeView(owner);
  await changeOrgPassword(owner, "Clinic Wi-Fi", "lakeside-guest-2027");

  const card = await newOrgItem(owner, "Card");
  await card.getByRole("textbox", { name: /Item name/ }).fill("Clinic Visa");
  await card.getByRole("textbox", { name: "Cardholder name" }).fill("Lakeside Clinic");
  await card.getByRole("textbox", { name: "Number" }).fill("4242424242424242");
  await card.getByRole("textbox", { name: "Security code" }).fill("987");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card).toBeHidden();
  await closeView(owner);

  const identity = await newOrgItem(owner, "Identity");
  await identity.getByRole("textbox", { name: /Item name/ }).fill("Clinic manager");
  await identity.getByRole("textbox", { name: "First name" }).fill("Pat");
  await identity.getByRole("textbox", { name: "Social Security number" }).fill("078-05-1120");
  await identity.getByRole("textbox", { name: "Passport number" }).fill("P1234567");
  await identity.getByRole("textbox", { name: "License number" }).fill("D7654321");
  await identity.getByRole("button", { name: "Save" }).click();
  await expect(identity).toBeHidden();
  await closeView(owner);
  await grant(owner, danaEmail, "Can view but not see passwords");

  // Admins: a login, changed once.
  await showFolder(owner, org, "Admins");
  const pc = await newOrgItem(owner, "Login");
  await pc.getByRole("textbox", { name: /Item name/ }).fill("Front desk PC");
  await pc.getByRole("textbox", { name: "Username", exact: true }).fill("reception");
  await pc.getByRole("textbox", { name: "Password", exact: true }).fill("front-desk-pc-1");
  await pc.getByRole("button", { name: "Save" }).click();
  await expect(pc).toBeHidden();
  await closeView(owner);
  await changeOrgPassword(owner, "Front desk PC", "front-desk-pc-2");
  await grant(owner, danaEmail, "Custom", {
    check: ["Create items", "Edit items", "Delete items"],
    uncheck: ["Print"],
  });
  return ownerContext;
}

/** The history page and the item page: the popup can hold the page it left for a moment. */
const historyPage = (popup: Page) => popup.locator("app-keykeeper-item-history-page");
const itemPage = (popup: Page) => popup.locator("app-view");

/** The popup's All items row for an item. */
const row = (popup: Page, name: string) =>
  popup.locator("#allItems bit-item").filter({ hasText: name });

async function openItem(popup: Page, name: string) {
  await row(popup, name).getByText(name, { exact: true }).click();
  await expect(popup.getByRole("heading", { level: 1, name })).toBeVisible();
  return new URL(popup.url().replace("#/", "")).searchParams.get("cipherId")!;
}

const CANT_COPY = "Your organization doesn't let you copy this item.";

const SECRETS = [
  "lakeside-guest-2026",
  "lakeside-guest-2027",
  "JBSWY3DPEHPK3PXP",
  "4421-8830",
  "4242424242424242",
  "987",
  "078-05-1120",
  "P1234567",
  "D7654321",
];

/** An identity's page: its SSN, passport and license numbers masked, nothing to show or copy. */
async function expectIdentityHidden(page: Page, view: Locator) {
  await expect(view.getByTestId("name")).toHaveValue(/Pat/);
  for (const id of ["ssn", "passport", "license"]) {
    await expect(view.getByTestId(id)).toHaveValue("••••••••");
  }
  for (const id of ["ssn-toggle", "copy-ssn", "passport-toggle", "copy-passport", "copy-license"]) {
    await expect(view.getByTestId(id)).toHaveCount(0);
  }
  await expectNoSecrets(page);
}

/** Everything the page holds: its text, every field's value, and what each label drags. */
async function pageHolds(popup: Page): Promise<string> {
  return popup.evaluate(() => {
    const values = [...document.querySelectorAll("input, textarea")].map(
      (i) => (i as HTMLInputElement).value,
    );
    return [document.body.innerText, ...values].join("\n");
  });
}

async function expectNoSecrets(popup: Page) {
  const held = await pageHolds(popup);
  for (const secret of SECRETS) {
    expect(held).not.toContain(secret);
  }
}

test("a member who can't see passwords can't reveal or copy them in the extension, can't move an item without share, and gets Clear only where allowed", async ({
  browser,
  context,
  extensionId,
}, testInfo) => {
  test.setTimeout(360_000);
  const dana = userFor("ext-grid-dana", testInfo.repeatEachIndex);
  const signup = await createAccount(context, dana, server);
  await signup.close();
  const ownerContext = await setUpOrganization(
    browser,
    dana.email,
    webUserFor("ext-grid-owner", testInfo.repeatEachIndex),
  );

  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, dana, server);
  const vaultUrl = popup.url();

  // Her folders by owner, with how many items each shows.
  await popup.getByTestId("keykeeper-folder-filter").click();
  const places = popup.getByTestId("keykeeper-place");
  await expect(places).toHaveText([
    /All folders/,
    /Personal\s*0/,
    /Lakeside Clinic\s*4/,
    /Admins\s*1/,
    /Everyone\s*3/,
  ]);
  await places.filter({ hasText: "Everyone" }).click();
  await expect(popup.getByTestId("keykeeper-picked-place")).toHaveText(
    /Lakeside Clinic · Everyone/,
  );
  await expect(row(popup, "Front desk PC")).toHaveCount(0);
  await expect(row(popup, "Clinic Wi-Fi")).toBeVisible();

  // The list offers to copy the username, never the password or the code.
  await expect(
    row(popup, "Clinic Wi-Fi").getByRole("button", { name: /password|verification code/i }),
  ).toHaveCount(0);
  await popup.getByTestId("keykeeper-picked-place").getByRole("button").click();
  await expect(row(popup, "Front desk PC")).toBeVisible();

  // The login's page: nothing to show, copy, or drag.
  const wifiId = await openItem(popup, "Clinic Wi-Fi");
  await expect(popup.getByTestId("toggle-password")).toHaveCount(0);
  await expect(popup.getByTestId("copy-password")).toHaveCount(0);
  await expect(popup.getByTestId("copy-totp")).toHaveCount(0);
  await expect(popup.getByTestId("login-totp")).toHaveValue("*** ***");
  await expect(
    popup.getByTestId("custom-field").getByRole("button", { name: /Copy|Toggle/i }),
  ).toHaveCount(0);
  await expect(popup.getByRole("button", { name: "Password history" })).toHaveCount(0);
  await expectNoSecrets(popup);
  // Dragging the password's label drags nothing.
  const dragged = await popup.evaluate(() => {
    const label = document.getElementById("password-label")!;
    const data = new DataTransfer();
    label.dispatchEvent(new DragEvent("dragstart", { dataTransfer: data, bubbles: true }));
    return data.getData("text");
  });
  expect(dragged).toBe("");

  // Its version history: when and by whom only, nothing to open, no Clear.
  await popup.getByTestId("keykeeper-version-history").click();
  await expect(popup.getByTestId("keykeeper-versions-who")).toHaveText(
    "You can't see this item's passwords, so its earlier versions show only when they were saved and by whom.",
  );
  const versions = popup.getByTestId("keykeeper-item-version");
  await expect(versions).toHaveCount(1);
  await expect(versions.first()).toContainText("Saved by another member");
  await expect(versions.first().getByRole("button")).toHaveCount(0);
  await expect(popup.getByRole("button", { name: "Clear history" })).toHaveCount(0);
  await expectNoSecrets(popup);

  // Its password history, even by its address: nothing. (Going to an address
  // starts the popup again, which takes a moment.)
  await popup.goto(vaultUrl.replace(/#.*$/, `#/cipher-password-history?cipherId=${wifiId}`));
  await expect(popup.getByText("There are no passwords to list.")).toBeVisible({
    timeout: 30_000,
  });
  await expectNoSecrets(popup);

  // The right-click menu copies the username, never the password or the code.
  const worker = context.serviceWorkers()[0];
  const copied = await worker.evaluate(async (id) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const main = (self as any).bitwardenMain;
    const copies: string[] = [];
    const original = main.platformUtilsService.copyToClipboard;
    main.platformUtilsService.copyToClipboard = (text: string) => copies.push(text);
    const handler = main.contextMenusBackground.contextMenuClickedHandler;
    const tab = { id: 1, url: "https://clinic.example.test/" };
    try {
      for (const parent of ["copy-password", "copy-totp", "copy-username"]) {
        await handler.cipherAction(
          { menuItemId: `${parent}_${id}`, parentMenuItemId: parent, editable: false },
          tab,
        );
      }
    } finally {
      main.platformUtilsService.copyToClipboard = original;
    }
    return copies;
  }, wifiId);
  expect(copied).toEqual(["frontdesk"]);

  // The card: not even its last digits in the list, its number and code
  // masked on its page, nothing to show or copy.
  await popup.goto(vaultUrl);
  await expect(row(popup, "Clinic Visa")).toBeVisible({ timeout: 30_000 });
  await expect(row(popup, "Clinic Visa")).not.toContainText("4242");
  await openItem(popup, "Clinic Visa");
  await expect(popup.getByTestId("cardholder-number")).toHaveValue("••••••••");
  await expect(popup.getByTestId("toggle-number")).toHaveCount(0);
  await expect(popup.getByTestId("copy-number")).toHaveCount(0);
  await expect(popup.getByTestId("copy-code")).toHaveCount(0);
  await expectNoSecrets(popup);
  await itemPage(popup).getByRole("button", { name: "Back" }).click();

  // The identity: the plain values stay, the numbers don't.
  await openItem(popup, "Clinic manager");
  await expectIdentityHidden(popup, itemPage(popup));
  await itemPage(popup).getByRole("button", { name: "Back" }).click();

  // Copying the login by its address, as Clone would (which isn't offered):
  // refused, and the form never opens.
  await popup.goto(
    vaultUrl.replace(/#.*$/, `#/clone-cipher?clone=true&cipherId=${wifiId}&type=1`),
  );
  await expect(popup.getByText(CANT_COPY)).toBeVisible({ timeout: 30_000 });
  await expect(popup.locator("app-add-edit")).toHaveCount(0);
  await expectNoSecrets(popup);
  await popup.goto(vaultUrl);
  await expect(row(popup, "Front desk PC")).toBeVisible({ timeout: 30_000 });

  // The Admins login: without share, it can't move to another shared folder,
  // and the picker says why; nor is it offered to add to one.
  await openItem(popup, "Front desk PC");
  await popup.getByTestId("keykeeper-edit").click();
  await expect(popup.getByTestId("keykeeper-cant-move")).toHaveText(
    "Your organization doesn't let you move it to another shared folder.",
  );
  await expect(popup.getByTestId("keykeeper-folder-picker").locator("ng-select")).toHaveClass(
    /ng-select-disabled/,
  );
  await popup.locator("app-add-edit").getByRole("button", { name: "Back" }).click();
  await itemPage(popup).getByRole("button", { name: "Back" }).click();
  await expect(itemPage(popup)).toHaveCount(0);
  // More shows under the pointer.
  await row(popup, "Front desk PC").hover();
  await row(popup, "Front desk PC").getByRole("button", { name: "More options" }).click();
  await expect(popup.getByRole("menuitem", { name: "Edit" })).toBeVisible();
  await expect(popup.getByRole("menuitem", { name: /Add to shared folder/ })).toHaveCount(0);
  await expect(popup.getByRole("menuitem", { name: "Clone" })).toHaveCount(0);
  await popup.keyboard.press("Escape");

  // Its history: she has view item history, see passwords, and delete in
  // Admins, so she can open a version and clear them.
  await openItem(popup, "Front desk PC");
  await popup.getByTestId("keykeeper-version-history").click();
  await expect(versions).toHaveCount(1);
  await versions.first().getByRole("button").click();
  await popup.getByRole("button", { name: "Show hidden values" }).click();
  await expect(popup.getByRole("row", { name: /Password/ }).getByRole("cell").nth(0)).toHaveText(
    "front-desk-pc-1",
  );
  await expect(popup.getByRole("button", { name: "Delete this version" })).toBeVisible();
  await historyPage(popup).getByRole("button", { name: "Back" }).click();
  await popup.getByRole("button", { name: "Clear history" }).click();
  await popup
    .getByRole("dialog", { name: "Clear this item's history?" })
    .getByRole("button", { name: "Clear history" })
    .click();
  await expect(popup.getByText("History cleared", { exact: true })).toBeVisible();
  await expect(popup.getByTestId("keykeeper-no-versions")).toBeVisible();

  // Her web vault hides the same values: the identity's numbers masked, with
  // nothing to show or copy. (A new tab opens logged out or locked.)
  const web = await context.newPage();
  await web.goto(`${server}/#/vault`);
  const email = web.getByLabel(/Email address/);
  const password = web.getByRole("textbox", { name: /^Master password/ });
  const folders = menu(web).getByRole("group", { name: "Folders" });
  await expect(email.or(password).or(folders)).toBeVisible({ timeout: 30_000 });
  if (await email.isVisible()) {
    await email.fill(dana.email);
    await web.getByRole("button", { name: "Continue" }).click();
  }
  if (!(await folders.isVisible())) {
    await password.fill(dana.password);
    await web.getByRole("button", { name: /^(Log in|Unlock)$/ }).click();
  }
  await expect(folders).toBeVisible({ timeout: 30_000 });
  await folders.getByRole("button", { name: "Everyone", exact: true }).click();
  await web
    .getByRole("row")
    .filter({ hasText: "Clinic manager" })
    .getByText("Clinic manager", { exact: true })
    .click();
  const view = web.getByRole("dialog", { name: "View Identity" });
  await expect(view).toBeVisible();
  await expectIdentityHidden(web, view);
  await view.getByRole("button", { name: "Close" }).first().click();

  // Copying the login by its address in the web vault, opened fresh (as a
  // link would be): refused, and no copy opens. (The address opens the item
  // too, as upstream does, for her only to look at.)
  await web.goto(`${server}/#/vault?itemId=${wifiId}&action=clone`);
  await web.reload();
  const refused = web.getByText(CANT_COPY);
  await expect(refused.or(password)).toBeVisible({ timeout: 30_000 });
  if (await password.isVisible()) {
    await password.fill(dana.password);
    await web.getByRole("button", { name: /^(Log in|Unlock)$/ }).click();
  }
  await expect(refused).toBeVisible({ timeout: 30_000 });
  await expect(web.getByRole("dialog", { name: /^New/ })).toHaveCount(0);

  await ownerContext.close();
});
