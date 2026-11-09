// A member's Options menu on the Members page acts on that member, even when
// the list reloads under it. The list reloads while the page is open (the
// background work lets someone in, or a sync changes the organization), and
// upstream's rows had no stable identity: the reload handed the row whose
// menu was open to someone else, and the open menu offered and ran that
// person's actions. Here a sync reloads the list while a menu is open: the
// server tells the owner's web vault to sync when the owner's settings change.
import { randomUUID } from "node:crypto";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { Api } from "./api/support";
import { signUp, webUserFor } from "./support/web";

/** A toast message. Toasts here have no ARIA role, so find them by text. */
const toast = (page: Page, text: string) => page.getByText(text, { exact: true });

/** The web vault's own access token, from its latest API request. */
function tokenOf(page: Page) {
  let token = "";
  page.on("request", (request) => {
    const header = request.headers()["authorization"];
    if (header?.startsWith("Bearer ") && request.url().includes("/api/")) {
      token = header.slice("Bearer ".length);
    }
  });
  return () => ({ token });
}

test("a member's Options menu keeps acting on that member when the list reloads", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const owner = webUserFor("members-menu", testInfo.repeatEachIndex);
  const auth = tokenOf(page);
  await signUp(page, owner);

  await page.goto("/#/create-organization");
  await page.getByRole("textbox", { name: /Organization name/ }).fill("Juniper Books");
  await page.getByRole("radio", { name: /A family or a group/ }).check();
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(toast(page, "Created Juniper Books")).toBeVisible();
  await page.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  const orgId = /organizations\/([0-9a-f-]{36})/.exec(page.url())![1];

  // People invited by email, with no account yet, so they stay invited. The
  // list sorts by email: ada, then the owner (members-menu-...), yan, zoe.
  const api = new Api(request);
  const tag = randomUUID().slice(0, 8);
  const email = (name: string) => `${name}-${tag}@example.test`;
  const invite = async (name: string) => {
    const invited = await api.call(auth(), "POST", `/api/organizations/${orgId}/users/invite`, {
      emails: [email(name)],
      type: 2,
      collections: [],
      groups: [],
      accessSecretsManager: false,
      permissions: {},
    });
    expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  };
  const remove = async (name: string) => {
    const listed = await api.call(auth(), "GET", `/api/organizations/${orgId}/users`);
    const member = listed.body.data.find((m: { email: string }) => m.email === email(name));
    expect(member, `membership for ${email(name)}`).toBeTruthy();
    const removed = await api.call(auth(), "DELETE", `/api/organizations/${orgId}/users/${member.id}`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
  };
  /**
   * Saving the owner's settings makes the server tell their web vault to
   * sync, which reloads the list. Saves again until the reloaded list shows
   * `shown`, in case a notice arrives before the vault is listening.
   */
  const syncUntil = async (shown: Locator) => {
    await expect(async () => {
      const saved = await api.call(auth(), "POST", "/api/settings/domains", {
        equivalentDomains: [],
        excludedGlobalEquivalentDomains: [],
      });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      await expect(shown).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 30_000 });
  };
  const row = (name: string) => page.getByRole("row").filter({ hasText: email(name) });
  const menu = page.getByRole("menu");

  await invite("zoe");
  await page.goto("/#/vault");
  await page.goto(`/#/organizations/${orgId}/members`);
  await expect(row("zoe")).toBeVisible();

  // Zoe's menu is open when Ada is invited and the list reloads: Ada's row
  // comes first, and the open menu still acts on Zoe.
  await row("zoe").getByRole("button", { name: "Options" }).click();
  await expect(menu.getByRole("menuitem", { name: "Resend invitation" })).toBeVisible();
  await invite("ada");
  await syncUntil(row("ada"));
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Remove" }).click();
  const confirmRemove = page.getByRole("dialog", { name: `Remove ${email("zoe")} access` });
  await expect(confirmRemove).toBeVisible();
  await confirmRemove.getByRole("button", { name: "No" }).click();
  await expect(confirmRemove).toBeHidden();
  await expect(row("zoe")).toBeVisible();

  // Ada's menu is open when she's removed and Yan is invited: her row leaves
  // the list, and her menu closes with it rather than turning into Yan's.
  await row("ada").getByRole("button", { name: "Options" }).click();
  await expect(menu.getByRole("menuitem", { name: "Resend invitation" })).toBeVisible();
  await remove("ada");
  await invite("yan");
  await syncUntil(row("yan"));
  await expect(row("ada")).toHaveCount(0);
  await expect(menu).toHaveCount(0);
});
