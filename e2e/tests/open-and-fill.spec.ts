// Open and fill (DESIGN.md, "Open and fill"): the open button beside a login
// in the extension opens its website in a new tab and fills that tab once.
// It fills the tab it opened, on the site it opened, once, and never submits;
// a reload, a redirect to another site, and any other tab get nothing; and an
// item that asks for the master password asks before the tab opens.
import type { BrowserContext, Page } from "@playwright/test";

import { addLogin, waitForExtensionScan } from "./support/autofill";
import {
  createAccount,
  expect,
  logInPopup,
  openPopup,
  test,
  userFor,
  type User,
} from "./support/extension";

test.describe.configure({ timeout: 120_000 });

const site = "https://bank.example.test";
const username = "alice-bank";
const password = "not-a-real-password-1";

/** Makes an account with these logins and logs the extension in: the popup, in a tab. */
async function setUp(
  context: BrowserContext,
  extensionId: string,
  user: User,
  logins: { name: string; uri: string; reprompt?: boolean }[],
): Promise<Page> {
  const web = await createAccount(context, user);
  for (const login of logins) {
    await addLogin(web, { ...login, username, password });
    // Saving opens the item's view; close it before the next one.
    const view = web.getByRole("dialog", { name: "View Login" });
    await view.getByRole("button", { name: "Close" }).first().click();
    await expect(view).toBeHidden();
  }
  await web.close();
  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, user);
  return popup;
}

const row = (popup: Page, name: string) =>
  popup.locator("#allItems bit-item").filter({ hasText: name });

/** The row's open button, which for a login is Open and fill. */
async function openAndFillButton(popup: Page, name: string) {
  await expect(row(popup, name)).toBeVisible({ timeout: 30_000 });
  await row(popup, name).hover();
  return row(popup, name).getByRole("button", { name: `Open and fill ${name}` });
}

/** Clicks Open and fill on a login, and answers with the tab it opened. */
async function openAndFill(context: BrowserContext, popup: Page, name: string): Promise<Page> {
  const button = await openAndFillButton(popup, name);
  const [tab] = await Promise.all([context.waitForEvent("page"), button.click()]);
  return tab;
}

/** Whether the extension's background still waits to fill the tab showing this page. */
async function armed(context: BrowserContext, page: Page): Promise<boolean> {
  return context.serviceWorkers()[0].evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const main = (self as any).bitwardenMain;
    return tab?.id != null && main.keykeeperOpenAndFill.isArmed(tab.id) === true;
  }, page.url());
}

/**
 * Absence can only be checked once the extension has had its chance: the
 * page's fields are scanned (so a fill could land) and its background no
 * longer waits to fill the tab. Then the fields must still be empty.
 */
async function expectNotFilled(context: BrowserContext, page: Page) {
  await page.waitForLoadState("load");
  await waitForExtensionScan(context, page, "username");
  await expect.poll(() => armed(context, page)).toBe(false);
  await expect(page.getByLabel("Username")).toHaveValue("");
  await expect(page.getByLabel("Password")).toHaveValue("");
}

async function expectFilled(page: Page) {
  await expect(page.getByLabel("Username")).toHaveValue(username, { timeout: 15_000 });
  await expect(page.getByLabel("Password")).toHaveValue(password);
}

test("fills the tab it opened once, without submitting, and not after a reload", async ({
  context,
  extensionId,
}, testInfo) => {
  const popup = await setUp(context, extensionId, userFor("open-fill", testInfo.repeatEachIndex), [
    { name: "Example Bank", uri: `${site}/simple-login.html` },
  ]);

  const tab = await openAndFill(context, popup, "Example Bank");
  await expect(tab).toHaveURL(`${site}/simple-login.html`);
  await expectFilled(tab);
  // Filled, not submitted: the form posts to another page.
  await expect(tab).toHaveURL(`${site}/simple-login.html`);
  expect(await armed(context, tab)).toBe(false);

  // Once: neither a reload nor the same page again in that tab gets it.
  await tab.reload();
  await waitForExtensionScan(context, tab, "username");
  await expect(tab.getByLabel("Password")).toHaveValue("");
  await tab.goto(`${site}/simple-login.html?again=1`);
  await expectNotFilled(context, tab);
});

test("a reload before the page had a form ends it", async ({ context, extensionId }, testInfo) => {
  // This login's website opens to a page without a sign-in form.
  const popup = await setUp(context, extensionId, userFor("open-reload", testInfo.repeatEachIndex), [
    { name: "Example Bank", uri: `${site}/signed-in.html` },
  ]);

  const tab = await openAndFill(context, popup, "Example Bank");
  await expect(tab).toHaveURL(`${site}/signed-in.html`);
  await expect.poll(() => armed(context, tab)).toBe(true);
  await tab.reload();
  await expect.poll(() => armed(context, tab)).toBe(false);

  // So the site's sign-in page, in the same tab, stays empty.
  await tab.goto(`${site}/simple-login.html`);
  await expectNotFilled(context, tab);
});

test("a redirect within the site fills; a redirect to another site gets nothing", async ({
  context,
  extensionId,
}, testInfo) => {
  // The fixture server answers /to-sign-in with a redirect to this site's
  // sign-in page, and /to-elsewhere with one to another site's (an identity
  // provider's, or a phishing hop's) at login.elsewhere.test.
  const popup = await setUp(context, extensionId, userFor("open-redirect", testInfo.repeatEachIndex), [
    { name: "Bank sign-in", uri: `${site}/to-sign-in` },
    { name: "Bank elsewhere", uri: `${site}/to-elsewhere` },
  ]);

  // Calibration: a redirect within the site still fills, so the next check means something.
  const within = await openAndFill(context, popup, "Bank sign-in");
  await expect(within).toHaveURL(`${site}/simple-login.html`);
  await expectFilled(within);

  // Opening a tab closes the popup, as upstream's open does, so open it again.
  const again = await openPopup(context, extensionId);
  const elsewhere = await openAndFill(context, again, "Bank elsewhere");
  await expect(elsewhere).toHaveURL("https://login.elsewhere.test/simple-login.html");
  await expectNotFilled(context, elsewhere);
});

test("never fills another tab, and fills its own when it gets there", async ({
  context,
  extensionId,
}, testInfo) => {
  // This login's website opens to a page without a sign-in form, so the tab
  // it opens waits while another tab shows the site's sign-in page.
  const popup = await setUp(context, extensionId, userFor("open-tabs", testInfo.repeatEachIndex), [
    { name: "Example Bank", uri: `${site}/signed-in.html` },
  ]);

  const opened = await openAndFill(context, popup, "Example Bank");
  await expect(opened).toHaveURL(`${site}/signed-in.html`);
  await expect.poll(() => armed(context, opened)).toBe(true);

  const other = await context.newPage();
  await other.goto(`${site}/simple-login.html`);
  await expectNotFilled(context, other);

  // Still waiting: its own tab, on the same site, gets it.
  await opened.bringToFront();
  await opened.goto(`${site}/simple-login.html`);
  await expectFilled(opened);
  await expect(other.getByLabel("Password")).toHaveValue("");
});

test("an item that asks for the master password asks before the tab opens", async ({
  context,
  extensionId,
}, testInfo) => {
  const user = userFor("open-reprompt", testInfo.repeatEachIndex);
  const popup = await setUp(context, extensionId, user, [
    { name: "Example Bank", uri: `${site}/simple-login.html`, reprompt: true },
  ]);
  const pagesBefore = context.pages().length;

  await (await openAndFillButton(popup, "Example Bank")).click();
  const prompt = popup.getByRole("dialog", { name: "Master password confirmation" });
  await expect(prompt).toBeVisible();
  expect(context.pages()).toHaveLength(pagesBefore);

  // Cancelled: nothing opens.
  await prompt.getByRole("button", { name: "Cancel" }).click();
  await expect(prompt).toBeHidden();
  expect(context.pages()).toHaveLength(pagesBefore);

  // Answered: the tab opens and fills.
  await (await openAndFillButton(popup, "Example Bank")).click();
  await prompt.getByRole("textbox", { name: "Master password" }).fill(user.password);
  const [tab] = await Promise.all([
    context.waitForEvent("page"),
    prompt.getByRole("button", { name: "Ok" }).click(),
  ]);
  await expectFilled(tab);
});

test("the item view has Open and fill beside each website's plain open", async ({
  context,
  extensionId,
}, testInfo) => {
  const popup = await setUp(context, extensionId, userFor("open-view", testInfo.repeatEachIndex), [
    { name: "Example Bank", uri: `${site}/simple-login.html` },
  ]);

  await row(popup, "Example Bank").getByText("Example Bank", { exact: true }).click();
  await expect(popup.getByRole("heading", { level: 1, name: "Example Bank" })).toBeVisible();
  await expect(popup.getByTestId("launch-website")).toBeVisible();
  const [tab] = await Promise.all([
    context.waitForEvent("page"),
    popup.getByRole("button", { name: "Open and fill bank.example.test" }).click(),
  ]);
  await expectFilled(tab);
});
