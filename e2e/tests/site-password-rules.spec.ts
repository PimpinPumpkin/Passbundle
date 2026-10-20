// Generated passwords follow the site's own published password rules
// (DESIGN.md, "Health (better than Watchtower)"). airfrance.com takes 8 to 12
// characters, with a lowercase and an uppercase letter and a digit, and only
// -!#$&+/?@_ besides; the generator's usual 14 characters are too long there.
// The page is the local fixture, under that name (see paths.mjs).
import { test as webTest, type BrowserContext, type Page } from "@playwright/test";

import { extensionFrame, hasElementDeep, waitForExtensionScan } from "./support/autofill";
import { createAccount, expect, logInPopup, openPopup, test, userFor } from "./support/extension";
import { signUp, webUserFor } from "./support/web";

/** airfrance.com's published rules, as a pattern, plus one of each required kind. */
function expectAirFranceRules(password: string) {
  expect(password).toMatch(/^[-A-Za-z0-9!#$&+/?@_]{8,12}$/);
  expect(password).toMatch(/[a-z]/);
  expect(password).toMatch(/[A-Z]/);
  expect(password).toMatch(/[0-9]/);
}

test.describe.configure({ timeout: 120_000 });

/** Fills the password the menu inside the new-password field suggests, and returns it. */
async function fillSuggestedPassword(context: BrowserContext, page: Page): Promise<string> {
  const field = page.getByLabel("New password");
  await waitForExtensionScan(context, page, "new-password");
  await field.click();
  const list = await extensionFrame(page, "menu-list.html");
  await expect
    .poll(
      () =>
        hasElementDeep(
          context,
          list,
          (n) => n.nodeType === 3 && (n.nodeValue ?? "").includes("Fill generated password"),
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
  // ArrowDown moves focus into the menu asynchronously; Enter waits for it.
  const focusLeftThePage = () => page.evaluate(() => document.activeElement?.tagName !== "INPUT");
  await expect(async () => {
    if (!(await focusLeftThePage())) {
      await page.keyboard.press("ArrowDown");
    }
    await expect.poll(focusLeftThePage, { timeout: 1000 }).toBe(true);
  }).toPass({ timeout: 10_000 });
  await page.keyboard.press("Enter");
  await expect(field).not.toHaveValue("");
  return field.inputValue();
}

test("a suggested password follows the site's own password rules, and is the usual one elsewhere", async ({
  context,
  extensionId,
}, testInfo) => {
  const user = userFor("site-rules", testInfo.repeatEachIndex);
  const web = await createAccount(context, user);
  await web.close();
  await logInPopup(await openPopup(context, extensionId), user);

  // A site without published rules gets the generator's usual password.
  const elsewhere = await context.newPage();
  await elsewhere.goto("https://signup.example.test/signup.html");
  expect(await fillSuggestedPassword(context, elsewhere)).toHaveLength(14);

  const site = await context.newPage();
  await site.goto("https://www.airfrance.com/signup.html");
  const password = await fillSuggestedPassword(context, site);
  expectAirFranceRules(password);
  await expect(site.getByLabel("Confirm password")).toHaveValue(password);
});

webTest("the item editor's generator follows the item's website's password rules, showing what it uses", async ({
  page,
}, testInfo) => {
  await signUp(page, webUserFor("site-rules-editor", testInfo.repeatEachIndex));
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Login" }).click();
  const item = page.getByRole("dialog", { name: "New Login" });
  await item.getByRole("textbox", { name: /Item name/ }).fill("Air France");
  // A website the way people type it, without https://.
  await item.getByRole("textbox", { name: "Website (URI)" }).fill("www.airfrance.com");
  await item.getByTestId("generate-password-button").click();

  const shown = page.locator("tools-password-generator bit-color-password").first();
  await expect(shown).not.toHaveText("");
  const offered = (await shown.textContent()) ?? "";
  await page.getByRole("button", { name: "Use this password" }).click();
  const password = item.getByRole("textbox", { name: "Password", exact: true });
  await expect(password).not.toHaveValue("");
  const used = await password.inputValue();
  expectAirFranceRules(used);
  // The one the generator showed (and would have copied), not another.
  expect(offered.replace(/\s/g, "")).toContain(used);
});
