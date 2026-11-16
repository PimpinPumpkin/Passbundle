// What the extension shows on each plan (DESIGN.md, "Plans and billing"): the
// attachments page opens for any item that has files, on any plan, so a file
// can be downloaded and removed, with adding off and the plain sentence
// without Premium; an item with no files and no right to add says the
// sentence instead of opening the page. The web vault's side is
// plans-ui.spec.ts. This file starts a server of its own that enforces plans,
// with the admin page on so the operator can set and take away plans.
//
// And the plan banners (DESIGN.md, "What happens when payment stops"), from
// `keykeeperPlan` only: a payment due, to whoever pays, and an organization's
// plan having ended, to its owners and admins, each linking to the web
// vault's Plan page in a new tab and put away for the day. The web vault's
// side is plans-page.spec.ts.
import { brand, plansUiServerPort } from "../paths.mjs";

import {
  createAccount,
  expect,
  logInPopup,
  openPopup,
  test,
  userFor,
} from "./support/extension";
import { attachFile, DAY, fromNow, inWords, type PlansServer, saveLogin, startPlansServer } from "./support/plans";
import { reloadVault } from "./support/web";

test.describe.configure({ mode: "serial" });

let enforced: PlansServer;

test.beforeAll(async ({ playwright }) => {
  enforced = await startPlansServer(playwright, plansUiServerPort, true);
});

test.afterAll(async () => {
  await enforced?.stop();
});

test("a file attached on Premium opens in the extension once the plan is taken away, and adding is off", async ({
  context,
  extensionId,
}, testInfo) => {
  test.setTimeout(180_000);
  const user = {
    ...userFor("plans-ext-files", testInfo.repeatEachIndex),
    email: `plans-ext-files-${testInfo.repeatEachIndex}-${Date.now()}@example.test`,
  };

  // On Premium, in the web vault, a file goes on one login; another has none.
  const web = await createAccount(context, user, enforced.url);
  await enforced.operator.givePremium(user.email);
  await reloadVault(web);
  await saveLogin(web, "Lease");
  await saveLogin(web, "Gym");
  await attachFile(web, "Lease", "lease.txt");
  await enforced.operator.takePlanAway(user.email);
  await web.close();

  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, user, enforced.url);
  // Opened again, as a popup is each time it's clicked.
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html#/tabs/settings`);
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html#/tabs/vault`);

  // The item with a file: its attachments page lists it, with no Upload and
  // the sentence where the file picker was.
  await popup.locator("#allItems bit-item").filter({ hasText: "Lease" }).getByText("Lease", { exact: true }).click();
  await expect(popup.getByRole("heading", { level: 1, name: "Lease" })).toBeVisible();
  await popup.getByTestId("keykeeper-edit").click();
  const opener = popup.locator("app-open-attachments");
  await expect(opener.locator("app-premium-badge")).toHaveCount(1);
  await opener.getByRole("button", { name: /Attachments/ }).click();
  await popup.waitForURL(/#\/attachments\?/);
  await expect(popup.getByTestId("file-name")).toHaveCount(1);
  await expect(popup.getByTestId("file-name")).toContainText("lease.txt");
  await expect(popup.getByTestId("keykeeper-attaching-off")).toContainText("Attaching files is part of Premium.");
  await expect(popup.getByTestId("keykeeper-attaching-off").getByRole("link", { name: "See pricing" })).toHaveAttribute(
    "href",
    `${brand.urls.website}/pricing/`,
  );
  await expect(popup.locator("bit-file-upload")).toHaveCount(0);
  await expect(popup.getByRole("button", { name: "Upload" })).toBeHidden();
  await expect(popup.getByRole("button", { name: "Download" })).toBeVisible();
  await expect(popup.getByRole("button", { name: "Delete attachment" })).toBeVisible();
  await popup.getByRole("button", { name: "Close", exact: true }).click();

  // The item with no files: the sentence, and the page doesn't open.
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html#/tabs/vault`);
  await popup.locator("#allItems bit-item").filter({ hasText: "Gym" }).getByText("Gym", { exact: true }).click();
  await expect(popup.getByRole("heading", { level: 1, name: "Gym" })).toBeVisible();
  await popup.getByTestId("keykeeper-edit").click();
  await popup.locator("app-open-attachments").getByRole("button", { name: /Attachments/ }).click();
  const notice = popup.getByTestId("keykeeper-plan-notice-dialog");
  await expect(notice).toContainText("Attaching files is part of Premium.");
  await expect(notice.getByRole("link", { name: "See pricing" })).toHaveAttribute(
    "href",
    `${brand.urls.website}/pricing/`,
  );
  await notice.getByRole("button", { name: "Close" }).click();
  await expect(notice).toBeHidden();
  await expect(popup).not.toHaveURL(/#\/attachments/);
});

test("the extension tells whoever pays that a payment is due, and an owner that their organization's plan has ended", async ({
  context,
  extensionId,
}, testInfo) => {
  test.setTimeout(180_000);
  const user = {
    ...userFor("plans-ext-banners", testInfo.repeatEachIndex),
    email: `plans-ext-banners-${testInfo.repeatEachIndex}-${Date.now()}@example.test`,
  };

  // In the web vault: an organization of their own, which they own.
  const web = await createAccount(context, user, enforced.url);
  await web.goto(`${enforced.url}/#/create-organization`);
  await web.getByRole("textbox", { name: /Organization name/ }).fill("Harbor Family");
  await web.getByRole("radio", { name: /A family or a group/ }).check();
  await web.getByRole("button", { name: "Create organization" }).click();
  await web.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  const orgId = /organizations\/([0-9a-f-]{36})/.exec(web.url())![1];
  await web.close();

  // Nothing to say yet: Free, and an organization in good standing.
  await enforced.operator.setPlan("organizations", orgId, {
    plan: "families",
    standing: "until",
    until: fromNow(300 * DAY),
    renews: true,
  });
  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, user, enforced.url);
  await expect(popup.getByTestId("keykeeper-plan-banner")).toHaveCount(0);

  // A payment for their Premium is due, and the organization's plan has ended.
  const lapsed = fromNow(-2 * DAY);
  const graceEnds = new Date(new Date(lapsed).getTime() + 14 * DAY).toISOString();
  await enforced.operator.setPersonsPlan(user.email, { plan: "premium", standing: "until", until: lapsed, renews: true });
  await enforced.operator.setPlan("organizations", orgId, {
    plan: "families",
    freeUntil: fromNow(-DAY),
    freeWhy: "offer",
    standing: "none",
    renews: false,
  });
  // Opened again after a sync, as a popup is each time it's clicked.
  await expect(async () => {
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html#/tabs/settings`);
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html#/tabs/vault`);
    await expect(popup.getByTestId("keykeeper-plan-banner")).toHaveCount(2, { timeout: 3_000 });
  }).toPass({ timeout: 60_000 });

  const due = popup.locator('[data-testid="keykeeper-plan-banner"][data-whose="person"]');
  await expect(due).toHaveAttribute("data-kind", "paymentDue");
  await expect(due).toContainText(
    new RegExp(
      `A payment for your Premium is due\\. It was paid through ${inWords(lapsed)}(, and it ends on ${inWords(graceEnds)} if it isn't paid by then)?\\.`,
    ),
  );
  await expect(due.getByRole("link", { name: "See plan" })).toHaveAttribute("href", `${enforced.url}/#/settings/plan`);
  await expect(due.getByRole("link", { name: "See plan" })).toHaveAttribute("target", "_blank");

  const ended = popup.locator(`[data-testid="keykeeper-plan-banner"][data-whose="organization:${orgId}"]`);
  await expect(ended).toHaveAttribute("data-kind", "ended");
  await expect(ended).toContainText(
    "The plan for Harbor Family has ended, so nothing new can be added to it. Everything in it can still be opened, changed, exported, and deleted.",
  );
  await expect(ended.getByRole("link", { name: "See plan" })).toHaveAttribute(
    "href",
    `${enforced.url}/#/organizations/${orgId}/plan`,
  );

  // The link opens the web vault's Plan page in a tab of its own.
  const opened = context.waitForEvent("page");
  await due.getByRole("link", { name: "See plan" }).click();
  const tab = await opened;
  await tab.waitForLoadState();
  expect(tab.url()).toBe(`${enforced.url}/#/settings/plan`);
  await tab.close();

  // Put away for the day, even when the popup opens again.
  await due.getByRole("button", { name: "Close" }).click();
  await expect(due).toHaveCount(0);
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html#/tabs/settings`);
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html#/tabs/vault`);
  await expect(popup.getByRole("heading", { name: /Items/ }).first()).toBeVisible();
  await expect(due).toHaveCount(0);
  await expect(ended).toHaveCount(1);
});
