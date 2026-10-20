// Site fixes end to end (DESIGN.md, "Site fixes (opt-in)"): an MSP admin
// turns on sharing in the extension, fixes a field with the fill picker, sees
// the fix in the MSP console, uses it for every client, and the extension then
// applies it to a login that has no rule of its own. The API tests cover
// three people confirming a fix and the permissions.
import type { BrowserContext, Page } from "@playwright/test";

import { addLogin, chooseFirstInlineMenuItem, waitForExtensionScan } from "./support/autofill";
import {
  createAccount,
  expect,
  logInPopup,
  openPopup,
  serverUrl,
  test,
  userFor,
} from "./support/extension";

test.describe.configure({ timeout: 180_000 });

/** Runs the fill picker's menu item for the right-clicked field (Chrome's menu can't be driven). */
async function pickFromMenu(context: BrowserContext, page: Page, itemName: string, choiceKey: string) {
  await context.serviceWorkers()[0].evaluate(
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

test("a fix an MSP admin shares from the fill picker, used for every client, fills for logins without a rule", async ({
  context,
  extensionId,
}, testInfo) => {
  const host = `site-fixes-${testInfo.repeatEachIndex}.example.test`;
  const site = `https://${host}`;
  const user = userFor("site-fixes", testInfo.repeatEachIndex);
  const web = await createAccount(context, user);
  await web.goto(`${serverUrl}/#/msp`);
  await web.getByRole("textbox", { name: "Your MSP's name" }).fill("Fixing IT");
  await web.getByRole("button", { name: "Create MSP" }).click();
  await expect(web.getByTestId("msp-site-fixes")).toContainText("None yet.");
  await web.goto(`${serverUrl}/#/vault`);
  for (const name of ["First login", "Second login"]) {
    await addLogin(web, { name, username: `${name.split(" ")[0].toLowerCase()}-user`, password: "not-a-real-password-1", uri: site });
    const view = web.getByRole("dialog", { name: "View Login" });
    await view.getByRole("button", { name: "Close" }).first().click();
    await expect(view).toBeHidden();
  }

  // Sharing is off until they turn it on, in the extension's Autofill settings.
  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, user);
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html#/autofill`);
  const settings = popup.getByTestId("site-fixes-settings");
  const share = settings.getByRole("checkbox", { name: "Share fixes I make with the fill picker" });
  await expect(share).not.toBeChecked();
  await share.check();

  // The fill picker: never fill the username field on this site.
  const page = await context.newPage();
  await page.goto(`${site}/simple-login.html`);
  await waitForExtensionScan(context, page, "username");
  await page.getByLabel("Username").click({ button: "right" });
  await page.keyboard.press("Escape");
  await pickFromMenu(context, page, "First login", "n");

  // The MSP console shows it, shared by its admin, and uses it for every client.
  await expect(async () => {
    await web.goto(`${serverUrl}/#/vault`);
    await web.goto(`${serverUrl}/#/msp`);
    await expect(web.getByTestId(`msp-site-shared-${host}`)).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  const shared = web.getByTestId(`msp-site-shared-${host}`);
  await expect(shared).toContainText('the field with id username gets nothing (never fill)');
  await expect(shared).toContainText(user.email);
  await shared.getByRole("button", { name: "Use for every client" }).click();
  await expect(web.getByTestId(`msp-site-rule-${host}`)).toBeVisible();
  await expect(web.getByTestId(`msp-site-shared-${host}`)).toHaveCount(0);

  // The extension gets the rule and applies it to a login without a rule of its
  // own. The login with the rule goes to the trash, so only the site rule can
  // keep the username empty.
  await context.serviceWorkers()[0].evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const main = (self as any).bitwardenMain;
    const userId = await new Promise<string>((resolve) =>
      main.accountService.activeAccount$.subscribe((a: { id: string }) => resolve(a.id)),
    );
    const ciphers: { id: string; name: string }[] = await main.cipherService.getAllDecrypted(userId);
    await main.cipherService.softDeleteWithServer(ciphers.find((c) => c.name === "First login")!.id, userId);
    await main.keykeeperSiteFixes.refreshActive();
  });
  const after = await context.newPage();
  await after.goto(`${site}/simple-login.html`);
  const password = after.getByLabel("Password");
  await waitForExtensionScan(context, after, "password");
  await password.click();
  await chooseFirstInlineMenuItem(context, after, "Second login");
  await expect(password).toHaveValue("not-a-real-password-1");
  await expect(after.getByLabel("Username")).toHaveValue("");
});
