// The fill picker: right-click a field, "Fill this field with", an item, and a
// value or "Never fill this field". It fills now and remembers the choice on
// the item for every later autofill.
import type { BrowserContext, Page } from "@playwright/test";

import { addLogin, extensionFrame, waitForExtensionScan } from "./support/autofill";
import {
  createAccount,
  expect,
  logInPopup,
  openPopup,
  serverUrl,
  test,
  userFor,
} from "./support/extension";

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

/** Opens the web vault in this browser, logging in or unlocking as needed. */
async function openWebVault(context: BrowserContext, user: { email: string; password: string }): Promise<Page> {
  const vault = await context.newPage();
  await vault.goto(`${serverUrl}/#/vault`);
  const email = vault.getByRole("textbox", { name: /Email address/ });
  const unlock = vault.getByRole("button", { name: "Unlock" });
  const vaultTitle = vault.getByRole("heading", { name: "All vaults" }).first();
  await expect(email.or(unlock).or(vaultTitle)).toBeVisible({ timeout: 30_000 });
  if (await email.isVisible()) {
    await email.fill(user.email);
    await vault.getByRole("button", { name: "Continue" }).click();
    await vault.getByRole("textbox", { name: /Master password/ }).fill(user.password);
    await vault.getByRole("button", { name: "Log in", exact: true }).click();
  } else if (await unlock.isVisible()) {
    await vault.getByRole("textbox", { name: /Master password/ }).fill(user.password);
    await unlock.click();
  }
  await expect(vaultTitle).toBeVisible({ timeout: 30_000 });
  return vault;
}

/** Makes the extension pull the latest vault from the server now. */
async function syncExtension(context: BrowserContext) {
  await context.serviceWorkers()[0].evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (self as any).bitwardenMain.syncService.fullSync(true);
  });
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

test("a fill rule stays out of sight in the web vault, and survives editing the item there", async ({
  context,
  extensionId,
}, testInfo) => {
  const user = userFor("picker-edit", testInfo.repeatEachIndex);
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

  const page = await context.newPage();
  await page.goto(`${site}/bank-login.html`);
  await waitForExtensionScan(context, page, "custno");
  await page.getByLabel("Customer number").click({ button: "right" });
  await page.keyboard.press("Escape");
  await pickFromMenu(context, page, "Example Bank", "f0");
  await expect.poll(() => itemHasFillRule(context, "Example Bank")).toBe(true);

  // The web vault shows only the person's own custom field.
  const vault = await openWebVault(context, user);
  await vault.getByText("Example Bank").first().click();
  const view = vault.getByRole("dialog", { name: "View Login" });
  await expect(view.getByRole("textbox", { name: "Customer ID" })).toBeVisible();
  await expect(view.getByText("keykeeper.fill")).toHaveCount(0);

  // Editing and saving the item there keeps the rule.
  await view.getByRole("button", { name: "Edit" }).click();
  const edit = vault.getByRole("dialog", { name: /Edit Login/ });
  await expect(edit.getByText("keykeeper.fill")).toHaveCount(0);
  await edit.getByRole("textbox", { name: "Notes" }).fill("Edited in the web vault.");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  await syncExtension(context);
  await expect.poll(() => itemHasFillRule(context, "Example Bank")).toBe(true);

  const after = await context.newPage();
  await after.goto(`${site}/bank-login.html`);
  await autofillFrom(context, after, "Username");
  await expect(after.getByLabel("Customer number")).toHaveValue("C-12345");
});
