// The Plan page and the plan banners in the web vault (DESIGN.md, "Plans and
// billing", "How a plan reaches the clients" and "What happens when payment
// stops"):
//
// - Where upstream's Subscription page (a person's) and Billing page (an
//   organization's owners') were, the Plan page says the plan's name, its
//   state and dates in words, and what it gives; an MSP's admins have the
//   pool's in the MSP console. A client of an MSP says "Covered by" and the
//   MSP's name. There's no button until a provider is set (`canPay`, which
//   no server sends yet), so none shows here.
// - Banners, from `keykeeperPlan` only: a trial ending, to whoever manages
//   the plan from 7 days out; a payment due, to whoever pays; and an
//   organization's plan having ended, to its owners and admins. Each links to
//   the Plan page where the person has one, and can be put away for the day.
// - Upstream's billing pages still can't be reached.
// - Where plans aren't enforced, there's no Plan page, no menu entry, and no
//   banner, whatever plan the operator recorded.
//
// The operator moves a plan's dates through the admin page, never the clock,
// on two servers of their own (one that enforces plans and one that
// doesn't), as plans-ui.spec.ts starts them. The dates a payment due ends on
// are the server's to say (`endsAt`); where it doesn't yet, the words leave
// them out, and these tests take either.
import { type Browser, type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";

import { brand, plansUiOffServerPort, plansUiServerPort } from "../paths.mjs";

import { type Account, Api } from "./api/support";
import { DAY, fromNow, inWords, type PlansServer, startPlansServer } from "./support/plans";
import { giveAuthenticator } from "./support/two-step";
import {
  acceptRole,
  chooseRole,
  menu,
  reloadVault,
  signUp,
  webUserFor,
  type WebUser,
} from "./support/web";

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

/** PLAN_GRACE_DAYS as the server ships it. */
const GRACE = 14 * DAY;

const STAYS =
  "If it isn't paid for by then, nothing new can be added to it. Everything in it can still be opened, changed, exported, and deleted.";
const ORGANIZATION_ENDED =
  "This organization's plan has ended, so nothing new can be added. Everything in it can still be opened, changed, exported, and deleted.";
const PREMIUM_FEATURES =
  "Premium's features: attaching files, sending files, the data breach report, and two-step login codes for your other accounts";

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A browser of its own on one of the two servers. */
async function browserOn(browser: Browser, server: PlansServer): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: server.url, ignoreHTTPSErrors: true });
  return { context, page: await context.newPage() };
}

/** A new account on a server, signed in and in its vault, with an authenticator app if asked. */
async function person(browser: Browser, server: PlansServer, prefix: string, repeat: number, authenticator = false) {
  const user: WebUser = { ...webUserFor(prefix, repeat), email: `${prefix}-${repeat}-${Date.now()}@example.test` };
  const { context, page } = await browserOn(browser, server);
  await signUp(page, user);
  if (authenticator) {
    await giveAuthenticator(context.request, user);
  }
  return { user, context, page };
}

/** The web vault's own access token, from its latest API request, for setup that needs no keys. */
function tokenOf(page: Page) {
  let token = "";
  page.on("request", (request) => {
    const header = request.headers()["authorization"];
    if (header?.startsWith("Bearer ") && request.url().includes("/api/")) {
      token = header.slice("Bearer ".length);
    }
  });
  return () => token;
}

const planPage = (page: Page) => page.getByTestId("keykeeper-plan");
const banners = (page: Page) => page.getByTestId("keykeeper-plan-banner");
const bannerFor = (page: Page, whose: string) => page.locator(`[data-testid="keykeeper-plan-banner"][data-whose="${whose}"]`);

/** The vault page, synced again. */
async function vault(page: Page) {
  await page.goto("/#/vault");
  await reloadVault(page);
}

/** A person's Plan page, opened from Settings in the menu. */
async function openPersonalPlan(page: Page) {
  await vault(page);
  await menu(page).getByRole("button", { name: "Settings" }).click();
  await menu(page).getByRole("link", { name: "Plan", exact: true }).click();
  await page.waitForURL(/#\/settings\/plan$/);
  await expect(planPage(page)).toBeVisible();
}

async function expectStatus(page: Page, lines: (string | RegExp)[]) {
  await expect(planPage(page).getByTestId("keykeeper-plan-status")).toHaveText(lines);
}

/** No button: no provider is set on these servers, so the server never says `canPay`. */
async function expectNoButton(page: Page) {
  await expect(page.getByTestId("keykeeper-plan-button")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Set up payment|Manage payment/ })).toHaveCount(0);
}

/** Puts a banner away, and checks it stays away for the day, a reload included. */
async function putAway(page: Page, banner: Locator) {
  await banner.getByRole("button", { name: "Close" }).click();
  await expect(banner).toHaveCount(0);
  await vault(page);
  await expect(banner).toHaveCount(0);
}

/** A business organization, made in the web vault by its owner. Its id. */
async function createBusiness(owner: Page, name: string): Promise<string> {
  await owner.goto("/#/create-organization");
  await owner.getByRole("textbox", { name: /Organization name/ }).fill(name);
  await owner.getByRole("radio", { name: /A business/ }).check();
  await owner.getByRole("button", { name: "Create organization" }).click();
  await owner.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  return /organizations\/([0-9a-f-]{36})/.exec(owner.url())![1];
}

async function invite(owner: Page, email: string, role: "Admin" | "User") {
  await owner.getByRole("button", { name: "Invite member" }).click();
  const dialog = owner.getByRole("dialog", { name: /Invite member/ });
  await dialog.getByRole("textbox", { name: /Email/ }).fill(email);
  await chooseRole(dialog, role);
  await dialog.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(dialog).toBeHidden();
}

test.describe("where plans are enforced", () => {
  test("a person's Plan page says their plan and its dates in each state, and whoever pays is told a payment is due", async ({
    browser,
  }, testInfo) => {
    test.setTimeout(240_000);
    const { user, page, context } = await person(browser, enforced, "plan-page-person", testInfo.repeatEachIndex);

    // Free: what Premium has, with the Pricing page, and no button.
    await openPersonalPlan(page);
    await expect(planPage(page).getByTestId("keykeeper-plan-name")).toHaveText("Free");
    await expectStatus(page, []);
    const note = planPage(page).getByTestId("keykeeper-plan-note");
    await expect(note).toContainText(
      "Attaching files, sending files, the data breach report, and two-step login codes for your other accounts are part of Premium.",
    );
    await expect(note.getByRole("link", { name: "See pricing" })).toHaveAttribute("href", `${brand.urls.website}/pricing/`);
    await expectNoButton(page);

    // Premium that renews.
    const until = fromNow(30 * DAY);
    await enforced.operator.setPersonsPlan(user.email, { plan: "premium", standing: "until", until, renews: true });
    await openPersonalPlan(page);
    await expect(planPage(page).getByTestId("keykeeper-plan-name")).toHaveText("Premium");
    await expectStatus(page, [`Paid through ${inWords(until)}`, `Renews on ${inWords(until)}`]);
    await expect(planPage(page).getByTestId("keykeeper-plan-gives")).toHaveText(
      new RegExp(`5 GB for attachments\\s*${escape(PREMIUM_FEATURES)}`),
    );
    await expect(planPage(page).getByTestId("keykeeper-plan-note")).toHaveCount(0);
    await expectNoButton(page);
    // Nothing to say on the vault page.
    await vault(page);
    await expect(banners(page)).toHaveCount(0);

    // Canceled: it ends then.
    await enforced.operator.setPersonsPlan(user.email, { plan: "premium", standing: "until", until, renews: false });
    await openPersonalPlan(page);
    await expectStatus(page, [`Paid through ${inWords(until)}`, `Ends on ${inWords(until)}`]);

    // A payment that didn't come: grace, and a banner for whoever pays.
    const lapsed = fromNow(-2 * DAY);
    const graceEnds = new Date(new Date(lapsed).getTime() + GRACE).toISOString();
    await enforced.operator.setPersonsPlan(user.email, { plan: "premium", standing: "until", until: lapsed, renews: true });
    await openPersonalPlan(page);
    await expectStatus(page, [
      new RegExp(`^\\s*Payment due\\. Paid through ${inWords(lapsed)}(; it ends on ${inWords(graceEnds)})?\\.\\s*$`),
    ]);
    await vault(page);
    const due = bannerFor(page, "person");
    await expect(due).toHaveAttribute("data-kind", "paymentDue");
    await expect(due).toContainText(
      new RegExp(
        `A payment for your Premium is due\\. It was paid through ${inWords(lapsed)}(, and it ends on ${inWords(graceEnds)} if it isn't paid by then)?\\.`,
      ),
    );
    // No countdown: the date in words.
    await expect(due).not.toContainText(/days? left|\d+ days/);
    const link = due.getByRole("link", { name: "See plan" });
    await expect(link).toHaveAttribute("href", "#/settings/plan");
    await link.click();
    await page.waitForURL(/#\/settings\/plan$/);
    await expect(planPage(page)).toBeVisible();
    // Put away for the day.
    await vault(page);
    await putAway(page, bannerFor(page, "person"));

    // Past grace: ended, and everything stays.
    const longAgo = fromNow(-20 * DAY);
    await enforced.operator.setPersonsPlan(user.email, { plan: "premium", standing: "until", until: longAgo, renews: true });
    await openPersonalPlan(page);
    await expectStatus(page, [
      new RegExp(`^\\s*Ended( on ${inWords(new Date(new Date(longAgo).getTime() + GRACE).toISOString())})?\\s*$`),
    ]);
    await expect(planPage(page).getByTestId("keykeeper-plan-note")).toHaveText(
      "You're on Free now. Everything you saved stays, and files you attached can still be downloaded and removed.",
    );
    await expectNoButton(page);
    // A person whose own Premium ended gets no banner.
    await vault(page);
    await expect(banners(page)).toHaveCount(0);

    await context.close();
  });

  test("an organization's owners have its Plan page, and its banners reach owners, admins, and nobody else", async ({
    browser,
  }, testInfo) => {
    test.setTimeout(300_000);
    const index = testInfo.repeatEachIndex;
    // The admin and the member sign up first, so their invitations join them
    // at once (these servers send no email).
    const admin = await person(browser, enforced, "plan-page-admin", index, true);
    const member = await person(browser, enforced, "plan-page-member", index);
    const owner = await person(browser, enforced, "plan-page-owner", index, true);
    const orgId = await createBusiness(owner.page, "Acme Dental");
    await invite(owner.page, admin.user.email, "Admin");
    await invite(owner.page, member.user.email, "User");
    await acceptRole(admin.page);
    // The owner's web vault lets them in on its own when it opens Members.
    await owner.page.goto("/#/vault");
    await owner.page.goto(`/#/organizations/${orgId}/members`);
    for (const email of [admin.user.email, member.user.email]) {
      const row = owner.page.getByRole("row").filter({ hasText: email });
      await expect(row).toBeVisible();
      await expect(row.getByText("Needs confirmation")).toHaveCount(0, { timeout: 30_000 });
    }

    // A trial more than 7 days from its end: no banner yet.
    await enforced.operator.setPlan("organizations", orgId, {
      plan: "business",
      freeUntil: fromNow(10 * DAY),
      freeWhy: "trial",
      standing: "none",
      renews: false,
    });
    await vault(owner.page);
    await expect(bannerFor(owner.page, `organization:${orgId}`)).toHaveCount(0);

    // Within 7 days: the owner is told, with the date in words and a link to the Plan page.
    const trialEnds = fromNow(5 * DAY);
    await enforced.operator.setPlan("organizations", orgId, {
      plan: "business",
      freeUntil: trialEnds,
      freeWhy: "trial",
      standing: "none",
      renews: false,
    });
    await vault(owner.page);
    const trial = bannerFor(owner.page, `organization:${orgId}`);
    await expect(trial).toHaveAttribute("data-kind", "trialEnding");
    await expect(trial).toContainText(`The trial for Acme Dental ends on ${inWords(trialEnds)}. ${STAYS}`);
    await expect(trial).not.toContainText(/days? left|\d+ days/);
    // Admins and members don't manage the plan: no banner for them.
    for (const someone of [admin.page, member.page]) {
      await vault(someone);
      await expect(banners(someone)).toHaveCount(0);
    }

    // The owner's Plan page, from the banner and from the admin console's menu.
    await trial.getByRole("link", { name: "See plan" }).click();
    await owner.page.waitForURL(new RegExp(`#/organizations/${orgId}/plan$`));
    await expect(planPage(owner.page).getByTestId("keykeeper-plan-name")).toHaveText("Business");
    await expectStatus(owner.page, [`Trial until ${inWords(trialEnds)}`]);
    await expect(planPage(owner.page).getByTestId("keykeeper-plan-gives")).toContainText("Any number of people");
    await expect(planPage(owner.page).getByTestId("keykeeper-plan-gives")).toContainText(
      "Premium's features for every member",
    );
    await expect(planPage(owner.page).getByTestId("keykeeper-plan-covered-by")).toHaveCount(0);
    await expectNoButton(owner.page);
    const adminMenu = owner.page.getByRole("navigation", { name: "Side navigation" });
    await expect(adminMenu.getByRole("link", { name: "Plan", exact: true })).toBeVisible();
    await expect(adminMenu.getByRole("link", { name: "Billing" })).toHaveCount(0);

    // An admin has no Plan page: no menu entry, and its address opens the vault.
    await admin.page.goto(`/#/organizations/${orgId}/members`);
    await expect(admin.page.getByRole("navigation", { name: "Side navigation" }).getByRole("link", { name: "Members" }).first()).toBeVisible();
    await expect(admin.page.getByRole("navigation", { name: "Side navigation" }).getByRole("link", { name: "Plan", exact: true })).toHaveCount(0);
    await admin.page.goto(`/#/organizations/${orgId}/plan`);
    await admin.page.waitForURL(/#\/vault/);

    // A payment due: the owner, who pays, is told.
    const lapsed = fromNow(-3 * DAY);
    await enforced.operator.setPlan("organizations", orgId, { plan: "business", standing: "until", until: lapsed, renews: true });
    await vault(owner.page);
    await expect(bannerFor(owner.page, `organization:${orgId}`)).toHaveAttribute("data-kind", "paymentDue");
    await expect(bannerFor(owner.page, `organization:${orgId}`)).toContainText(
      new RegExp(`^\\s*A payment for Acme Dental is due\\. It was paid through ${inWords(lapsed)}`),
    );
    await vault(admin.page);
    await expect(banners(admin.page)).toHaveCount(0);

    // Ended: owners and admins are told nothing new can be added and
    // everything can still be opened, changed, exported, and deleted; the
    // owner's links to the Plan page, the admin's doesn't. Members aren't told.
    const ended = fromNow(-1 * DAY);
    await enforced.operator.setPlan("organizations", orgId, {
      plan: "business",
      freeUntil: ended,
      freeWhy: "trial",
      standing: "none",
      renews: false,
    });
    const endedWords =
      "The plan for Acme Dental has ended, so nothing new can be added to it. Everything in it can still be opened, changed, exported, and deleted.";
    await vault(owner.page);
    const ownersBanner = bannerFor(owner.page, `organization:${orgId}`);
    await expect(ownersBanner).toHaveAttribute("data-kind", "ended");
    await expect(ownersBanner).toContainText(endedWords);
    await expect(ownersBanner.getByRole("link", { name: "See plan" })).toHaveAttribute(
      "href",
      `#/organizations/${orgId}/plan`,
    );
    await vault(admin.page);
    const adminsBanner = bannerFor(admin.page, `organization:${orgId}`);
    await expect(adminsBanner).toContainText(endedWords);
    await expect(adminsBanner.getByRole("link")).toHaveCount(0);
    await vault(member.page);
    await expect(banners(member.page)).toHaveCount(0);

    // The owner's Plan page says so.
    await owner.page.goto(`/#/organizations/${orgId}/plan`);
    await expectStatus(owner.page, [new RegExp(`^\\s*Ended( on ${inWords(ended)})?\\s*$`)]);
    await expect(planPage(owner.page).getByTestId("keykeeper-plan-note")).toHaveText(ORGANIZATION_ENDED);
    await expect(planPage(owner.page).getByTestId("keykeeper-plan-gives")).toHaveCount(0);

    // Each puts theirs away for the day; the other's stays.
    await vault(owner.page);
    await putAway(owner.page, bannerFor(owner.page, `organization:${orgId}`));
    await vault(admin.page);
    await expect(bannerFor(admin.page, `organization:${orgId}`)).toHaveCount(1);

    for (const someone of [owner, admin, member]) {
      await someone.context.close();
    }
  });

  test("a client of an MSP is covered by the MSP, and the pool's plan is in the MSP console for its admins", async ({
    browser,
  }, testInfo) => {
    test.setTimeout(240_000);
    const { user, page, context } = await person(browser, enforced, "plan-page-msp", testInfo.repeatEachIndex, true);
    const token = tokenOf(page);
    await page.goto("/#/msp");
    await page.getByRole("textbox", { name: "Your MSP's name" }).fill("Contoso IT");
    await page.getByRole("button", { name: "Create MSP" }).click();
    await page.getByRole("textbox", { name: "New client's name" }).fill("Baker Law");
    await page.getByRole("button", { name: "Add client" }).click();
    await expect(page.getByText("Added Baker Law", { exact: true })).toBeVisible();

    const api = new Api(context.request);
    const admin: Account = { email: user.email, password: "", token: token(), userId: "" };
    const mspId = (await api.call(admin, "GET", "/api/keykeeper/msp")).body.data.find(
      (m: { name: string }) => m.name === "Contoso IT",
    ).id as string;
    const clientId = ((await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}`)).body.clients as {
      id: string;
      name: string;
    }[]).find((c) => c.name === "Baker Law")!.id;

    // The pool's trial, 6 days from its end.
    const trialEnds = fromNow(6 * DAY);
    await enforced.operator.setPlan("msps", mspId, {
      plan: "msp",
      freeUntil: trialEnds,
      freeWhy: "trial",
      standing: "none",
      renews: false,
    });

    // The MSP console: the pool's Plan section, with its notice.
    await vault(page);
    await page.goto("/#/msp");
    const section = page.getByTestId("msp-plan");
    await expect(section.getByRole("heading", { name: "Plan" })).toBeVisible();
    await expect(section.getByTestId("keykeeper-plan-name")).toHaveText("MSP seat pool");
    await expect(section.getByTestId("keykeeper-plan-status")).toHaveText([`Trial until ${inWords(trialEnds)}`]);
    await expect(section.getByTestId("keykeeper-plan-gives")).toContainText(
      "Every client covered as Business, with any number of people",
    );
    const notice = section.getByTestId("keykeeper-plan-banner");
    await expect(notice).toHaveAttribute("data-whose", `msp:${mspId}`);
    await expect(notice).toContainText(
      `The trial for Contoso IT ends on ${inWords(trialEnds)}. If it isn't paid for by then, nothing new can be added to your clients. Everything in them can still be opened, changed, exported, and deleted.`,
    );
    await expectNoButton(page);

    // The client is covered by the MSP: its Plan page says so, with no
    // button, and the vault page has no banner of the client's own.
    await page.goto(`/#/organizations/${clientId}/plan`);
    await expect(planPage(page).getByTestId("keykeeper-plan-name")).toHaveText("MSP seat pool");
    await expect(planPage(page).getByTestId("keykeeper-plan-covered-by")).toHaveText("Covered by Contoso IT");
    await expectNoButton(page);
    await vault(page);
    await expect(bannerFor(page, `organization:${clientId}`)).toHaveCount(0);

    // The notice in the console is put away for the day.
    await page.goto("/#/msp");
    await expect(notice).toBeVisible();
    await notice.getByRole("button", { name: "Close" }).click();
    await expect(notice).toHaveCount(0);
    await page.goto("/#/vault");
    await page.goto("/#/msp");
    await expect(section.getByTestId("keykeeper-plan-name")).toHaveText("MSP seat pool");
    await expect(notice).toHaveCount(0);

    await context.close();
  });

  test("upstream's billing pages still can't be reached, with the Plan page in their place", async ({ browser }, testInfo) => {
    const { page, context } = await person(browser, enforced, "plan-page-billing", testInfo.repeatEachIndex);
    for (const address of ["/#/settings/subscription", "/#/settings/subscription/premium", "/#/premium/checkout/success"]) {
      await page.goto(address);
      await page.waitForURL(/#\/vault/);
    }
    await menu(page).getByRole("button", { name: "Settings" }).click();
    await expect(menu(page).getByRole("link", { name: "Plan", exact: true })).toBeVisible();
    await expect(menu(page).getByRole("link", { name: "Subscription" })).toHaveCount(0);
    await context.close();
  });
});

test.describe("where plans aren't enforced", () => {
  test("there's no Plan page, no menu entry, and no banner, whatever plan is recorded", async ({ browser }, testInfo) => {
    test.setTimeout(240_000);
    const { user, page, context } = await person(browser, unenforced, "plan-page-off", testInfo.repeatEachIndex, true);
    const orgId = await createBusiness(page, "Fabrikam");
    // Plans that would say something where they're enforced: a payment due,
    // and an organization whose plan has ended.
    await unenforced.operator.setPersonsPlan(user.email, {
      plan: "premium",
      standing: "until",
      until: fromNow(-2 * DAY),
      renews: true,
    });
    await unenforced.operator.setPlan("organizations", orgId, {
      plan: "business",
      freeUntil: fromNow(-1 * DAY),
      freeWhy: "trial",
      standing: "none",
      renews: false,
    });

    await vault(page);
    await expect(banners(page)).toHaveCount(0);
    await menu(page).getByRole("button", { name: "Settings" }).click();
    await expect(menu(page).getByRole("link", { name: "My account" })).toBeVisible();
    await expect(menu(page).getByRole("link", { name: "Plan", exact: true })).toHaveCount(0);
    await page.goto("/#/settings/plan");
    await page.waitForURL(/#\/vault/);
    await expect(planPage(page)).toHaveCount(0);

    await page.goto(`/#/organizations/${orgId}/members`);
    const adminMenu = page.getByRole("navigation", { name: "Side navigation" });
    await expect(adminMenu.getByRole("link", { name: "Members" }).first()).toBeVisible();
    await expect(adminMenu.getByRole("link", { name: "Plan", exact: true })).toHaveCount(0);
    await page.goto(`/#/organizations/${orgId}/plan`);
    await page.waitForURL(/#\/vault/);
    await expect(banners(page)).toHaveCount(0);

    // The MSP console has no Plan section.
    await page.goto("/#/msp");
    await page.getByRole("textbox", { name: "Your MSP's name" }).fill("Northwind IT");
    await page.getByRole("button", { name: "Create MSP" }).click();
    await expect(page.getByTestId("msp-name")).toContainText("Northwind IT");
    await expect(page.getByTestId("msp-plan")).toHaveCount(0);
    await expect(page.getByTestId("keykeeper-plan")).toHaveCount(0);

    await context.close();
  });
});
