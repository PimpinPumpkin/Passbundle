// Addresses and cards (DESIGN.md, "Addresses and cards"), on local test pages
// only: a one-page checkout fills the address from an identity and the card
// from a card, with the name on the card only in its own field and the month
// and year lists on the right options; a checkout in two steps on one page
// fills the card in the payment fields that appear after Continue; an address
// known only by labels gets the menu inside its fields, its street's text area
// and its state list too, never a search box or a comments field, and a state
// list of full names gets the right one from a code; a German address fills
// its Bundesland and Land lists of names from codes; a card fills a payment
// service's frame and never another site's, unless the fill starts there; the
// fill picker puts a card's number into a payment service's frame and never
// into another site's, even when the pick starts there; and
// an organization that turns the browser's own card and address autofill off
// has the extension turn them off in a work profile, and let go of them again.
import fs from "node:fs";

import type { APIRequestContext, BrowserContext, Frame, Locator, Page } from "@playwright/test";

import { fixturePort, hostResolverRules } from "../paths.mjs";
import { chooseFirstInlineMenuItem, waitForInlineMenuItem } from "./support/autofill";
import {
  expect,
  extensionIdOf,
  launchWithExtension,
  logInPopup,
  openPopup,
  serverUrl,
  test,
} from "./support/extension";
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

/** An identity that keeps its state and country as codes. */
const shipping = {
  type: 4 as const,
  name: "Shipping address",
  values: {
    firstName: "Alice",
    lastName: "Example",
    address1: "1 Main Street",
    city: "Springfield",
    state: "CA",
    postalCode: "12345",
    country: "US",
  },
};

/** A German address, its state and country as codes. */
const munich = {
  type: 4 as const,
  name: "Lieferadresse",
  values: {
    firstName: "Anna",
    lastName: "Beispiel",
    address1: "Hauptstraße 1",
    postalCode: "80331",
    city: "München",
    state: "BY",
    country: "DE",
  },
};

/** A new account with a card and an identity (or these items), signed in to the extension. */
async function shopper(
  context: BrowserContext,
  extensionId: string,
  request: APIRequestContext,
  prefix: string,
  items = [card, home],
) {
  const account = await realAccount(request, prefix);
  for (const item of items) {
    await personalItem(request, account, item);
  }
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
            // Any frame's: a card's fields may be in a frame of their own.
            const frames = tab?.id ? main?.overlayBackground.pageDetailsForTab[tab.id] : null;
            return [...(frames?.values() ?? [])].some((frame) =>
              frame?.details?.fields?.some((f: { htmlID?: string }) => f.htmlID === fieldId),
            );
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
  await openMenuIn(page, page.locator(`#${fieldId}`));
  await chooseFirstInlineMenuItem(context, page, itemName);
}

const menuOpen = (page: Page) => page.frames().some((f) => f.url().endsWith("menu-list.html"));

/** Clicks into a field until the menu inside it opens. */
async function openMenuIn(page: Page, field: Locator) {
  const focused = () => field.evaluate((el) => el.ownerDocument.activeElement === el);
  await expect(async () => {
    // The menu may still be open for the field before.
    if (!menuOpen(page) || !(await focused())) {
      await page.locator("body").click({ position: { x: 1, y: 1 } });
      await field.click();
    }
    await expect.poll(() => menuOpen(page), { timeout: 2_000 }).toBe(true);
  }).toPass({ timeout: 20_000 });
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

/**
 * Picks the first item in the menu inside a field, with the keyboard, for a
 * field in a frame or a text area too: ArrowDown moves focus from the field
 * into the menu, and Enter waits until it has.
 */
async function chooseFromMenu(context: BrowserContext, page: Page, field: Locator, itemName: string) {
  await waitForInlineMenuItem(context, page, itemName);
  const stillInField = () =>
    field.evaluate((el) => el.ownerDocument.hasFocus() && el.ownerDocument.activeElement === el);
  await expect(async () => {
    if (await stillInField()) {
      await page.keyboard.press("ArrowDown");
    }
    await expect.poll(stillInField, { timeout: 1000 }).toBe(false);
  }).toPass({ timeout: 10_000 });
  await page.keyboard.press("Enter");
}

/**
 * The fields of the focused field's frame that have the menu inside them, by
 * id: the focused field sends them all to the extension's background with its
 * own position.
 */
async function fieldsWithMenu(context: BrowserContext): Promise<string[]> {
  return context.serviceWorkers()[0].evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fields = (self as any).bitwardenMain.overlayBackground.allFieldData ?? [];
    return fields.map((f: { htmlID?: string }) => f.htmlID ?? "").sort();
  });
}

test("an address known only by labels gets the menu in its fields, lists and text areas too, and its state list of full names gets the right one", async ({
  context,
  extensionId,
  request,
}) => {
  await shopper(context, extensionId, request, "address-labels", [shipping]);
  const page = await context.newPage();
  await page.goto(`${shop}/address-labels.html`);
  await waitForFields(context, page, "street");

  // The state list opens the identities' menu when it gets focus.
  await expect(async () => {
    if (!menuOpen(page)) {
      await page.locator("body").click({ position: { x: 1, y: 1 } });
      await page.locator("#state").focus();
    }
    await expect.poll(() => menuOpen(page), { timeout: 2_000 }).toBe(true);
  }).toPass({ timeout: 20_000 });
  await waitForInlineMenuItem(context, page, "Shipping address");

  // Every field of the address has it, and the search box and the comments
  // field don't.
  expect(await fieldsWithMenu(context)).toEqual(["city", "fullname", "state", "street", "zip"]);

  // From the street's text area.
  const street = page.locator("#street");
  await openMenuIn(page, street);
  await chooseFromMenu(context, page, street, "Shipping address");
  await expect(page.locator("#street")).toHaveValue("1 Main Street");
  await expect(page.locator("#fullname")).toHaveValue("Alice Example");
  await expect(page.locator("#city")).toHaveValue("Springfield");
  // The identity says CA; the list's values are full names.
  await expect(page.locator("#state")).toHaveValue("California");
  await expect(page.locator("#zip")).toHaveValue("12345");
  await expect(page.locator("#site-search")).toHaveValue("");
  await expect(page.locator("#comments")).toHaveValue("");
});

test("a German address fills its Bundesland and Land lists of full names from an identity's codes", async ({
  context,
  extensionId,
  request,
}) => {
  await shopper(context, extensionId, request, "address-germany", [munich]);
  const page = await context.newPage();
  await page.goto(`${shop}/address-germany.html`);
  await waitForFields(context, page, "strasse");

  const street = page.locator("#strasse");
  await openMenuIn(page, street);
  await chooseFromMenu(context, page, street, "Lieferadresse");
  await expect(page.locator("#vorname")).toHaveValue("Anna");
  await expect(page.locator("#nachname")).toHaveValue("Beispiel");
  await expect(street).toHaveValue("Hauptstraße 1");
  await expect(page.locator("#plz")).toHaveValue("80331");
  await expect(page.locator("#ort")).toHaveValue("München");
  // BY and DE, as the list writes them.
  await expect(page.locator("#bundesland")).toHaveValue("Bayern");
  await expect(page.locator("#land")).toHaveValue("Deutschland");
  expect(await fieldsWithMenu(context)).toEqual(
    ["bundesland", "land", "nachname", "ort", "plz", "strasse", "vorname"].sort(),
  );
});

// The test browser's rules, plus a payment service's host on the extension's
// list, sent to the local fixture server: its stand-in for the service's
// hosted card fields. Nothing reaches the real service.
const paymentServiceRules = hostResolverRules.replace(
  "MAP * ~NOTFOUND",
  `MAP js.stripe.com 127.0.0.1:${fixturePort}, MAP * ~NOTFOUND`,
);

test("a card fills a payment service's frame and never another site's, unless the fill starts in it", async ({
  request,
}) => {
  const { context, profile } = await launchWithExtension(paymentServiceRules);
  try {
    const extensionId = await extensionIdOf(context);
    await shopper(context, extensionId, request, "card-frames", [card]);
    const page = await context.newPage();
    await page.goto(`${shop}/card-frames.html`);
    await waitForFields(context, page, "ccnumber");
    const frameOf = (host: string) =>
      page.frames().find((f) => new URL(f.url()).host === host) as Frame;
    await expect.poll(() => Boolean(frameOf("js.stripe.com") && frameOf("pay.elsewhere.test"))).toBe(true);
    const payment = frameOf("js.stripe.com");
    const elsewhere = frameOf("pay.elsewhere.test");

    // Started on the shop's own page: the name there, and the payment
    // service's frame, whose fields are in no form. Never the other site's
    // frame: refused before anything left the extension.
    await fillFrom(context, page, "ccname", "Test Visa");
    await expect(page.locator("#ccname")).toHaveValue("Alice B Example");
    await expect(elsewhere.locator("#ccnumber")).toHaveValue("");
    await expect(payment.locator("#ccnumber")).toHaveValue(card.values.number);
    await expect(payment.locator("#ccexp")).toHaveValue("03/27");
    await expect(payment.locator("#cvc")).toHaveValue("123");
    // Still nothing there once the fill is done.
    await expect(elsewhere.locator("#ccnumber")).toHaveValue("");
    await expect(elsewhere.locator("#ccexp")).toHaveValue("");
    await expect(elsewhere.locator("#cvc")).toHaveValue("");

    // Started in the other site's frame, where the person chose to fill it.
    const number = elsewhere.locator("#ccnumber");
    await openMenuIn(page, number);
    await chooseFromMenu(context, page, number, "Test Visa");
    await expect(number).toHaveValue(card.values.number);
    await expect(elsewhere.locator("#ccexp")).toHaveValue("03/27");
    await expect(elsewhere.locator("#cvc")).toHaveValue("123");
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

/**
 * The fill picker's "Fill this field with", from the right-click menu, for
 * the field last right-clicked in the frame at `host`: the same handler the
 * menu item runs, with its id (Chrome's own menu can't be driven from a test).
 */
async function pickInFrame(context: BrowserContext, page: Page, host: string, itemName: string, choiceKey: string) {
  await context.serviceWorkers()[0].evaluate(
    async ({ url, host, itemName, choiceKey }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const main = (self as any).bitwardenMain;
      const userId = await new Promise<string>((resolve) =>
        main.accountService.activeAccount$.subscribe((a: { id: string }) => resolve(a.id)),
      );
      const ciphers: { id: string; name: string }[] = await main.cipherService.getAllDecrypted(userId);
      const cipher = ciphers.find((c) => c.name === itemName)!;
      const tab = (await chrome.tabs.query({})).find((t) => t.url === url)!;
      const frames = (await chrome.webNavigation.getAllFrames({ tabId: tab.id! })) ?? [];
      const frame = frames.find((f) => new URL(f.url).host === host)!;
      await main.contextMenusBackground.contextMenuClickedHandler.run(
        { menuItemId: `kkfill_${cipher.id}_${choiceKey}`, frameId: frame.frameId, editable: true, pageUrl: url },
        tab,
      );
    },
    { url: page.url(), host, itemName, choiceKey },
  );
}

/** The fill rules an item carries. */
async function fillRulesOf(context: BrowserContext, itemName: string): Promise<{ host: string; fill: unknown }[]> {
  return context.serviceWorkers()[0].evaluate(async (itemName) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const main = (self as any).bitwardenMain;
    const userId = await new Promise<string>((resolve) =>
      main.accountService.activeAccount$.subscribe((a: { id: string }) => resolve(a.id)),
    );
    const ciphers: { name: string; fields?: { name: string; value: string }[] }[] =
      await main.cipherService.getAllDecrypted(userId);
    return (ciphers.find((c) => c.name === itemName)?.fields ?? [])
      .filter((f) => f.name === "keykeeper.fill")
      .map((f) => JSON.parse(f.value));
  }, itemName);
}

// The fill picker with a card's values (DESIGN.md, "Choosing what fills
// where"): a card's number picked for a field in a payment service's frame
// fills it and is remembered on the card; in another site's frame it's
// refused, even though the pick starts there, and nothing is remembered.
test("the fill picker puts a card's number into a payment service's frame, and never into another site's", async ({
  request,
}) => {
  const { context, profile } = await launchWithExtension(paymentServiceRules);
  try {
    const extensionId = await extensionIdOf(context);
    await shopper(context, extensionId, request, "card-picker", [card]);
    const page = await context.newPage();
    await page.goto(`${shop}/card-frames.html`);
    await waitForFields(context, page, "ccnumber");
    const frameOf = (host: string) =>
      page.frames().find((f) => new URL(f.url()).host === host) as Frame;
    await expect.poll(() => Boolean(frameOf("js.stripe.com") && frameOf("pay.elsewhere.test"))).toBe(true);
    const payment = frameOf("js.stripe.com");
    const elsewhere = frameOf("pay.elsewhere.test");

    // In the payment service's frame: filled, and kept on the card for that frame's host.
    await payment.locator("#ccnumber").click({ button: "right" });
    await page.keyboard.press("Escape");
    await pickInFrame(context, page, "js.stripe.com", "Test Visa", "c1");
    await expect(payment.locator("#ccnumber")).toHaveValue(card.values.number);
    await expect
      .poll(() => fillRulesOf(context, "Test Visa"))
      .toEqual([
        {
          v: 1,
          host: "js.stripe.com",
          scheme: "https",
          field: { id: "ccnumber", name: "ccnumber", label: "card number" },
          fill: { from: "card", value: "number" },
        },
      ]);

    // In another site's frame: refused, the name on the card too, and nothing more kept.
    await elsewhere.locator("#ccnumber").click({ button: "right" });
    await page.keyboard.press("Escape");
    await pickInFrame(context, page, "pay.elsewhere.test", "Test Visa", "c1");
    await pickInFrame(context, page, "pay.elsewhere.test", "Test Visa", "c0");
    // A pick on the shop's own page after them lands after anything they sent.
    await page.locator("#ccname").click({ button: "right" });
    await page.keyboard.press("Escape");
    await pickInFrame(context, page, "shop.example.test", "Test Visa", "c0");
    await expect(page.locator("#ccname")).toHaveValue("Alice B Example");
    await expect(elsewhere.locator("#ccnumber")).toHaveValue("");
    await expect.poll(async () => (await fillRulesOf(context, "Test Visa")).length).toBe(2);
    expect((await fillRulesOf(context, "Test Visa")).map((r) => r.host)).toEqual([
      "js.stripe.com",
      "shop.example.test",
    ]);
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
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

