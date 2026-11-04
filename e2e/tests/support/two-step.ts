// Two-step login for tests whose people run an organization or an MSP
// (DESIGN.md, "Two-step login for admins"). A Business organization's owners
// and admins and every MSP's staff need an authenticator app, a security key
// or passkey, or Duo; without one, their session ends at its next refresh and
// their next sign-in only sets one up. These helpers give an account made in
// the web vault an authenticator app, as such a person would, and answer the
// web vault's and the extension's two-step login with its codes.
import { pbkdf2Sync, randomUUID } from "node:crypto";

import { type APIRequestContext, expect, type Page } from "@playwright/test";

import { totp } from "../api/support";

/** Each account's authenticator key, and the last 30-second step it used. */
const authenticators = new Map<string, { key: string; lastStep: number }>();

const stepOf = (ms: number) => Math.floor(ms / 30_000);

/**
 * The master password's hash as the apps send it: the master key (PBKDF2-SHA256
 * of the password, salted with the email, 600,000 rounds, the web vault's
 * default), then one more round salted with the password.
 */
export async function masterPasswordHash(
  request: APIRequestContext,
  user: { email: string; password: string },
): Promise<string> {
  const email = user.email.trim().toLowerCase();
  const prelogin = await request.post("/identity/accounts/prelogin", { data: { email } });
  const kdf = await prelogin.json();
  expect(kdf.kdf, "the web vault's default KDF, PBKDF2").toBe(0);
  const masterKey = pbkdf2Sync(user.password, email, kdf.kdfIterations, 32, "sha256");
  return pbkdf2Sync(masterKey, user.password, 1, 32, "sha256").toString("base64");
}

/**
 * Turns on an authenticator app for an account made in the web vault, over
 * the API with a session of the test's own (or, if the account already needs
 * it, the setup session its sign-in gets). Its web vault sessions go on as
 * before.
 */
export async function giveAuthenticator(
  request: APIRequestContext,
  user: { email: string; password: string },
): Promise<string> {
  const hash = await masterPasswordHash(request, user);
  const signIn = await request.post("/identity/connect/token", {
    form: {
      grant_type: "password",
      username: user.email,
      password: hash,
      scope: "api offline_access",
      client_id: "web",
      deviceType: "10",
      deviceIdentifier: randomUUID(),
      deviceName: "e2e-authenticator",
    },
  });
  const body = await signIn.json();
  const token = (body.access_token ?? body.KeykeeperTwoStepSetup) as string | undefined;
  expect(token, JSON.stringify(body)).toBeTruthy();
  const headers = { Authorization: `Bearer ${token}` };
  const started = await request.post("/api/two-factor/get-authenticator", {
    headers,
    data: { masterPasswordHash: hash },
  });
  expect(started.status(), await started.text()).toBe(200);
  const key = (await started.json()).key as string;
  const now = Date.now();
  const on = await request.post("/api/two-factor/authenticator", {
    headers,
    data: { key, token: totp(key, now), masterPasswordHash: hash },
  });
  expect(on.status(), await on.text()).toBe(200);
  authenticators.set(user.email.toLowerCase(), { key, lastStep: stepOf(now) });
  return key;
}

/**
 * A code the server hasn't seen from this account's authenticator: it takes
 * the current 30-second step's or the next one's, each once, so after two
 * sign-ins in one step this waits for the next.
 */
export async function nextCode(email: string): Promise<string> {
  const entry = authenticators.get(email.toLowerCase());
  expect(entry, `an authenticator for ${email}`).toBeTruthy();
  await expect
    .poll(() => stepOf(Date.now()) + 1 > entry!.lastStep, { timeout: 35_000, intervals: [1_000] })
    .toBe(true);
  const step = Math.max(stepOf(Date.now()), entry!.lastStep + 1);
  entry!.lastStep = step;
  return totp(entry!.key, step * 30_000 + 1_000);
}

/** Whether the tests gave this account an authenticator app. */
export function hasAuthenticator(email: string): boolean {
  return authenticators.has(email.toLowerCase());
}

/** Answers the web vault's or the extension's two-step login page with the next code. */
export async function answerTwoStep(page: Page, email: string) {
  await page.waitForURL(/#\/2fa/);
  await page.getByRole("textbox", { name: /Verification code/ }).fill(await nextCode(email));
  await page.getByRole("button", { name: "Continue" }).click();
}
