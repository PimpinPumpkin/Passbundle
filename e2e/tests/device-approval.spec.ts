// Approving a sign-in from another device (DESIGN.md, "Approving a sign-in
// from another device"): the web vault asks to sign in with a device, and our
// apps' core, signed in elsewhere with the master password, sees the request
// with the same fingerprint phrase the web vault shows, and approves it
// through the app's own calls (the interop tool tier 1 builds from the linked
// passbundle-apps branch, KK_CORE_INTEROP). Real keys on both sides: the core
// wraps the user key to the web vault's public key, and the web vault opens
// it and signs in. Also: a denial, a request that's expired, and another
// account, which never sees it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { ageSignInRequests } from "./api/support";
import { core, coreTool, serverCertificate } from "./support/core";
import { signUp, webUserFor, type WebUser } from "./support/web";

test.skip(!coreTool && !process.env.CI, "KK_CORE_INTEROP isn't set; tier 1 builds the core's interop tool");

/**
 * Signs out of the web vault (a reload locks it, and the lock screen signs
 * out), then asks to sign in with a device. This browser signed in before,
 * so the account knows it, which "Log in with device" needs. Returns the
 * fingerprint phrase the web vault shows.
 */
async function askToSignInWithDevice(page: Page, user: WebUser): Promise<string> {
  await page.goto("/#/vault");
  await page.reload();
  await page.getByRole("button", { name: "Log out" }).click();
  await page.getByRole("dialog", { name: "Log out" }).getByRole("button", { name: "Log out" }).click();
  await page.waitForURL(/#\/login/);
  await page.getByLabel(/Email address/).fill(user.email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Log in with device" }).click();
  await page.waitForURL(/#\/login-with-device/);
  const phrase = page.locator("code");
  await expect(phrase).toHaveText(/^[a-z]+(-[a-z]+){4}$/);
  return (await phrase.textContent())!.trim();
}

function coreDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pb-approval-"));
}

test("the web vault signs in with a device, approved from our app", async ({ page }, testInfo) => {
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
