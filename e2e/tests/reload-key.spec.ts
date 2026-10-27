// The web vault stays unlocked across a reload, within the vault timeout
// (DESIGN.md, "Staying unlocked across a reload"). At a real unlock a tab
// keeps the user key wrapped with a random key R in its own sessionStorage,
// and the server keeps R in memory and sets the tab's reload cookie
// (HttpOnly); a reload asks for R back, with the cookie. Locking, a new
// browser, the timeout, "On browser refresh" (a member's own, under a policy
// too), Log out, the server restarting, a missing cookie, and a copy of the
// tab's storage without its cookie all mean the next reload asks for the
// master password, as upstream's always did.
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from "@playwright/test";

import { fixturePort, hostResolverRules, port, restartServerPort } from "../paths.mjs";

import { confirmMember, signUp, webUserFor, type WebUser } from "./support/web";

const e2eDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECORD = /_keykeeperReloadKey_reloadKey$/;

const masterPassword = (page: Page) => page.getByRole("textbox", { name: /^Master password/ });

async function expectUnlocked(page: Page) {
  await expect(page).toHaveTitle(/^Items/, { timeout: 30_000 });
  await expect(masterPassword(page)).toHaveCount(0);
}

async function expectLocked(page: Page) {
  await expect(masterPassword(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Unlock", exact: true })).toBeVisible();
}

/** Unlocks from the lock screen, which then shows the page the tab was on. */
async function unlock(page: Page, user: WebUser) {
  await masterPassword(page).fill(user.password);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(masterPassword(page)).toHaveCount(0, { timeout: 30_000 });
}

async function logIn(page: Page, user: WebUser) {
  await page.goto("/#/login");
  await page.getByLabel(/Email address/).fill(user.email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("textbox", { name: /Master password/ }).fill(user.password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expectUnlocked(page);
}

/** What the tab sends the server: each R it keeps, and each reload's request for one. */
function watch(page: Page) {
  const kept: Array<{ tabId: string; key: string; timeoutMinutes: number }> = [];
  const released: string[] = [];
  const forgotten: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") {
      return;
    }
    const url = request.url();
    if (url.endsWith("/api/keykeeper/reload-key")) {
      kept.push(request.postDataJSON());
    } else if (url.endsWith("/api/keykeeper/reload-key/release")) {
      released.push(request.postDataJSON().tabId);
    } else if (url.endsWith("/api/keykeeper/reload-key/forget")) {
      forgotten.push(request.postDataJSON().tabId);
    }
  });
  return { kept, released, forgotten };
}

/** The tab's own storage, as text, and its reload key record. */
async function storage(page: Page) {
  return await page.evaluate((recordPattern) => {
    const all = (s: Storage) => Object.keys(s).map((k) => `${k}=${s.getItem(k)}`);
    const pattern = new RegExp(recordPattern);
    const key = Object.keys(sessionStorage).find((k) => pattern.test(k));
    return {
      text: [...all(sessionStorage), ...all(localStorage)].join("\n"),
      record: key == null ? null : JSON.parse(sessionStorage.getItem(key)!),
    };
  }, RECORD.source);
}

/** Settings, Security, Session timeout: the timeout and its action. */
async function sessionTimeout(page: Page) {
  await page.goto("/#/settings/security/session-timeout");
  const timeout = page.getByRole("combobox", { name: /^Timeout/ }).first();
  await expect(timeout).toBeVisible();
  return timeout;
}

async function choose(page: Page, combobox: string, option: string) {
  await page.getByRole("combobox", { name: new RegExp(`^${combobox}`) }).first().click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

/** The tab's reload cookie, as the browser keeps it. */
async function reloadCookie(context: BrowserContext, tabId: string) {
  return (await context.cookies()).find((c) => c.name === `__Secure-pb-reload-${tabId}`);
}

/** Lock now, from the account menu behind the avatar. */
async function lockNow(page: Page) {
  await page.locator('button[aria-haspopup="menu"]:has(bit-avatar)').first().click();
  await page.getByRole("menuitem", { name: "Lock now" }).click();
}

/** What a copy of the tab's storage would hold: its access token and reload key's tab id. */
async function tabSecrets(page: Page) {
  return await page.evaluate(() => {
    const keys = Object.keys(sessionStorage);
    const read = (suffix: string) =>
      JSON.parse(sessionStorage.getItem(keys.find((k) => k.endsWith(suffix))!)!);
    return {
      token: read("_token_accessToken") as string,
      tabId: read("_keykeeperReloadKey_reloadKey").tabId as string,
      session: Object.fromEntries(keys.map((k) => [k, sessionStorage.getItem(k)!])),
    };
  });
}

/** Asks the server for R as the tab would, with this browser's cookies. */
const releaseAs = (context: BrowserContext, token: string, tabId: string) =>
  context.request
    .post("/api/keykeeper/reload-key/release", {
      headers: { Authorization: `Bearer ${token}` },
      data: { tabId },
    })
    .then((r) => r.status());

test("a reload within the timeout stays unlocked, with no prompt", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const sent = watch(page);
  const user = webUserFor("reload-stays", testInfo.repeatEachIndex);
  await signUp(page, user);
  await expect.poll(() => sent.kept.length).toBe(1);
  const [{ tabId, key, timeoutMinutes }] = sent.kept;
  expect(timeoutMinutes).toBe(15);

  // The tab keeps its id and the wrapped user key, never R.
  await expect.poll(async () => (await storage(page)).record?.tabId).toBe(tabId);
  const kept = await storage(page);
  expect(kept.record.wrappedUserKey).toMatch(/^2\./);
  expect(kept.text).not.toContain(key);

  for (let i = 0; i < 2; i++) {
    await page.reload();
    await expectUnlocked(page);
  }
  // Each reload asked for the same R; none made a new one.
  expect(sent.released).toEqual([tabId, tabId]);
  expect(sent.kept).toHaveLength(1);
  expect((await storage(page)).text).not.toContain(key);
});

test("locking, then reloading, asks for the master password", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const sent = watch(page);
  const user = webUserFor("reload-lock", testInfo.repeatEachIndex);
  await signUp(page, user);
  await expect.poll(() => sent.kept.length).toBe(1);

  expect(await reloadCookie(page.context(), sent.kept[0].tabId)).toBeDefined();
  await lockNow(page);
  await expectLocked(page);
  expect(sent.forgotten).toEqual([sent.kept[0].tabId]);
  expect((await storage(page)).record).toBeNull();
  // The server expired the tab's cookie as it forgot R.
  await expect.poll(() => reloadCookie(page.context(), sent.kept[0].tabId)).toBeUndefined();
  await page.reload();
  await expectLocked(page);

  // Unlocking is a real unlock: a new R, and reloads stay unlocked again.
  await unlock(page, user);
  await expectUnlocked(page);
  await expect.poll(() => sent.kept.length).toBe(2);
  expect(sent.kept[1].tabId).not.toBe(sent.kept[0].tabId);
  await page.reload();
  await expectUnlocked(page);
});

test("the tab's reload cookie is HttpOnly, Secure, and Strict, and without it a reload asks", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const sent = watch(page);
  const user = webUserFor("reload-cookie", testInfo.repeatEachIndex);
  await signUp(page, user);
  await expect.poll(() => sent.kept.length).toBe(1);
  const { tabId } = sent.kept[0];

  // A session cookie, only for the reload endpoints, that page scripts can't
  // read and the tab's storage doesn't hold.
  const cookie = (await reloadCookie(page.context(), tabId))!;
  expect(cookie).toMatchObject({
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/api/keykeeper/reload-key",
    expires: -1,
  });
  expect(cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await page.evaluate(() => document.cookie)).not.toContain("pb-reload");
  expect((await storage(page)).text).not.toContain(cookie.value);

  await page.reload();
  await expectUnlocked(page);

  // The cookie gone (cleared, or another browser): the next reload asks.
  await page.context().clearCookies({ name: cookie.name });
  await page.reload();
  await expectLocked(page);
});

test("another browser with a copy of the tab's storage, but not its cookie, gets nothing", async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const sent = watch(page);
  const user = webUserFor("reload-copied-storage", testInfo.repeatEachIndex);
  await signUp(page, user);
  await expect.poll(() => sent.kept.length).toBe(1);
  await expect.poll(async () => (await storage(page)).record?.tabId).toBe(sent.kept[0].tabId);

  // Everything the tab keeps in sessionStorage and localStorage, copied.
  const copy = await page.evaluate(() => ({
    session: Object.fromEntries(Object.keys(sessionStorage).map((k) => [k, sessionStorage.getItem(k)!])),
    local: Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)!])),
  }));
  expect(Object.keys(copy.session).some((k) => /_token_accessToken$/.test(k))).toBe(true);

  const other = await browser.newContext();
  // The copy is put back at every load, as a thief would.
  await other.addInitScript((stored) => {
    for (const [k, v] of Object.entries(stored.session)) {
      sessionStorage.setItem(k, v);
    }
    for (const [k, v] of Object.entries(stored.local)) {
      localStorage.setItem(k, v);
    }
  }, copy);
  const thief = await other.newPage();
  const released: number[] = [];
  thief.on("response", (response) => {
    if (response.url().endsWith("/api/keykeeper/reload-key/release")) {
      released.push(response.status());
    }
  });
  await thief.goto("/#/vault");
  // Signed in (the copy has the tokens), but locked; and a reload, the one
  // load that asks for R, is refused by the server.
  await expectLocked(thief);
  await thief.reload();
  await expectLocked(thief);
  expect(released).toEqual([404]);
  await other.close();
});

test("a closed tab, reopened, finds the vault locked, and the server lets R go", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const sent = watch(page);
  await signUp(page, webUserFor("reload-reopen", testInfo.repeatEachIndex));
  await expect.poll(() => sent.kept.length).toBe(1);
  const { token, tabId, session } = await tabSecrets(page);

  // A reopened tab gets its sessionStorage back from the browser.
  await context.addInitScript((stored) => {
    if (sessionStorage.length === 0) {
      for (const [k, v] of Object.entries(stored)) {
        sessionStorage.setItem(k, v);
      }
    }
  }, session);

  // Closed as a person closes a tab: its page says it's leaving.
  await page.close({ runBeforeUnload: true });

  // Reopened at once: not a reload, so locked, and it doesn't even ask for R.
  const reopened = await context.newPage();
  const asked: string[] = [];
  reopened.on("request", (r) => r.url().endsWith("/reload-key/release") && asked.push(r.url()));
  await reopened.goto("/#/vault");
  await expectLocked(reopened);
  expect(asked).toEqual([]);
  expect(await reopened.evaluate(() => (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming).type)).toBe(
    "navigate",
  );

  // And the server let R go: 15 seconds after the page left, with no reload
  // asking, even this browser's cookie and the tab's token get nothing.
  await new Promise((resolve) => setTimeout(resolve, 16_000));
  expect(await releaseAs(context, token, tabId)).toBe(404);
});

test("Back to the vault asks for the master password", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const sent = watch(page);
  await signUp(page, webUserFor("reload-back", testInfo.repeatEachIndex));
  await expect.poll(() => sent.kept.length).toBe(1);

  await page.goto("about:blank");
  await page.goBack();
  await expectLocked(page);
  expect(await page.evaluate(() => (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming).type)).toBe(
    "back_forward",
  );
  expect(sent.released).toEqual([]);
});

test("Back asks with the back-forward cache on, too", async ({}, testInfo) => {
  test.setTimeout(120_000);
  // Playwright turns the cache off; a browser of this test's own keeps it.
  const browser = await chromium.launch({
    args: [hostResolverRules],
    ignoreDefaultArgs: ["--disable-back-forward-cache"],
  });
  try {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      baseURL: `https://127.0.0.1:${port}`,
    });
    const page = await context.newPage();
    const sent = watch(page);
    await signUp(page, webUserFor("reload-bfcache", testInfo.repeatEachIndex));
    await expect.poll(() => sent.kept.length).toBe(1);
    await page.goto(`https://127.0.0.1:${fixturePort}/alive`);
    await page.goBack();
    // Whether the page comes back from the cache (it locks as it shows) or
    // loads again (not a reload), the vault is locked.
    await expectLocked(page);
  } finally {
    await browser.close();
  }
});

test("Log out from the account menu forgets the tab's R first", async ({ context, page }, testInfo) => {
  test.setTimeout(120_000);
  const sent = watch(page);
  await signUp(page, webUserFor("reload-log-out-menu", testInfo.repeatEachIndex));
  await expect.poll(() => sent.kept.length).toBe(1);
  const { token, tabId } = await tabSecrets(page);

  await page.locator('button[aria-haspopup="menu"]:has(bit-avatar)').first().click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page.getByLabel(/Email address/)).toBeVisible({ timeout: 30_000 });
  expect(sent.forgotten).toEqual([tabId]);
  await expect.poll(() => reloadCookie(context, tabId)).toBeUndefined();
  // The access token still works for a while; the server has nothing for it.
  expect(await releaseAs(context, token, tabId)).toBe(404);
});

test("with Stay unlocked when I reload off, every reload asks", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const sent = watch(page);
  const user = webUserFor("reload-setting-off", testInfo.repeatEachIndex);
  await signUp(page, user);
  await expect.poll(() => sent.kept.length).toBe(1);

  await sessionTimeout(page);
  const setting = page.getByRole("checkbox", { name: "Stay unlocked when I reload" });
  await expect(setting).toBeChecked();
  await setting.uncheck();
  await expect.poll(() => sent.forgotten).toEqual([sent.kept[0].tabId]);
  // The timeout itself is as it was.
  await expect(page.getByText("15 minutes", { exact: true }).first()).toBeVisible();

  await page.goto("/#/vault");
  await page.reload();
  await expectLocked(page);
  await unlock(page, user);
  await expectUnlocked(page);
  await page.reload();
  await expectLocked(page);
  expect(sent.kept).toHaveLength(1);
});

test("turning Stay unlocked when I reload off in one tab forgets the other tabs' at once", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  const sent = watch(page);
  const user = webUserFor("reload-setting-tabs", testInfo.repeatEachIndex);
  await signUp(page, user);
  await expect.poll(() => sent.kept.length).toBe(1);
  // The same person in a second tab of the same browser.
  const other = await context.newPage();
  const sentOther = watch(other);
  await logIn(other, user);
  await expect.poll(() => sentOther.kept.length).toBe(1);

  await sessionTimeout(page);
  await page.getByRole("checkbox", { name: "Stay unlocked when I reload" }).uncheck();
  await expect.poll(() => sent.forgotten).toEqual([sent.kept[0].tabId]);
  // The other tab forgets its own, without a reload or a check-in.
  await expect.poll(() => sentOther.forgotten, { timeout: 10_000 }).toEqual([sentOther.kept[0].tabId]);
  await expect.poll(async () => (await storage(other)).record).toBeNull();
  await other.reload();
  await expectLocked(other);
});

test("a new browser asks for the master password", async ({ browser, page }, testInfo) => {
  test.setTimeout(120_000);
  const user = webUserFor("reload-new-browser", testInfo.repeatEachIndex);
  const sent = watch(page);
  await signUp(page, user);
  await expect.poll(() => sent.kept.length).toBe(1);

  const other = await browser.newContext({ ignoreHTTPSErrors: true });
  const fresh = await other.newPage();
  await fresh.goto("/#/vault");
  await expect(fresh.getByLabel(/Email address/)).toBeVisible({ timeout: 30_000 });
  await other.close();

  // The first browser is still unlocked after a reload.
  await page.reload();
  await expectUnlocked(page);
});

test("On browser refresh keeps asking at each reload", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const sent = watch(page);
  const user = webUserFor("reload-on-refresh", testInfo.repeatEachIndex);
  await signUp(page, user);
  await expect.poll(() => sent.kept.length).toBe(1);

  await sessionTimeout(page);
  await choose(page, "Timeout", "On browser refresh");
  // The reload key goes at once, here and on the server.
  await expect.poll(() => sent.forgotten).toEqual([sent.kept[0].tabId]);
  await expect.poll(async () => (await storage(page)).record).toBeNull();

  await page.goto("/#/vault");
  await page.reload();
  await expectLocked(page);
  await unlock(page, user);
  await expectUnlocked(page);
  await page.reload();
  await expectLocked(page);
  // No unlock kept a new one.
  expect(sent.kept).toHaveLength(1);
});

test("with the Log out action, a reload signs out, as before", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const sent = watch(page);
  const user = webUserFor("reload-log-out", testInfo.repeatEachIndex);
  await signUp(page, user);
  await expect.poll(() => sent.kept.length).toBe(1);

  await sessionTimeout(page);
  await choose(page, "Timeout action", "Log out");
  await page.getByRole("dialog").getByRole("button", { name: "Yes" }).click();
  await expect.poll(() => sent.forgotten).toEqual([sent.kept[0].tabId]);

  await page.reload();
  await expect(page.getByLabel(/Email address/)).toBeVisible({ timeout: 30_000 });
});

/** Browsers a test opened besides its own page's, closed after it, pass or fail. */
const opened: BrowserContext[] = [];
test.afterEach(async () => {
  for (const context of opened.splice(0)) {
    await context.close().catch(() => {});
  }
});

/** What Settings says under the Business preset's "when the computer locks". */
const SYSTEM_LOCK_MESSAGE =
  "Your organization locks vaults when the computer locks. A web page can't tell when " +
  'that happens, so here the timeout is at most 15 minutes. To lock at every reload too, turn off "Stay ' +
  'unlocked when I reload".';

/**
 * A member of a Business organization: its preset has Vault lock, "when the
 * computer locks". With `before`, the member's browser stays open, after
 * `before` runs in it as they join.
 */
async function businessMember(
  browser: Browser,
  prefix: string,
  repeatIndex: number,
  before?: (page: Page) => Promise<void>,
) {
  const ownerContext = await browser.newContext({ ignoreHTTPSErrors: true });
  opened.push(ownerContext);
  const owner = await ownerContext.newPage();
  const memberContext = await browser.newContext({ ignoreHTTPSErrors: true });
  opened.push(memberContext);
  const joining = await memberContext.newPage();
  const member = webUserFor(`${prefix}-member`, repeatIndex);
  await signUp(joining, member);
  if (before == null) {
    await memberContext.close();
  } else {
    await before(joining);
  }

  await signUp(owner, webUserFor(`${prefix}-owner`, repeatIndex));
  await owner.goto("/#/create-organization");
  await owner.getByRole("textbox", { name: /Organization name/ }).fill("Lakeside Clinic");
  await owner.getByRole("radio", { name: /A business/ }).check();
  await owner.getByRole("button", { name: "Create organization" }).click();
  await owner.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  const org = owner.url().replace(/\/members.*$/, "");
  await owner.getByRole("button", { name: "Invite member" }).click();
  const invite = owner.getByRole("dialog", { name: /Invite member/ });
  await invite.getByRole("textbox", { name: /Email/ }).fill(member.email);
  await invite.getByRole("button", { name: "Save" }).click();
  await expect(invite).toBeHidden();
  await confirmMember(owner, member.email);
  return { owner, org, member, joining };
}

test("with the Business preset's Vault lock, a member signs in, reloads, and stays unlocked", async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const { member } = await businessMember(browser, "reload-business", testInfo.repeatEachIndex);

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  opened.push(context);
  const page = await context.newPage();
  const sent = watch(page);
  await logIn(page, member);
  await expect.poll(() => sent.kept.length).toBe(1);
  await page.reload();
  await expectUnlocked(page);

  // Settings says what "when the computer locks" means here, and offers
  // only the waits up to 15 minutes: "On browser refresh" would turn the
  // idle lock off.
  await sessionTimeout(page);
  await expect(page.getByText(SYSTEM_LOCK_MESSAGE)).toBeVisible();
  await page.getByRole("combobox", { name: /^Timeout/ }).first().click();
  await expect(page.getByRole("option")).toHaveText(["1 minute", "5 minutes", "15 minutes", "Custom"]);
  await page.keyboard.press("Escape");
  // Locking at every reload too is the setting's job.
  await page.getByRole("checkbox", { name: "Stay unlocked when I reload" }).uncheck();
  await expect.poll(async () => (await storage(page)).record).toBeNull();
  await page.goto("/#/vault");
  await page.reload();
  await expectLocked(page);
  await context.close();
});

test("under the Business preset, a member's own On browser refresh still asks at each reload", async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  // Chosen before joining, and kept: the policy shows 15 minutes instead.
  const { member, joining: page } = await businessMember(
    browser,
    "reload-business-refresh",
    testInfo.repeatEachIndex,
    async (joining) => {
      await sessionTimeout(joining);
      await choose(joining, "Timeout", "On browser refresh");
      await expect.poll(async () => (await storage(joining)).record).toBeNull();
    },
  );
  const sent = watch(page);

  // The unlock after the next reload brings the organization's policy.
  await page.goto("/#/vault");
  await page.reload();
  await expectLocked(page);
  await unlock(page, member);
  await sessionTimeout(page);
  await expect(page.getByText(SYSTEM_LOCK_MESSAGE)).toBeVisible({ timeout: 30_000 });
  const setting = page.getByRole("checkbox", { name: "Stay unlocked when I reload" });
  await expect(setting).not.toBeChecked();
  await expect(setting).toBeDisabled();
  await expect(page.getByText("Off while your own timeout is On browser refresh, which locks at every reload.")).toBeVisible();

  await page.goto("/#/vault");
  await page.reload();
  await expectLocked(page);
  await unlock(page, member);
  await expectUnlocked(page);
  await page.reload();
  await expectLocked(page);
  expect(sent.kept).toHaveLength(0);
});

test("with the web vault's wait at 1 minute, moving the clock past it locks", async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const { owner, org, member } = await businessMember(browser, "reload-clock", testInfo.repeatEachIndex);

  // The owner sets the web vault's wait on the policy page.
  await owner.goto(`${org}/settings/policies`);
  await owner.getByRole("button", { name: /^Vault lock .* On$/ }).click();
  const dialog = owner.getByRole("dialog");
  await expect(dialog.getByRole("radio", { name: /^When the computer locks/ })).toBeChecked();
  await dialog.getByRole("combobox", { name: "In the web vault, at most" }).click();
  await owner.getByRole("option", { name: "1 minute", exact: true }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(owner.getByText("Edited policy Vault lock.", { exact: true }).last()).toBeVisible();

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  opened.push(context);
  const page = await context.newPage();
  // Playwright's clock also stands in for performance, without the
  // navigation's entry, so no load counts as a reload under it: the tests
  // above cover reloads.
  await page.clock.install();
  const sent = watch(page);
  await logIn(page, member);
  await expect.poll(() => sent.kept.length).toBe(1);
  // The timeout is 1 minute.
  await sessionTimeout(page);
  await expect(page.getByText(/the timeout is at most 1 minute\./)).toBeVisible();
  await page.goto("/#/vault");
  await expectUnlocked(page);

  // Two minutes later, unused: locked, and a reload asks too.
  await page.clock.fastForward("02:00");
  await expectLocked(page);
  await page.reload();
  await expectLocked(page);
  await context.close();
});

test("a Vault lock policy can turn staying unlocked across a reload off for its members", async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const { owner, org, member } = await businessMember(browser, "reload-policy-off", testInfo.repeatEachIndex);

  await owner.goto(`${org}/settings/policies`);
  await owner.getByRole("button", { name: /^Vault lock .* On$/ }).click();
  const dialog = owner.getByRole("dialog");
  const webReload = dialog.getByRole("checkbox", { name: /^Web vaults can stay unlocked/ });
  await expect(webReload).toBeChecked();
  await webReload.uncheck();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(owner.getByText("Edited policy Vault lock.", { exact: true }).last()).toBeVisible();

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  opened.push(context);
  const page = await context.newPage();
  const sent = watch(page);
  await logIn(page, member);
  // Settings shows it off, and why.
  await sessionTimeout(page);
  const setting = page.getByRole("checkbox", { name: "Stay unlocked when I reload" });
  await expect(setting).toBeDisabled();
  await expect(setting).not.toBeChecked();
  await expect(
    page.getByText("Your organization turned this off: every reload asks for your master password."),
  ).toBeVisible();
  await page.goto("/#/vault");
  await page.reload();
  await expectLocked(page);
  // Signing in may have asked before the policy synced; the server refused.
  expect(sent.released).toEqual([]);
  await context.close();
});

/** A server of this test's own, keeping its data across a restart. */
async function startServer(request: APIRequestContext, dataDir: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: e2eDir,
    env: { ...process.env, KK_PORT: restartServerPort, KK_DATA_DIR: dataDir },
    stdio: "ignore",
  });
  const alive = `https://127.0.0.1:${restartServerPort}/alive`;
  await expect
    .poll(async () => (await request.get(alive).catch(() => null))?.status() ?? 0, {
      timeout: 60_000,
    })
    .toBe(200);
  return child;
}

async function stopServer(child: ChildProcess) {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
}

test.describe("on a server that restarts", () => {
  test.use({ baseURL: `https://127.0.0.1:${restartServerPort}` });

  test("the next reload asks for the master password", async ({ page, request }, testInfo) => {
    test.setTimeout(240_000);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-e2e-restart-"));
    let server = await startServer(request, dataDir);
    try {
      const sent = watch(page);
      const user = webUserFor("reload-restart", testInfo.repeatEachIndex);
      await signUp(page, user);
      await expect.poll(() => sent.kept.length).toBe(1);
      await page.reload();
      await expectUnlocked(page);

      await stopServer(server);
      server = await startServer(request, dataDir);
      await page.reload();
      await expectLocked(page);
      // The account and its vault are all there: only R was forgotten.
      await unlock(page, user);
      await expectUnlocked(page);
    } finally {
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
