// What the web vault shows on each plan (DESIGN.md, "Plans and billing",
// "What Free is promised must not sit behind `premium`" and "Upstream's
// billing pages go"):
//
// - Legacy contacts and the weak, reused and exposed password reports are
//   free. The data breach report is Premium, and says so in the server's own
//   sentence, with a link to the Pricing page on the website.
// - The attachments window opens for any item that has files, on any plan, so
//   a file can be downloaded and removed. Adding one is off without Premium,
//   with the plain sentence in place of the file picker.
// - Upstream's Subscription, Premium, payment and billing pages, and an
//   organization's Billing pages, are out of the menus, and their addresses
//   open the vault.
// - Where plans aren't enforced (every self-hosted server unless it turns
//   PLANS_ENFORCED on), everyone has Premium and nothing is held back.
//
// The operator sets and takes away plans through the admin page, which no
// other test server has on, so these tests start two servers of their own:
// one that enforces plans and one that doesn't.
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";

import { brand, plansUiOffServerPort, plansUiServerPort } from "../paths.mjs";

import { attachFile, openAttachments, type PlansServer, saveLogin, startPlansServer } from "./support/plans";
import { menu, reloadVault, signUp, webUserFor, type WebUser } from "./support/web";

test.describe.configure({ mode: "serial" });

let enforced: PlansServer;
let unenforced: PlansServer;

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(150_000);
  enforced = await startPlansServer(playwright, plansUiServerPort, true);
  unenforced = await startPlansServer(playwright, plansUiOffServerPort, false);
});

test.afterAll(async () => {
  await enforced?.stop();
  await unenforced?.stop();
});

/** The Pricing page on the website, as brand.json names the website. */
const pricingPage = `${brand.urls.website}/pricing/`;

/** A browser of its own on one of the two servers. */
async function browserOn(browser: Browser, server: PlansServer): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: server.url, ignoreHTTPSErrors: true });
  return { context, page: await context.newPage() };
}

/** A new account on a server, signed in and in its vault. */
async function person(browser: Browser, server: PlansServer, prefix: string, repeat: number) {
  const user: WebUser = { ...webUserFor(prefix, repeat), email: `${prefix}-${repeat}-${Date.now()}@example.test` };
  const { context, page } = await browserOn(browser, server);
  await signUp(page, user);
  return { user, context, page };
}

/** The plan notice window: a sentence, a link to the Pricing page, and Close. */
function planNotice(page: Page) {
  return page.getByTestId("keykeeper-plan-notice-dialog");
}

async function expectPlanNotice(page: Page, title: string, sentence: string) {
  const notice = planNotice(page);
  await expect(notice).toBeVisible();
  await expect(notice.getByRole("heading", { name: title })).toBeVisible();
  await expect(notice.getByTestId("keykeeper-plan-notice")).toContainText(sentence);
  const pricing = notice.getByRole("link", { name: "See pricing" });
  await expect(pricing).toHaveAttribute("href", pricingPage);
  await expect(pricing).toHaveAttribute("target", "_blank");
  await notice.getByRole("button", { name: "Close" }).click();
  await expect(notice).toBeHidden();
}

/** A card on the Reports page, by its title. */
function reportCard(page: Page, title: string) {
  return page.locator("app-report-card").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
}

test.describe("where plans are enforced", () => {
  test("a Free account adds a legacy contact", async ({ browser }, testInfo) => {
    const contact = await person(browser, enforced, "plans-contact", testInfo.repeatEachIndex);
    const { page, context } = await person(browser, enforced, "plans-free-contacts", testInfo.repeatEachIndex);

    await page.goto("/#/settings/emergency-access");
    const add = page.getByTestId("keykeeper-add-legacy-contact");
    await expect(add).toBeEnabled();
    // No Premium badge beside the heading. (The menu's, beside Archive, is
    // Archive's, which stays with Premium.)
    await expect(page.locator("bit-container app-premium-badge")).toHaveCount(0);

    await add.click();
    const dialog = page.getByRole("dialog", { name: /Invite emergency contact/ });
    await dialog.getByRole("textbox", { name: "Email" }).fill(contact.user.email);
    await dialog.getByText("View", { exact: true }).click();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    // The test servers send no email, so the invitation is taken at once and
    // waits for the person to confirm it, which Free can do too.
    const row = page.getByRole("row").filter({ hasText: contact.user.email });
    await expect(row.getByText("Needs confirmation")).toBeVisible();
    await row.getByRole("button", { name: "Options" }).click();
    await page.getByRole("menuitem", { name: "Confirm" }).click();
    const confirm = page.getByRole("dialog", { name: /Confirm user/ });
    await confirm.getByRole("button", { name: "Confirm" }).click();
    await expect(confirm).toBeHidden();
    await expect(row.getByText("Needs confirmation")).toHaveCount(0);
    await expect(row).toContainText(contact.user.email);

    await context.close();
    await contact.context.close();
  });

  test("a Free account opens the weak, reused and exposed password reports", async ({ browser }, testInfo) => {
    const { page, context } = await person(browser, enforced, "plans-free-reports", testInfo.repeatEachIndex);

    for (const [title, address, heading] of [
      ["Weak passwords", /#\/reports\/weak-passwords-report/, "Weak passwords"],
      ["Reused passwords", /#\/reports\/reused-passwords-report/, "Reused passwords"],
      ["Exposed passwords", /#\/reports\/exposed-passwords-report/, "Exposed passwords"],
    ] as const) {
      await page.goto("/#/reports");
      const card = reportCard(page, title);
      await expect(card).toBeVisible();
      await expect(card.locator("app-premium-badge")).toHaveCount(0);
      await card.click();
      await page.waitForURL(address);
      await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
      await expect(planNotice(page)).toHaveCount(0);
    }

    // Typed in, too.
    await page.goto("/#/reports/weak-passwords-report");
    await page.waitForURL(/#\/reports\/weak-passwords-report/);
    await expect(planNotice(page)).toHaveCount(0);

    await context.close();
  });

  test("the data breach report asks for Premium on Free and opens on Premium", async ({ browser }, testInfo) => {
    const { user, page, context } = await person(browser, enforced, "plans-breach", testInfo.repeatEachIndex);

    await page.goto("/#/reports");
    const card = reportCard(page, "Data breach");
    await expect(card.getByRole("button", { name: "Upgrade" })).toBeVisible();

    // The badge says the server's sentence.
    await card.getByRole("button", { name: "Upgrade" }).click();
    await expectPlanNotice(page, "Premium", "The data breach report is part of Premium.");

    // So does the card, and the person stays on the list of reports.
    await card.click();
    await expectPlanNotice(page, "Premium", "The data breach report is part of Premium.");
    await expect(page).toHaveURL(/#\/reports$/);

    // And the report's address.
    await page.goto("/#/reports/breach-report");
    await expectPlanNotice(page, "Premium", "The data breach report is part of Premium.");
    await expect(page).toHaveURL(/#\/reports$/);
    await expect(page.getByRole("button", { name: "Check breaches" })).toHaveCount(0);

    await enforced.operator.givePremium(user.email);
    await reloadVault(page);
    await page.goto("/#/reports");
    await expect(reportCard(page, "Data breach").getByRole("button", { name: "Upgrade" })).toHaveCount(0);
    await reportCard(page, "Data breach").click();
    await page.waitForURL(/#\/reports\/breach-report/);
    await expect(page.getByRole("button", { name: "Check breaches" })).toBeVisible();
    await expect(planNotice(page)).toHaveCount(0);

    await context.close();
  });

  test("a file attached on Premium can be downloaded and removed once the plan is taken away", async ({
    browser,
  }, testInfo) => {
    test.setTimeout(120_000);
    const { user, page, context } = await person(browser, enforced, "plans-files", testInfo.repeatEachIndex);

    // On Premium, a file goes on.
    await enforced.operator.givePremium(user.email);
    await reloadVault(page);
    await saveLogin(page, "Lease");
    await saveLogin(page, "Gym");
    await attachFile(page, "Lease", "lease.txt");

    // The plan is taken away.
    await enforced.operator.takePlanAway(user.email);
    await reloadVault(page);

    // An item with a file: the window opens, the file can be downloaded, and
    // adding is off with the sentence.
    const edit = await openAttachments(page, "Lease");
    const files = page.getByRole("dialog", { name: "Attachments" });
    await expect(files.getByTestId("file-name")).toHaveCount(1);
    await expect(files.getByTestId("file-name")).toContainText("lease.txt");
    await expect(files.getByTestId("keykeeper-attaching-off")).toContainText("Attaching files is part of Premium.");
    const off = files.getByTestId("keykeeper-attaching-off");
    await expect(off.getByRole("link", { name: "See pricing" })).toHaveAttribute("href", pricingPage);
    await expect(files.locator("bit-file-upload")).toHaveCount(0);
    await expect(files.getByRole("button", { name: "Upload" })).toHaveCount(0);

    const download = page.waitForEvent("download");
    await files.getByRole("button", { name: "Download" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("lease.txt");

    // And removed.
    await files.getByRole("button", { name: "Delete attachment" }).click();
    await page.getByRole("dialog", { name: /Delete attachment/ }).getByRole("button", { name: "Yes" }).click();
    await expect(page.getByText("Deleted attachment")).toBeVisible();
    // Removing a file closes the window, as it always has.
    await expect(files).toBeHidden();
    // Premium's badge beside Attachments says the same sentence.
    await edit.locator("app-premium-badge").getByRole("button", { name: "Upgrade" }).click();
    await expectPlanNotice(page, "Premium", "Attaching files is part of Premium.");
    await edit.getByRole("button", { name: "Cancel" }).click();
    await expect(edit).toBeHidden();

    // An item with no files and no right to add: the sentence, no window.
    await reloadVault(page);
    await openAttachments(page, "Gym");
    await expectPlanNotice(page, "Premium", "Attaching files is part of Premium.");
    await expect(page.getByRole("dialog", { name: "Attachments" })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Add attachment" })).toHaveCount(0);

    await context.close();
  });

  test("upstream's billing pages can't be reached and aren't in the menus", async ({ browser }, testInfo) => {
    test.setTimeout(120_000);
    const { page, context } = await person(browser, enforced, "plans-billing", testInfo.repeatEachIndex);

    // A person's: Subscription, Premium, payment method, billing history, checkout.
    for (const address of [
      "/#/settings/subscription",
      "/#/settings/subscription/premium",
      "/#/settings/subscription/user-subscription",
      "/#/settings/subscription/payment-details",
      "/#/settings/subscription/billing-history",
      "/#/premium/checkout/success",
    ]) {
      await page.goto(address);
      await page.waitForURL(/#\/vault/);
      await expect(menu(page)).toBeVisible();
    }
    await menu(page).getByRole("button", { name: "Settings" }).click();
    await expect(menu(page).getByRole("link", { name: "My account" })).toBeVisible();
    await expect(menu(page).getByRole("link", { name: "Subscription" })).toHaveCount(0);
    await expect(menu(page).getByText(/Upgrade/)).toHaveCount(0);
    await expect(page.locator("app-upgrade-nav-button, app-upgrade-callout")).toHaveCount(0);

    // An organization owner's Billing pages.
    await page.goto("/#/create-organization");
    await page.getByRole("textbox", { name: /Organization name/ }).fill("Harbor family");
    await page.getByRole("radio", { name: /A family or a group/ }).check();
    await page.getByRole("button", { name: "Create organization" }).click();
    await page.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
    const orgId = /organizations\/([0-9a-f-]{36})/.exec(page.url())![1];
    const adminMenu = page.getByRole("navigation", { name: "Side navigation" });
    await expect(adminMenu.getByRole("link", { name: "Members" }).first()).toBeVisible();
    await expect(adminMenu.getByRole("button", { name: "Billing" })).toHaveCount(0);
    await expect(adminMenu.getByRole("link", { name: "Billing" })).toHaveCount(0);
    for (const page_ of ["subscription", "payment-details", "history", ""]) {
      await page.goto(`/#/organizations/${orgId}/billing/${page_}`);
      await page.waitForURL(/#\/vault/);
    }

    await context.close();
  });
});

test.describe("where plans aren't enforced", () => {
  test("nothing is held back", async ({ browser }, testInfo) => {
    test.setTimeout(120_000);
    const { page, context } = await person(browser, unenforced, "plans-off", testInfo.repeatEachIndex);

    // Every report opens, with no Premium badge.
    await page.goto("/#/reports");
    await expect(reportCard(page, "Data breach")).toBeVisible();
    await expect(page.locator("app-report-card app-premium-badge button")).toHaveCount(0);
    await reportCard(page, "Data breach").click();
    await page.waitForURL(/#\/reports\/breach-report/);
    await expect(page.getByRole("button", { name: "Check breaches" })).toBeVisible();

    // Legacy contacts as before.
    await page.goto("/#/settings/emergency-access");
    await expect(page.getByTestId("keykeeper-add-legacy-contact")).toBeEnabled();

    // Files go on as before.
    await page.goto("/#/vault");
    await saveLogin(page, "Passport scan");
    await openAttachments(page, "Passport scan");
    const adding = page.getByRole("dialog", { name: "Add attachment" });
    await expect(adding.locator("bit-file-upload")).toBeVisible();
    await expect(adding.getByRole("button", { name: "Upload" })).toBeVisible();
    await expect(adding.getByTestId("keykeeper-attaching-off")).toHaveCount(0);

    // No plan sentence anywhere.
    await expect(page.getByTestId("keykeeper-plan-notice")).toHaveCount(0);

    await context.close();
  });
});
