// Addresses and cards (DESIGN.md, "Addresses and cards"), on local test pages
// only: a one-page checkout fills the address from an identity and the card
// from a card, with the name on the card only in its own field and the month
// and year lists on the right options; a checkout in two steps on one page
// fills the card in the payment fields that appear after Continue; and an
// organization that turns the browser's own card and address autofill off
// has the extension turn them off in a work profile, and let go of them again.
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";

import { chooseFirstInlineMenuItem } from "./support/autofill";
import { expect, logInPopup, openPopup, serverUrl, test } from "./support/extension";
import {
  encrypt,
  realAccount,
  realMember,
  realOrganization,
  type RealAccount,
} from "./support/vault-crypto";

test.describe.configure({ timeout: 180_000 });

const shop = "https://shop.example.test";

const headers = (account: RealAccount) => ({ authorization: `Bearer ${account.token}` });

/** An item in the account's own Personal items: a card or an identity, each value encrypted. */
async function personalItem(
  request: APIRequestContext,
  account: RealAccount,
  item: { type: 3 | 4; name: string; values: Record<string, string> },
) {
  const key = account.userKey;
  const part = item.type === 3 ? "card" : "identity";
  const created = await request.post("/api/ciphers", {
    headers: headers(account),
    data: {
      type: item.type,
      organizationId: null,
      encryptedFor: account.userId,
      name: encrypt(key, item.name),
      notes: null,
      favorite: false,
      reprompt: 0,
      fields: [],
      [part]: Object.fromEntries(Object.entries(item.values).map(([k, v]) => [k, encrypt(key, v)])),
    },
  });
  expect(created.status(), await created.text()).toBe(200);
}

const card = {
  type: 3 as const,
  name: "Test Visa",
  values: {
    cardholderName: "Alice B Example",
    number: "4111111111111111",
    brand: "Visa",
    expMonth: "3",
    expYear: "27",
    code: "123",
  },
};

const home = {
  type: 4 as const,
  name: "Home address",
  values: {
    firstName: "Alice",
    lastName: "Example",
    address1: "1 Main Street",
    city: "Springfield",
    postalCode: "12345",
    email: "alice@example.test",
    phone: "+1 555 123 4567",
  },
};

/** A new account with a card and an identity, signed in to the extension. */
async function shopper(context: BrowserContext, extensionId: string, request: APIRequestContext, prefix: string) {
  const account = await realAccount(request, prefix);
  await personalItem(request, account, card);
  await personalItem(request, account, home);
  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, { email: account.email, password: account.password, name: prefix });
  await popup.close();
  return account;
}

/**
 * Waits until the extension has read the page's fields, this one included.
 * (waitForExtensionScan also waits for the sign-in watch, which a checkout
 * without a sign-in form never gets.)
 */
async function waitForFields(context: BrowserContext, page: Page, fieldId: string) {
  const worker = context.serviceWorkers()[0];
  const url = page.url();
  await expect
    .poll(
      () =>
        worker.evaluate(
          async ({ url, fieldId }) => {
            const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const main = (self as any).bitwardenMain;
            const details = tab?.id ? main?.overlayBackground.pageDetailsForTab[tab.id]?.get(0)?.details : null;
            return Boolean(details?.fields?.some((f: { htmlID?: string }) => f.htmlID === fieldId));
          },
          { url, fieldId },
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
}

/**
 * Fills from the menu inside a field: the first item it lists. Right after a
 * fill, or after a step adds fields, the extension takes a moment before a
 * field opens its menu again, so this clicks into the field until it does.
 */
async function fillFrom(
  context: BrowserContext,
  page: Page,
  fieldId: string,
  itemName: string,
  { added = false } = {},
) {
  // Fields a step added are read again when one of them is focused, so only
  // the page's first fields are waited for here.
  if (!added) {
    await waitForFields(context, page, fieldId);
  }
  const field = page.locator(`#${fieldId}`);
  const menuOpen = () => page.frames().some((f) => f.url().endsWith("menu-list.html"));
  await expect(async () => {
    if (!menuOpen()) {
      await page.locator("body").click({ position: { x: 1, y: 1 } });
      await field.click();
    }
    await expect.poll(menuOpen, { timeout: 2_000 }).toBe(true);
  }).toPass({ timeout: 20_000 });
  await chooseFirstInlineMenuItem(context, page, itemName);
}

async function expectCardFilled(page: Page) {
  await expect(page.locator("#ccnumber")).toHaveValue(card.values.number);
  await expect(page.locator("#ccname")).toHaveValue("Alice B Example");
  await expect(page.locator("#ccmonth")).toHaveValue("03");
  await expect(page.locator("#ccyear")).toHaveValue("2027");
  await expect(page.locator("#cvc")).toHaveValue("123");
}

test("a one-page checkout fills the address from an identity and the card from a card, each in its own fields", async ({
  context,
  extensionId,
  request,
}) => {
  await shopper(context, extensionId, request, "checkout");
  const page = await context.newPage();
  await page.goto(`${shop}/checkout.html`);

  await fillFrom(context, page, "name", "Home address");
  await expect(page.locator("#name")).toHaveValue("Alice Example");
  await expect(page.locator("#address1")).toHaveValue("1 Main Street");
  await expect(page.locator("#city")).toHaveValue("Springfield");
  await expect(page.locator("#zip")).toHaveValue("12345");
  // Nothing of the card's from the identity.
  await expect(page.locator("#ccnumber")).toHaveValue("");

  await fillFrom(context, page, "ccnumber", "Test Visa");
  await expectCardFilled(page);
  // The name on the card went only into its own field, not the shipping name.
  await expect(page.locator("#name")).toHaveValue("Alice Example");
});

test("a checkout in two steps on one page fills the card in the payment fields that appear after Continue", async ({
  context,
  extensionId,
  request,
}) => {
  await shopper(context, extensionId, request, "checkout-steps");
  const page = await context.newPage();
  await page.goto(`${shop}/checkout-steps.html`);
  await fillFrom(context, page, "name", "Home address");
  await expect(page.locator("#name")).toHaveValue("Alice Example");

  await page.getByRole("button", { name: "Continue to payment" }).click();
  await expect(page.locator("#ccnumber")).toBeVisible();
  await fillFrom(context, page, "ccnumber", "Test Visa", { added: true });
  await expectCardFilled(page);
  await expect(page.locator("#name")).toHaveValue("Alice Example");
});

type Switch = { levelOfControl: string; value: boolean };

/** What the browser says about its own card and address autofill in this profile. */
async function browserSwitches(context: BrowserContext): Promise<{ cards: Switch; addresses: Switch }> {
  return context.serviceWorkers()[0].evaluate(async () => {
    const get = (setting: chrome.types.ChromeSetting<boolean>) =>
      new Promise<Switch>((resolve) =>
        setting.get({}, (d) => resolve({ levelOfControl: d.levelOfControl, value: d.value })),
      );
    return {
      cards: await get(chrome.privacy.services.autofillCreditCardEnabled),
      addresses: await get(chrome.privacy.services.autofillAddressEnabled),
    };
  });
}

async function syncExtension(context: BrowserContext) {
  await context.serviceWorkers()[0].evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (self as any).bitwardenMain.syncService.fullSync(true);
  });
}

const ours = { levelOfControl: "controlled_by_this_extension", value: false };
const theBrowsers = { levelOfControl: "controllable_by_this_extension", value: true };

test("an organization that turns the browser's card and address autofill off has the extension turn them off in a work profile, and let go of them after", async ({
  context,
  extensionId,
  request,
}) => {
  const owner = await realAccount(request, "ba-owner");
  const member = await realAccount(request, "ba-member");
  const org = await realOrganization(request, owner, "Acme Dental");
  await realMember(request, owner, org, member, []);

  // Signed in to an account in an organization that leaves them as they are:
  // a personal profile as far as this goes, so nothing is touched.
  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, { email: member.email, password: member.password, name: "ba-member" });
  await syncExtension(context);
  expect(await browserSwitches(context)).toEqual({ cards: theBrowsers, addresses: theBrowsers });

  // The owner turns them off, with the offer, on the organization's Settings page.
  const web = await context.newPage();
  await web.goto(`${serverUrl}/#/vault`);
  await web.getByRole("textbox", { name: /Email address/ }).fill(owner.email);
  await web.getByRole("button", { name: "Continue" }).click();
  await web.getByRole("textbox", { name: /Master password/ }).fill(owner.password);
  await web.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(web.getByRole("heading", { name: "All items" }).first()).toBeVisible({ timeout: 30_000 });
  await web.goto(`${serverUrl}/#/organizations/${org.id}/settings/joining`);
  const settingCard = web.getByTestId("browser-autofill-setting");
  await expect(settingCard.getByRole("radio", { name: /Leave as is/ })).toBeChecked({ timeout: 30_000 });
  await settingCard.getByRole("radio", { name: /Turn off, and offer to bring them in/ }).check();
  await settingCard.getByRole("button", { name: "Save" }).click();
  await expect(web.getByText("The browsers' card and address autofill are off, with the offer")).toBeVisible();
  await web.close();

  // The member's extension learns it at its next sync, and turns both off here.
  await syncExtension(context);
  await expect.poll(() => browserSwitches(context), { timeout: 15_000 }).toEqual({ cards: ours, addresses: ours });

  // The popup says so once, and offers to bring them in.
  await popup.reload();
  await expect(popup.getByTestId("browser-autofill-note")).toContainText(
    "Acme Dental turned off Chrome's own card and address autofill in this profile",
  );
  const offer = popup.getByTestId("browser-autofill-offer");
  await expect(offer.getByRole("button", { name: "New card" })).toBeVisible();
  await popup.getByTestId("browser-autofill-note").getByRole("button", { name: "Got it" }).click();
  await offer.getByRole("button", { name: "Done" }).click();
  await popup.reload();
  await expect(popup.locator("app-keykeeper-browser-autofill-notice")).toBeAttached({ timeout: 30_000 });
  await expect(popup.getByTestId("browser-autofill-note")).toHaveCount(0);
  await expect(popup.getByTestId("browser-autofill-offer")).toHaveCount(0);

  // Back to leave as is: the extension lets go of them, and the browser has its own again.
  const back = await request.put(`/api/keykeeper/organizations/${org.id}/browser-autofill`, {
    headers: headers(owner),
    data: { mode: "unchanged" },
  });
  expect(back.status(), await back.text()).toBe(200);
  await syncExtension(context);
  await expect
    .poll(() => browserSwitches(context), { timeout: 15_000 })
    .toEqual({ cards: theBrowsers, addresses: theBrowsers });
});

