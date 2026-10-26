// The web vault stays unlocked across a reload, within the vault timeout
// (DESIGN.md, "Staying unlocked across a reload"). At a real unlock a tab
// keeps the user key wrapped with a random key R in its own sessionStorage,
// and the server keeps R in memory; a reload asks for R back. Locking, a new
// browser, the timeout, "On browser refresh", Log out, and the server
// restarting all mean the next reload asks for the master password, as
// upstream's always did.
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";

import { restartServerPort } from "../paths.mjs";

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

/** Lock now, from the account menu behind the avatar. */
async function lockNow(page: Page) {
  await page.locator('button[aria-haspopup="menu"]:has(bit-avatar)').first().click();
  await page.getByRole("menuitem", { name: "Lock now" }).click();
}

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

  await lockNow(page);
  await expectLocked(page);
  expect(sent.forgotten).toEqual([sent.kept[0].tabId]);
  expect((await storage(page)).record).toBeNull();
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

/** A member of a Business organization: its preset has Vault lock, "when the computer locks". */
async function businessMember(browser: Browser, prefix: string, repeatIndex: number) {
  const ownerContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const owner = await ownerContext.newPage();
  const memberContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const joining = await memberContext.newPage();
  const member = webUserFor(`${prefix}-member`, repeatIndex);
  await signUp(joining, member);
  await memberContext.close();

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
  return { owner, org, member };
}

test("with the Business preset's Vault lock, a member signs in, reloads, and stays unlocked", async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const { member } = await businessMember(browser, "reload-business", testInfo.repeatEachIndex);

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const sent = watch(page);
  await logIn(page, member);
  await expect.poll(() => sent.kept.length).toBe(1);
  await page.reload();
  await expectUnlocked(page);

  // Settings says what "when the computer locks" means here, and offers
  // the waits up to 15 minutes.
  await sessionTimeout(page);
  await expect(
    page.getByText(
      "Your organization locks vaults when the computer locks. A web page can't tell when " +
        "that happens, so the web vault locks after 15 minutes without use, and 2 minutes " +
        "after the browser closes.",
    ),
  ).toBeVisible();
  await page.getByRole("combobox", { name: /^Timeout/ }).first().click();
  await expect(page.getByRole("option")).toHaveText([
    "1 minute",
    "5 minutes",
    "15 minutes",
    "Custom",
  ]);
  await context.close();
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
  const page = await context.newPage();
  await page.clock.install();
  const sent = watch(page);
  await logIn(page, member);
  await expect.poll(() => sent.kept.length).toBe(1);
  // Within the minute, a reload stays unlocked; the timeout is 1 minute.
  await page.reload();
  await expectUnlocked(page);
  await sessionTimeout(page);
  await expect(page.getByText(/locks after 1 minute without use/)).toBeVisible();
  await page.goto("/#/vault");
  await expectUnlocked(page);

  // Two minutes later, unused: locked, and a reload asks too.
  await page.clock.fastForward("02:00");
  await expectLocked(page);
  await page.reload();
  await expectLocked(page);
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
