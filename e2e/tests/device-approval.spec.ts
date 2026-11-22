// Approving a sign-in from another device (DESIGN.md, "Approving a sign-in
// from another device"): the web vault asks to sign in with a device, and our
// apps' core, signed in elsewhere with the master password, sees the request
// with the same fingerprint phrase the web vault shows, and approves it
// through the app's own calls (the interop tool tier 1 builds from the linked
// passbundle-apps branch, KK_CORE_INTEROP). Real keys on both sides: the core
// wraps the user key to the web vault's public key, and the web vault opens
// it and signs in. Also: a denial, a request that's expired, and another
// account, which never sees it.
//
// And the web vault approving another browser's request from Settings,
// Security, Devices: only after the master password, checked in the
// approving browser and never sent, with a wrong one sending nothing; Cancel
// sends nothing either, and Deny asks for nothing (DESIGN.md, "The web vault
// and the extension"). These need no core.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { type Browser, expect, type Request, test, type Page } from "@playwright/test";

import { ageSignInRequests } from "./api/support";
import { core, coreTool, serverCertificate } from "./support/core";
import { fingerprintPhrase } from "./support/fingerprint";
import { signUp, webUserFor, type WebUser } from "./support/web";

const needsCore = () =>
  test.skip(!coreTool && !process.env.CI, "KK_CORE_INTEROP isn't set; tier 1 builds the core's interop tool");

/**
 * Signs out of the web vault (Sign out, from the account menu behind the
 * avatar), then asks to sign in with a device. This browser signed in
 * before, so the account knows it, which "Sign in with a device" needs. Returns
 * the fingerprint phrase the web vault shows.
 */
async function askToSignInWithDevice(page: Page, user: WebUser): Promise<string> {
  await page.goto("/#/vault");
  await page.locator('button[aria-haspopup="menu"]:has(bit-avatar)').first().click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByLabel(/Email address/)).toBeVisible({ timeout: 30_000 });
  await page.getByLabel(/Email address/).fill(user.email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Sign in with a device" }).click();
  await page.waitForURL(/#\/login-with-device/);
  const phrase = page.locator("code");
  await expect(phrase).toHaveText(fingerprintPhrase);
  return (await phrase.textContent())!.trim();
}

function coreDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pb-approval-"));
}

test("the web vault signs in with a device, approved from our app", async ({ page }, testInfo) => {
  needsCore();
  test.setTimeout(180_000);
  const user = webUserFor("device-approval", testInfo.repeatEachIndex);
  await signUp(page, user);
  const phrase = await askToSignInWithDevice(page, user);

  const dir = coreDir();
  const cert = await serverCertificate(dir);
  // The core lists it with the same phrase, the device, and its address.
  const listed = core(dir, cert, user, { action: "signInRequests" }).signIn!;
  expect(listed.requests).toEqual([
    // Headless Chromium is a browser the web vault doesn't name.
    expect.objectContaining({ fingerprint: phrase, device: "Web vault in a browser", ip: "127.0.0.1" }),
  ]);
  expect(listed.requests[0].secondsLeft).toBeGreaterThan(14 * 60);
  expect(listed.requests[0].secondsLeft).toBeLessThanOrEqual(15 * 60);

  // The app asks the person to confirm it's them first; the core refuses
  // an approval without it, and the request stays waiting.
  const unconfirmed = core(dir, cert, user, { action: "approveSignIn", fingerprint: phrase, confirm: false }).signIn!;
  expect(unconfirmed.refused).toBe("Confirm it's you first.");
  expect(unconfirmed.answered).toBeUndefined();

  const approved = core(dir, cert, user, { action: "approveSignIn", fingerprint: phrase }).signIn!;
  expect(approved.answered).toBe(listed.requests[0].id);

  // The web vault opens the user key with its own private key, signs in
  // with the request's access code, and opens the vault.
  await page.waitForURL(/#\/vault/, { timeout: 30_000 });
  await expect(page).toHaveTitle(/^Items/);
  // Answered, it's no longer waiting.
  expect(core(dir, cert, user, { action: "signInRequests" }).signIn!.requests).toEqual([]);
});

test("a denied sign-in goes nowhere", async ({ page }, testInfo) => {
  needsCore();
  test.setTimeout(180_000);
  const user = webUserFor("device-denial", testInfo.repeatEachIndex);
  await signUp(page, user);
  const phrase = await askToSignInWithDevice(page, user);

  const dir = coreDir();
  const cert = await serverCertificate(dir);
  const denied = core(dir, cert, user, { action: "denySignIn", fingerprint: phrase }).signIn!;
  expect(denied.requests.map((r) => r.fingerprint)).toEqual([phrase]);
  expect(denied.answered).toBe(denied.requests[0].id);
  expect(core(dir, cert, user, { action: "signInRequests" }).signIn!.requests).toEqual([]);
  // The web vault is still waiting, signed out: a denial sends it nothing.
  await expect(page.locator("code")).toHaveText(phrase);
  await expect(page).toHaveURL(/#\/login-with-device/);
});

test("an expired sign-in request disappears and can't be approved", async ({ page }, testInfo) => {
  needsCore();
  test.setTimeout(180_000);
  const user = webUserFor("device-expired", testInfo.repeatEachIndex);
  await signUp(page, user);
  const phrase = await askToSignInWithDevice(page, user);
  const aged = await ageSignInRequests(user.email, 16);
  test.skip(aged === null, "the test server runs on PostgreSQL");
  expect(aged).toBe(1);

  const dir = coreDir();
  const cert = await serverCertificate(dir);
  const tried = core(dir, cert, user, { action: "approveSignIn", fingerprint: phrase }).signIn!;
  expect(tried.requests).toEqual([]);
  expect(tried.answered).toBeUndefined();
  expect(tried.refused).toMatch(/expired or was answered/);
  await expect(page).toHaveURL(/#\/login-with-device/);
});

test("another account never sees the request", async ({ page, browser }, testInfo) => {
  needsCore();
  test.setTimeout(240_000);
  const user = webUserFor("device-owner", testInfo.repeatEachIndex);
  const other = webUserFor("device-other", testInfo.repeatEachIndex);
  const otherContext = await browser.newContext();
  await signUp(await otherContext.newPage(), other);
  await otherContext.close();
  await signUp(page, user);
  const phrase = await askToSignInWithDevice(page, user);

  const dir = coreDir();
  const cert = await serverCertificate(dir);
  const tried = core(dir, cert, other, { action: "approveSignIn", fingerprint: phrase }).signIn!;
  expect(tried.requests).toEqual([]);
  expect(tried.answered).toBeUndefined();
  // Its owner still sees it.
  const own = core(dir, cert, user, { action: "signInRequests" }).signIn!;
  expect(own.requests.map((r) => r.fingerprint)).toEqual([phrase]);
  await expect(page).toHaveURL(/#\/login-with-device/);
});

/** Signs in to the web vault with the master password, in a browser of its own. */
async function approvingBrowser(browser: Browser, user: WebUser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/#/login");
  await page.getByLabel(/Email address/).fill(user.email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("textbox", { name: /Master password/ }).fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/#\/vault/, { timeout: 60_000 });
  // Every call it makes from here on, to see what an answer sends.
  const calls: Request[] = [];
  page.on("request", (r) => calls.push(r));
  const answers = () =>
    calls.filter((r) => r.method() === "PUT" && /\/api\/auth-requests\/[^/]+$/.test(new URL(r.url()).pathname));
  return { context, page, calls, answers };
}

/** Opens the request from Settings, Security, Devices: upstream's approval dialog, with its phrase. */
async function openRequest(page: Page, phrase: string) {
  await page.goto("/#/settings/security/device-management");
  const pending = page.getByRole("row").filter({ hasText: "Request pending" });
  await expect(pending).toHaveCount(1, { timeout: 30_000 });
  await pending.getByRole("link").click();
  const dialog = page.getByRole("dialog").filter({ hasText: phrase });
  await expect(dialog.getByText(phrase, { exact: true })).toBeVisible();
  return dialog;
}

test("the web vault approves another browser's sign-in only after the master password, and a wrong one sends nothing", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const user = webUserFor("device-web-confirm", testInfo.repeatEachIndex);
  await signUp(page, user);
  const approver = await approvingBrowser(browser, user);
  const phrase = await askToSignInWithDevice(page, user);

  const dialog = await openRequest(approver.page, phrase);
  // This server has no location database: the address alone, as upstream
  // shows it, with no location and no credit.
  await expect(dialog).toContainText("(127.0.0.1)");
  await expect(dialog.getByTestId("keykeeper-login-approval-location")).toHaveCount(0);
  await expect(dialog).not.toContainText("Unknown location");

  // Confirm access asks for the master password first.
  await dialog.getByRole("button", { name: "Confirm access" }).click();
  const confirm = approver.page.getByTestId("keykeeper-confirm-approval");
  await expect(confirm).toContainText("Confirm it's you");
  await expect(confirm).toContainText("Enter your master password to approve this sign-in.");

  // A wrong one: said so, the field emptied, and nothing sent. The asking
  // browser is still waiting.
  const wrong = "not-the-master-password-1";
  await confirm.getByRole("textbox", { name: /Master password/ }).fill(wrong);
  await confirm.getByRole("button", { name: "Approve" }).click();
  await expect(confirm.getByRole("alert")).toHaveText("That isn't your master password, so nothing was sent.");
  await expect(confirm.getByRole("textbox", { name: /Master password/ })).toHaveValue("");
  expect(approver.answers()).toEqual([]);
  await expect(page).toHaveURL(/#\/login-with-device/);
  await expect(page.locator("code")).toHaveText(phrase);

  // The right one: the key goes, and the asking browser signs in.
  await confirm.getByRole("textbox", { name: /Master password/ }).fill(user.password);
  await confirm.getByRole("button", { name: "Approve" }).click();
  await expect(confirm).toBeHidden();
  await expect.poll(() => approver.answers().length, { timeout: 30_000 }).toBe(1);
  const sent = approver.answers()[0].postDataJSON();
  expect(sent.requestApproved).toBe(true);
  expect(sent.key).toMatch(/^4\./);
  await page.waitForURL(/#\/vault/, { timeout: 30_000 });
  await expect(page).toHaveTitle(/^Items/);

  // The master password was checked in the approving browser: no call it
  // made carried either password.
  for (const call of approver.calls) {
    const body = call.postData() ?? "";
    expect(body).not.toContain(wrong);
    expect(body).not.toContain(user.password);
    expect(body).not.toContain(encodeURIComponent(user.password));
    expect(call.url()).not.toContain(wrong);
  }
  await approver.context.close();
});

test("Cancel at the master password sends nothing, and Deny asks for nothing", async ({ page, browser }, testInfo) => {
  test.setTimeout(240_000);
  const user = webUserFor("device-web-cancel", testInfo.repeatEachIndex);
  await signUp(page, user);
  const approver = await approvingBrowser(browser, user);
  const phrase = await askToSignInWithDevice(page, user);

  const dialog = await openRequest(approver.page, phrase);
  await dialog.getByRole("button", { name: "Confirm access" }).click();
  const confirm = approver.page.getByTestId("keykeeper-confirm-approval");
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toBeHidden();
  // The request is still open here, and nothing went.
  await expect(dialog.getByText(phrase, { exact: true })).toBeVisible();
  expect(approver.answers()).toEqual([]);

  // Deny: no master password, and a denial with no key.
  await dialog.getByRole("button", { name: "Deny access" }).click();
  await expect.poll(() => approver.answers().length, { timeout: 30_000 }).toBe(1);
  await expect(confirm).toHaveCount(0);
  const sent = approver.answers()[0].postDataJSON();
  expect(sent.requestApproved).toBe(false);
  // Signed out still, on the asking browser.
  await expect(page).toHaveURL(/#\/login-with-device/);
  await approver.context.close();
});
