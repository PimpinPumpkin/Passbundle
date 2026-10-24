import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  chromium,
  expect,
  test as base,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";

import { hostResolverRules, paths, port } from "../../paths.mjs";
import { skipImport } from "./web";

const chromeUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

export const serverUrl = `https://127.0.0.1:${port}`;

/**
 * A real Chromium profile with the built extension loaded, in a new folder:
 * close it, then remove the folder. Extensions need the full Chromium build,
 * not the headless shell, so this uses channel "chromium".
 */
export async function launchWithExtension(): Promise<{ context: BrowserContext; profile: string }> {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-ext-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    locale: "en-US",
    timezoneId: "UTC",
    args: [
      `--disable-extensions-except=${paths.extension}`,
      `--load-extension=${paths.extension}`,
      // The test server uses a throwaway self-signed certificate.
      "--ignore-certificate-errors",
      // Headless Chromium says "HeadlessChrome/", which upstream's browser
      // detection misreads as Safari. Real users never send it.
      `--user-agent=${chromeUserAgent}`,
      hostResolverRules,
    ],
  });
  return { context, profile };
}

/** The extension's ID in a profile, once its worker is up. */
export async function extensionIdOf(context: BrowserContext): Promise<string> {
  // Poll for the worker instead of waiting for its event: it can register
  // between a check and a subscription, and the event is then missed.
  await expect
    .poll(() => context.serviceWorkers().length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  return new URL(context.serviceWorkers()[0].url()).host;
}

// Loads the built extension into a real Chromium profile for each test.
export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
}>({
  context: async ({}, use) => {
    const { context, profile } = await launchWithExtension();
    await use(context);
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  },
  extensionId: async ({ context }, use) => {
    await use(await extensionIdOf(context));
  },
});

export { expect };

export type User = { email: string; name: string; password: string };

export const userFor = (prefix: string, repeatIndex: number): User => ({
  email: `${prefix}-${repeatIndex}@example.test`,
  name: prefix,
  password: "correct horse battery staple 42",
});

export async function createAccount(
  context: BrowserContext,
  user: User,
  server = serverUrl,
) {
  const web = await context.newPage();
  await web.goto(`${server}/#/signup`);
  await web.getByLabel(/Email address/).fill(user.email);
  await web.getByLabel("Name").fill(user.name);
  await web.getByRole("button", { name: "Continue" }).click();
  await web
    .getByRole("textbox", { name: /^Master password/ })
    .first()
    .fill(user.password);
  await web
    .getByRole("textbox", { name: /Confirm master password/ })
    .fill(user.password);
  await web.getByRole("button", { name: "Create account" }).click();
  await skipImport(web);
  return web;
}

export async function openPopup(
  context: BrowserContext,
  extensionId: string,
): Promise<Page> {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
  return popup;
}

export async function logInPopup(popup: Page, user: User, server = serverUrl) {
  // The carousel renders its buttons before Angular wires them up, and an early
  // click is dropped. Click until the app actually navigates.
  await expect(async () => {
    await popup.getByRole("button", { name: "Log in" }).click();
    await expect(popup).toHaveURL(/#\/login/, { timeout: 1000 });
  }).toPass();
  // "Where's your vault?" (DESIGN.md, "The look"): our own server, typed in place.
  await popup.getByRole("button", { name: "My own server" }).click();
  await popup.getByRole("textbox", { name: "Server address" }).fill(server);
  await popup.getByLabel(/Email address/).fill(user.email);
  await popup.getByRole("button", { name: "Continue" }).click();
  await popup
    .getByRole("textbox", { name: /Master password/ })
    .fill(user.password);
  await popup.getByRole("button", { name: "Log in", exact: true }).click();
  // Key derivation and the first sync take a while on slow CI runners.
  await expect(
    popup.getByRole("heading", { name: /Items/ }).first(),
  ).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * Presses a button that closes its own window, and waits for it to close.
 * The window can close before the click returns, which Playwright reports as
 * the page having closed; here that's the answer arriving, not a failure.
 */
export async function answerAndClose(page: Page, button: Locator) {
  await Promise.all([
    page.waitForEvent("close"),
    button.click({ noWaitAfter: true }).catch((error: unknown) => {
      if (!page.isClosed() && !String(error).includes("has been closed")) {
        throw error;
      }
    }),
  ]);
}
