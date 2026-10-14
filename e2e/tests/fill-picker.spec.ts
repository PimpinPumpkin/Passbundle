// The fill picker: right-click a field, "Fill this field with", an item, and a
// value or "Never fill this field". It fills now and remembers the choice on
// the item for every later autofill.
import type { BrowserContext, Page } from "@playwright/test";

import { addLogin, extensionFrame, waitForExtensionScan } from "./support/autofill";
import { createAccount, expect, logInPopup, openPopup, test, userFor } from "./support/extension";

test.describe.configure({ timeout: 120_000 });

const site = "https://bank.example.test";

// Chrome's native right-click menu can't be driven from a test. The test
// right-clicks the field for real (the page records which one), then runs the
// same click handler the menu item would, with the same menu item id.
async function pickFromMenu(context: BrowserContext, page: Page, itemName: string, choiceKey: string) {
  const worker = context.serviceWorkers()[0];
  await worker.evaluate(
    async ({ url, itemName, choiceKey }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const main = (self as any).bitwardenMain;
      const userId = await new Promise<string>((resolve) =>
        main.accountService.activeAccount$.subscribe((a: { id: string }) => resolve(a.id)),
      );
      const ciphers: { id: string; name: string }[] = await main.cipherService.getAllDecrypted(userId);
      const cipher = ciphers.find((c) => c.name === itemName)!;
      const tab = (await chrome.tabs.query({})).find((t) => t.url === url)!;
      await main.contextMenusBackground.contextMenuClickedHandler.run(
        { menuItemId: `kkfill_${cipher.id}_${choiceKey}`, frameId: 0, editable: true, pageUrl: url },
        tab,
      );
    },
    { url: page.url(), itemName, choiceKey },
  );
}

/** Whether the item now carries a saved fill rule. */
async function itemHasFillRule(context: BrowserContext, itemName: string) {
  return context.serviceWorkers()[0].evaluate(async (itemName) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const main = (self as any).bitwardenMain;
    const userId = await new Promise<string>((resolve) =>
      main.accountService.activeAccount$.subscribe((a: { id: string }) => resolve(a.id)),
    );
    const ciphers: { name: string; fields?: { name: string }[] }[] =
      await main.cipherService.getAllDecrypted(userId);
    return Boolean(ciphers.find((c) => c.name === itemName)?.fields?.some((f) => f.name === "keykeeper.fill"));
  }, itemName);
}

/** A normal autofill: the menu inside a field, then the first match. */
async function autofillFrom(context: BrowserContext, page: Page, fieldLabel: string) {
  const field = page.getByLabel(fieldLabel, { exact: true });
  await waitForExtensionScan(context, page, (await field.getAttribute("id"))!);
  await field.click();
  await extensionFrame(page, "menu-list.html");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(field).not.toHaveValue("");
}

test("fills a custom field into the right-clicked field, and remembers it", async ({
  context,
  extensionId,
}, testInfo) => {
  const user = userFor("picker", testInfo.repeatEachIndex);
  const web = await createAccount(context, user);
  await addLogin(web, {
    name: "Example Bank",
    username: "alice-bank",
    password: "not-a-real-password-1",
    uri: site,
    customFields: { "Customer ID": "C-12345" },
  });
  await web.close();
  await logInPopup(await openPopup(context, extensionId), user);

  // Before: upstream can't connect "Customer ID" to a field labeled "Customer number".
  const before = await context.newPage();
  await before.goto(`${site}/bank-login.html`);
  await autofillFrom(context, before, "Username");
  await expect(before.getByLabel("Customer number")).toHaveValue("");

  // One pick from the menu fills it right away.
  await before.getByLabel("Customer number").click({ button: "right" });
  await before.keyboard.press("Escape");
  await pickFromMenu(context, before, "Example Bank", "f0");
  await expect(before.getByLabel("Customer number")).toHaveValue("C-12345");
  await expect.poll(() => itemHasFillRule(context, "Example Bank")).toBe(true);

  // After: a normal autofill fills all three fields.
  const after = await context.newPage();
  await after.goto(`${site}/bank-login.html`);
  await autofillFrom(context, after, "Username");
  await expect(after.getByLabel("Username")).toHaveValue("alice-bank");
  await expect(after.getByLabel("Password")).toHaveValue("not-a-real-password-1");
  await expect(after.getByLabel("Customer number")).toHaveValue("C-12345");
});

test("never-fill keeps a field empty on every later autofill", async ({
  context,
  extensionId,
}, testInfo) => {
  const user = userFor("never", testInfo.repeatEachIndex);
  const site = "https://shared.example.test";
  const web = await createAccount(context, user);
  await addLogin(web, {
    name: "Shared desk login",
    username: "front-desk",
    password: "not-a-real-password-1",
    uri: site,
  });
  await web.close();
  await logInPopup(await openPopup(context, extensionId), user);

  // Before: autofill fills the username, as it should by default.
  const before = await context.newPage();
  await before.goto(`${site}/simple-login.html`);
  await autofillFrom(context, before, "Username");
  await expect(before.getByLabel("Username")).toHaveValue("front-desk");

  await before.getByLabel("Username").click({ button: "right" });
  await before.keyboard.press("Escape");
  await pickFromMenu(context, before, "Shared desk login", "n");
  await expect.poll(() => itemHasFillRule(context, "Shared desk login")).toBe(true);

  // After: the password still fills; the username stays empty.
  const after = await context.newPage();
  await after.goto(`${site}/simple-login.html`);
  await autofillFrom(context, after, "Password");
  await expect(after.getByLabel("Password")).toHaveValue("not-a-real-password-1");
  await expect(after.getByLabel("Username")).toHaveValue("");
});
