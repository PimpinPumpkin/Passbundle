import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  chromium,
  expect,
  test as base,
  type BrowserContext,
  type Page,
} from "@playwright/test";

import { brand, hostResolverRules, paths, port } from "../../paths.mjs";

const chromeUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

export const serverUrl = `https://127.0.0.1:${port}`;

// Loads the built extension into a real Chromium profile. Extensions need the
// full Chromium build, not the headless shell, so this uses channel "chromium".
export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  context: async ({}, use) => {
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
    await use(context);
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  },
  extensionId: async ({ context }, use) => {
    // Poll for the worker instead of waiting for its event: it can register
    // between a check and a subscription, and the event is then missed.
    await expect.poll(() => context.serviceWorkers().length, { timeout: 15_000 }).toBeGreaterThan(0);
    await use(new URL(context.serviceWorkers()[0].url()).host);
  },
});

export { expect };

export type User = { email: string; name: string; password: string };

export const userFor = (prefix: string, repeatIndex: number): User => ({
  email: `${prefix}-${repeatIndex}@example.test`,
  name: prefix,
  password: "correct horse battery staple 42",
});

export async function createAccount(context: BrowserContext, user: User) {
  const web = await context.newPage();
  await web.goto(`${serverUrl}/#/signup`);
  await web.getByLabel(/Email address/).fill(user.email);
  await web.getByLabel("Name").fill(user.name);
  await web.getByRole("button", { name: "Continue" }).click();
  await web.getByRole("textbox", { name: /^Master password/ }).first().fill(user.password);
  await web.getByRole("textbox", { name: /Confirm master password/ }).fill(user.password);
  await web.getByRole("button", { name: "Create account" }).click();
  await web.waitForURL(/#\/vault/);
  return web;
}

export async function openPopup(context: BrowserContext, extensionId: string): Promise<Page> {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
  return popup;
}

export async function logInPopup(popup: Page, user: User) {
  // The carousel renders its buttons before Angular wires them up, and an early
  // click is dropped. Click until the app actually navigates.
  await expect(async () => {
    await popup.getByRole("button", { name: "Log in" }).click();
    await expect(popup).toHaveURL(/#\/login/, { timeout: 1000 });
  }).toPass();
  await popup.getByRole("button", { name: new RegExp(brand.domain.replace(".", "\\.")) }).click();
  await popup.getByRole("menuitem", { name: /self-hosted/i }).click();
  await popup.getByRole("textbox", { name: /Server URL/ }).fill(serverUrl);
  await popup.getByRole("button", { name: "Save" }).click();
  await popup.getByLabel(/Email address/).fill(user.email);
  await popup.getByRole("button", { name: "Continue" }).click();
  await popup.getByRole("textbox", { name: /Master password/ }).fill(user.password);
  await popup.getByRole("button", { name: "Log in", exact: true }).click();
  // Key derivation and the first sync take a while on slow CI runners.
  await expect(popup.getByRole("heading", { name: /Vault/ }).first()).toBeVisible({
    timeout: 30_000,
  });
}
