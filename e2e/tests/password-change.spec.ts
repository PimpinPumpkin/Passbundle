// Assisted password change (DESIGN.md, "Assisted password change"): Change
// password on a login in the extension changes it on the site. It saves the
// new password first, then fills the site's form and presses its button; it
// hands over for a CAPTCHA or a code; it stops when the page goes to another
// site; the new password follows the site's rules; and when the site refuses
// or it can't tell, the item asks, and one click puts the old password back.
// For an organization's items: only where the person can edit and see their
// passwords, until the organization turns it off, and the change and the old
// password put back are in its event log in their own words.
// Only local test sites (change-password-site.mjs), never a real one.
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";

import { fixturePort } from "../paths.mjs";

import { addLogin } from "./support/autofill";
import {
  createAccount,
  expect,
  logInPopup,
  openPopup,
  serverUrl,
  test,
  userFor,
  type User,
} from "./support/extension";
import {
  realAccount,
  realCollection,
  realLogin,
  realMember,
  realOrganization,
  realPersonalLogin,
} from "./support/vault-crypto";

test.describe.configure({ timeout: 180_000 });

const OLD = "old-site-password-1";
const MARKER = "keykeeper.password-change";
const fixture = `https://127.0.0.1:${fixturePort}`;

/** Sets the test site's password for the account, and forgets what was sent to it. */
async function setSitePassword(
  request: APIRequestContext,
  host: string,
  password: string,
) {
  const answer = await request.post(`${fixture}/cp/state?site=${host}`, {
    data: { password },
    ignoreHTTPSErrors: true,
  });
  expect(answer.status()).toBe(200);
}

/** The test site's password now, and what was sent to it. */
async function siteState(
  request: APIRequestContext,
  host: string,
): Promise<{ password: string; posts: { at: number; ok: boolean }[] }> {
  const answer = await request.get(`${fixture}/cp/state?site=${host}`, {
    ignoreHTTPSErrors: true,
  });
  return answer.json();
}

/** An account with one login for the site, and the extension signed in to it: the popup, in a tab. */
async function setUp(
  context: BrowserContext,
  extensionId: string,
  request: APIRequestContext,
  user: User,
  host: string,
): Promise<{ popup: Page; web: Page }> {
  await setSitePassword(request, host, OLD);
  const web = await createAccount(context, user);
  await addLogin(web, {
    name: host,
    username: "alice",
    password: OLD,
    uri: `https://${host}/login`,
  });
  const view = web.getByRole("dialog", { name: "View Login" });
  await view.getByRole("button", { name: "Close" }).first().click();
  await expect(view).toBeHidden();
  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, user);
  return { popup, web };
}

/** The item as the extension's background has it: its password, password history, and change marker. */
async function itemState(context: BrowserContext, name: string) {
  return context.serviceWorkers()[0].evaluate(
    async ({ name, marker }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const main = (self as any).bitwardenMain;
      const userId = await new Promise<string>((resolve) =>
        main.accountService.activeAccount$.subscribe((a: { id: string }) =>
          resolve(a.id),
        ),
      );
      const ciphers: {
        id: string;
        name: string;
        login: { password: string };
        passwordHistory?: { password: string }[];
        fields?: { name: string; value: string }[];
      }[] = await main.cipherService.getAllDecrypted(userId);
      const item = ciphers.find((c) => c.name === name)!;
      const field = item.fields?.find((f) => f.name === marker)?.value ?? null;
      return {
        id: item.id,
        password: item.login.password,
        history: (item.passwordHistory ?? []).map((h) => h.password),
        marker:
          field == null
            ? null
            : (JSON.parse(field) as { state: string; site: string }),
      };
    },
    { name, marker: MARKER },
  );
}

/** What the change in this browser last said: its note's key, its words, and how it ended. */
async function changeStatus(context: BrowserContext) {
  return context.serviceWorkers()[0].evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const status = (self as any).bitwardenMain.keykeeperPasswordChange.status();
    return status == null
      ? null
      : {
          note: status.note as string,
          text: status.text as string,
          running: status.running as boolean,
          result: status.result as string | undefined,
        };
  });
}

async function syncExtension(context: BrowserContext) {
  await context.serviceWorkers()[0].evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (self as any).bitwardenMain.syncService.fullSync(true);
  });
}

const row = (popup: Page, name: string) =>
  popup.locator("#allItems bit-item").filter({ hasText: name });

/** Opens the login's page in the popup, from its list. */
async function openItem(popup: Page, name: string) {
  await expect(row(popup, name).first()).toBeVisible({ timeout: 30_000 });
  await row(popup, name).first().getByText(name, { exact: true }).click();
  await expect(popup.getByRole("heading", { level: 1, name })).toBeVisible();
}

/**
 * The login's page in a new popup, by its address. Starting a change closes
 * the popup, as opening any tab does, and a popup opened again soon after
 * comes back to the page it showed.
 */
async function itemPage(
  context: BrowserContext,
  extensionId: string,
  id: string,
  name: string,
) {
  const popup = await context.newPage();
  await popup.goto(
    `chrome-extension://${extensionId}/popup/index.html#/view-cipher?cipherId=${id}&type=1`,
  );
  await expect(popup.getByRole("heading", { level: 1, name })).toBeVisible({
    timeout: 30_000,
  });
  return popup;
}

/** Presses Change password on the login's page and confirms; answers with the tab it opened. */
async function startChange(
  context: BrowserContext,
  popup: Page,
  name: string,
  fromList = true,
): Promise<Page> {
  if (fromList) {
    await openItem(popup, name);
  }
  await popup.getByTestId("keykeeper-change-password").click();
  const dialog = popup.getByRole("dialog");
  await expect(dialog).toContainText(`Change the password on ${name}?`);
  const [tab] = await Promise.all([
    context.waitForEvent("page"),
    dialog.getByRole("button", { name: "Change password" }).click(),
  ]);
  return tab;
}

const waitFor = (context: BrowserContext, result: string) =>
  expect
    .poll(async () => (await changeStatus(context))?.result, {
      timeout: 60_000,
    })
    .toBe(result);

test("changes the password on a standard form, saving the new one first", async ({
  context,
  extensionId,
  request,
}, testInfo) => {
  const host = "cp-works.example.test";
  const { popup } = await setUp(
    context,
    extensionId,
    request,
    userFor("cp-works", testInfo.repeatEachIndex),
    host,
  );
  const tab = await startChange(context, popup, host);
  await expect(tab).toHaveURL(`https://${host}/cp/form`);

  await expect
    .poll(async () => (await siteState(request, host)).password, {
      timeout: 60_000,
    })
    .not.toBe(OLD);
  await waitFor(context, "changed");
  const site = await siteState(request, host);
  const item = await itemState(context, host);
  // The site and the item have the same new password; the old one is in password history.
  expect(item.password).toBe(site.password);
  expect(item.password).not.toBe(OLD);
  expect(item.password).toHaveLength(20);
  expect(item.history[0]).toBe(OLD);
  expect(item.marker).toBeNull();
  // One submission, by the button.
  expect(site.posts).toEqual([expect.objectContaining({ ok: true })]);
  await expect(
    tab.getByRole("heading", { name: "Your password has been changed" }),
  ).toBeVisible();
  expect((await changeStatus(context))?.text).toBe(
    "Password changed. The new one is saved in the item.",
  );
});

test("a site that refuses: the item says so, and one click puts the old password back", async ({
  context,
  extensionId,
  request,
}, testInfo) => {
  const host = "cp-refuses.example.test";
  const { popup } = await setUp(
    context,
    extensionId,
    request,
    userFor("cp-refuses", testInfo.repeatEachIndex),
    host,
  );
  const tab = await startChange(context, popup, host);
  await waitFor(context, "refused");
  await expect(tab.getByRole("alert")).toContainText("isn't allowed");

  // The site still has the old password; the item has both.
  expect((await siteState(request, host)).password).toBe(OLD);
  const item = await itemState(context, host);
  expect(item.password).not.toBe(OLD);
  expect(item.history[0]).toBe(OLD);
  expect(item.marker?.state).toBe("refused");

  const page = await itemPage(context, extensionId, item.id, host);
  const card = page.getByTestId("keykeeper-password-change-card");
  await expect(card).toContainText("The site didn't take the new password");
  await expect(card).toContainText(host);
  await card.getByRole("button", { name: "Put the old password back" }).click();
  await expect(card).toBeHidden();

  const after = await itemState(context, host);
  expect(after.password).toBe(OLD);
  expect(after.marker).toBeNull();
  // The new password isn't lost either.
  expect(after.history[0]).toBe(item.password);
});

test("hands over at a CAPTCHA: saved first and filled, and finishes when the person does", async ({
  context,
  extensionId,
  request,
}, testInfo) => {
  const host = "cp-captcha.example.test";
  const { popup } = await setUp(
    context,
    extensionId,
    request,
    userFor("cp-captcha", testInfo.repeatEachIndex),
    host,
  );
  const tab = await startChange(context, popup, host);
  await expect
    .poll(async () => (await changeStatus(context))?.note, { timeout: 60_000 })
    .toBe("handoverCaptcha");

  // Saved before anything was submitted, filled in, and nothing sent to the site.
  const item = await itemState(context, host);
  expect(item.password).not.toBe(OLD);
  expect(item.marker?.state).toBe("pending");
  await expect(tab.getByLabel("Current password")).toHaveValue(OLD);
  await expect(tab.getByLabel("New password", { exact: true })).toHaveValue(
    item.password,
  );
  await expect(tab.getByLabel("Confirm new password")).toHaveValue(
    item.password,
  );
  expect((await siteState(request, host)).posts).toHaveLength(0);
  // It never ticks the box itself.
  await expect(
    tab.getByRole("checkbox", { name: /not a robot/ }),
  ).not.toBeChecked();

  // The person proves they're not a robot and submits.
  await tab.getByRole("checkbox", { name: /not a robot/ }).check();
  await tab.getByRole("button", { name: "Change password" }).click();
  await waitFor(context, "changed");
  expect((await siteState(request, host)).password).toBe(item.password);
  expect((await itemState(context, host)).marker).toBeNull();
});

test("hands over a two-step code, and finishes when the person enters it", async ({
  context,
  extensionId,
  request,
}, testInfo) => {
  const host = "cp-code.example.test";
  const { popup } = await setUp(
    context,
    extensionId,
    request,
    userFor("cp-code", testInfo.repeatEachIndex),
    host,
  );
  const tab = await startChange(context, popup, host);
  await expect
    .poll(async () => (await changeStatus(context))?.note, { timeout: 60_000 })
    .toBe("handoverCode");
  expect((await changeStatus(context))?.text).toContain(
    "The site asks for a code",
  );
  // Nothing is filled into the code field.
  await expect(
    tab.getByLabel("Enter the code we sent to your phone"),
  ).toHaveValue("");

  await tab.getByLabel("Enter the code we sent to your phone").fill("123456");
  await tab.getByRole("button", { name: "Verify" }).click();
  await waitFor(context, "changed");
  const item = await itemState(context, host);
  expect((await siteState(request, host)).password).toBe(item.password);
  expect(item.marker).toBeNull();
});

test("stops when the change-password page goes to another site, changing nothing", async ({
  context,
  extensionId,
  request,
}, testInfo) => {
  const host = "cp-away.example.test";
  const { popup } = await setUp(
    context,
    extensionId,
    request,
    userFor("cp-away", testInfo.repeatEachIndex),
    host,
  );
  const tab = await startChange(context, popup, host);
  await expect(tab).toHaveURL("https://login.elsewhere.test/cp/form");
  await expect
    .poll(async () => (await changeStatus(context))?.note, { timeout: 30_000 })
    .toBe("stopped.elsewhere");

  const item = await itemState(context, host);
  expect(item.password).toBe(OLD);
  expect(item.marker).toBeNull();
  // The other site's form gets nothing.
  await expect(tab.getByLabel("Current password")).toHaveValue("");
  await expect(tab.getByLabel("New password", { exact: true })).toHaveValue("");
});

test("the new password follows the site's published rules", async ({
  context,
  extensionId,
  request,
}, testInfo) => {
  // airfrance.com: 8 to 12 characters, with a lowercase and an uppercase letter and a digit, and only -!#$&+/?@_ besides.
  const host = "www.airfrance.com";
  const { popup } = await setUp(
    context,
    extensionId,
    request,
    userFor("cp-airfrance", testInfo.repeatEachIndex),
    host,
  );
  await startChange(context, popup, host);
  await waitFor(context, "changed");
  const password = (await itemState(context, host)).password;
  expect(password).toMatch(/^[-A-Za-z0-9!#$&+/?@_]{8,12}$/);
  expect(password).toMatch(/[a-z]/);
  expect(password).toMatch(/[A-Z]/);
  expect(password).toMatch(/[0-9]/);
  expect((await siteState(request, host)).password).toBe(password);
});

test("the new password follows the form's own passwordrules, minlength, and maxlength", async ({
  context,
  extensionId,
  request,
}, testInfo) => {
  // The field: 12 to 16 characters, a lowercase letter and a digit, and only - and _ besides.
  const host = "cp-rules.example.test";
  const { popup } = await setUp(
    context,
    extensionId,
    request,
    userFor("cp-rules", testInfo.repeatEachIndex),
    host,
  );
  await startChange(context, popup, host);
  await waitFor(context, "changed");
  const password = (await itemState(context, host)).password;
  expect(password).toMatch(/^[a-z0-9_-]{12,16}$/);
  expect(password).toMatch(/[a-z]/);
  expect(password).toMatch(/[0-9]/);
});

test('asks "Did the new password work?" when it can\'t tell, and takes the answer either way', async ({
  context,
  extensionId,
  request,
}, testInfo) => {
  const host = "cp-unsure.example.test";
  const { popup, web } = await setUp(
    context,
    extensionId,
    request,
    userFor("cp-unsure", testInfo.repeatEachIndex),
    host,
  );

  // First: it can't tell, and the person puts the old password back from the web vault.
  let tab = await startChange(context, popup, host);
  await waitFor(context, "unsure");
  await expect(tab.getByText("Done.")).toBeVisible();
  const first = await itemState(context, host);
  expect(first.marker?.state).toBe("unsure");
  expect((await siteState(request, host)).password).toBe(first.password);

  await web.goto(`${serverUrl}/#/vault`);
  await web.reload();
  await web.getByText(host).first().click();
  const view = web.getByRole("dialog", { name: "View Login" });
  const card = view.getByTestId("keykeeper-password-change-card");
  await expect(card).toContainText("Did the new password work?");
  await card.getByRole("button", { name: "Put the old password back" }).click();
  await expect(card).toBeHidden();
  await syncExtension(context);
  await expect
    .poll(async () => (await itemState(context, host)).password)
    .toBe(OLD);
  expect((await itemState(context, host)).marker).toBeNull();

  // Again, after the site's password goes back too: this time it worked, said in the extension.
  await setSitePassword(request, host, OLD);
  await tab.close();
  tab = await startChange(
    context,
    await itemPage(context, extensionId, first.id, host),
    host,
    false,
  );
  await waitFor(context, "unsure");
  const second = await itemState(context, host);
  expect(second.password).not.toBe(first.password);
  const extensionCard = (
    await itemPage(context, extensionId, second.id, host)
  ).getByTestId("keykeeper-password-change-card");
  await expect(extensionCard).toContainText("Did the new password work?");
  await extensionCard.getByRole("button", { name: "It worked" }).click();
  await expect(extensionCard).toBeHidden();
  const after = await itemState(context, host);
  expect(after.password).toBe(second.password);
  expect(after.marker).toBeNull();
  expect((await siteState(request, host)).password).toBe(after.password);
});

/** The organization's owner in the web vault, in a tab of this browser (the extension stays signed in as someone else). */
async function ownerWebVault(context: BrowserContext, owner: { email: string; password: string }) {
  const page = await context.newPage();
  await page.goto(`${serverUrl}/#/vault`);
  await page.getByRole("textbox", { name: /Email address/ }).fill(owner.email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("textbox", { name: /Master password/ }).fill(owner.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "All items" }).first()).toBeVisible({ timeout: 30_000 });
  return page;
}

test("Change password on an organization's items where the person can edit and see their passwords, until the organization turns it off", async ({
  context,
  extensionId,
  request,
}) => {
  const owner = await realAccount(request, "cp-owner");
  const member = await realAccount(request, "cp-member");
  const org = await realOrganization(request, owner, "Lakeside Clinic");
  const folders = {
    view: await realCollection(request, owner, org, "Can view"),
    hidden: await realCollection(request, owner, org, "Hidden passwords"),
    edit: await realCollection(request, owner, org, "Can edit"),
  };
  await realMember(request, owner, org, member, [
    { id: folders.view, readOnly: true, hidePasswords: false, manage: false },
    { id: folders.hidden, readOnly: false, hidePasswords: true, manage: false },
    { id: folders.edit, readOnly: false, hidePasswords: false, manage: false },
  ]);
  const uri = "https://cp-works.example.test/login";
  await realLogin(request, owner, org, folders.view, { name: "Read-only login", username: "a", password: OLD, uri });
  await realLogin(request, owner, org, folders.hidden, { name: "Hidden login", username: "b", password: OLD, uri });
  const editable = await realLogin(request, owner, org, folders.edit, {
    name: "Editable login",
    username: "c",
    password: OLD,
    uri,
  });
  const mine = await realPersonalLogin(request, member, { name: "My own login", username: "d", password: OLD, uri });

  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, { email: member.email, password: member.password, name: "cp-member" });
  // Allowed by default: the login they can edit and see the password of has it.
  await openItem(popup, "Editable login");
  await expect(popup.getByTestId("keykeeper-change-password")).toBeVisible();
  for (const name of ["Read-only login", "Hidden login"]) {
    await popup.goBack();
    await openItem(popup, name);
    await expect(popup.getByTestId("keykeeper-change-password")).toHaveCount(0);
  }

  // The owner turns it off on the organization's Settings page.
  const web = await ownerWebVault(context, owner);
  await web.goto(`${serverUrl}/#/organizations/${org.id}/settings/joining`);
  const card = web.getByTestId("password-change-setting");
  const box = card.getByRole("checkbox", { name: "Let people change passwords on sites with the browser extension" });
  await expect(box).toBeChecked({ timeout: 30_000 });
  await box.uncheck();
  await card.getByRole("button", { name: "Save" }).click();
  await expect(web.getByText("Assisted password change is off")).toBeVisible();

  // The member's extension learns it at its next sync: the organization's login has it no more; their own still does.
  await syncExtension(context);
  const item = await itemPage(context, extensionId, editable, "Editable login");
  await expect(item.getByTestId("keykeeper-change-password")).toHaveCount(0);
  const own = await itemPage(context, extensionId, mine, "My own login");
  await expect(own.getByTestId("keykeeper-change-password")).toBeVisible();
});

test("an organization's item: the change and the old password put back are in its event log, in their own words", async ({
  context,
  extensionId,
  request,
}) => {
  const host = "cp-refuses.example.test";
  await setSitePassword(request, host, OLD);
  const owner = await realAccount(request, "cp-ev-owner");
  const member = await realAccount(request, "cp-ev-member");
  const org = await realOrganization(request, owner, "Harbor Dental");
  const folder = await realCollection(request, owner, org, "Front desk");
  await realMember(request, owner, org, member, [{ id: folder, readOnly: false, hidePasswords: false, manage: false }]);
  const id = await realLogin(request, owner, org, folder, {
    name: host,
    username: "frontdesk",
    password: OLD,
    uri: `https://${host}/login`,
  });

  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, { email: member.email, password: member.password, name: "cp-ev-member" });
  await startChange(context, popup, host);
  await waitFor(context, "refused");
  const card = (await itemPage(context, extensionId, id, host)).getByTestId("keykeeper-password-change-card");
  await card.getByRole("button", { name: "Put the old password back" }).click();
  await expect(card).toBeHidden();
  expect((await itemState(context, host)).password).toBe(OLD);

  // In the organization's log, by the member, beside the edits themselves.
  const now = Date.now();
  const range = `start=${new Date(now - 3_600_000).toISOString()}&end=${new Date(now + 3_600_000).toISOString()}`;
  const events = async () => {
    const answer = await request.get(`/api/organizations/${org.id}/events?${range}`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    return ((await answer.json()).data as { type: number; actingUserId: string; cipherId: string }[]).filter(
      (e) => e.cipherId === id,
    );
  };
  await expect
    .poll(async () => (await events()).filter((e) => e.type === 1192 || e.type === 1193).map((e) => e.type).sort())
    .toEqual([1192, 1193]);
  for (const e of await events()) {
    if (e.type === 1192 || e.type === 1193) {
      expect(e.actingUserId).toBe(member.userId);
    }
  }
  expect((await events()).some((e) => e.type === 1101)).toBe(true);

  // And in its words, in the web vault's event log.
  const web = await ownerWebVault(context, owner);
  await web.goto(`${serverUrl}/#/organizations/${org.id}/reporting/events`);
  await expect(web.getByText(/Changed the password of item .* on its website\./).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(web.getByText(/Put back the earlier password of item .* after a password change\./).first()).toBeVisible();
});
