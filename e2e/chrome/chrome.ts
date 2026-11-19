// Google Chrome as a person has it, for tier 2 (DESIGN.md, "Testing"): the
// stable channel installed on this machine (Playwright's channel "chrome"),
// never Playwright's own Chromium, each launch with a new profile in a
// throwaway folder. The branded extension goes in as a person loads it by
// hand: Developer mode turned on at chrome://extensions, then "Load
// unpacked". Chrome's own builds ignore --load-extension (since Chrome 137),
// and Playwright can't answer the folder picker "Load unpacked" opens, so the
// test asks Chrome for the same thing over the DevTools protocol
// (Extensions.loadUnpacked, which Chrome allows with
// --enable-unsafe-extension-debugging).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

import { type BrowserContext, chromium, expect, test as base } from "@playwright/test";

import { brand, paths, port } from "../paths.mjs";
import { spkiHash } from "./relying-party.mjs";

export type Chrome = { context: BrowserContext; profile: string; extensionId: string };

// CI runs Chrome with a window, on a virtual display (xvfb-run), as a person
// has it. Locally it runs headless unless KK_CHROME_HEADED=1, so it doesn't
// take over the screen; see userAgent below.
const headless = process.env.KK_CHROME_HEADED !== "1";

let version: Promise<{ product: string; userAgent: string }> | undefined;

/**
 * This machine's Chrome: its version, and the user agent it sends with a
 * window. Headless Chrome says "HeadlessChrome/", which upstream's browser
 * detection misreads as Safari, so a headless run sends what the same Chrome
 * sends with a window.
 */
export function chromeVersion() {
  version ??= (async () => {
    const browser = await chromium.launch({ channel: "chrome", headless });
    try {
      const cdp = await browser.newBrowserCDPSession();
      const { product, userAgent } = await cdp.send("Browser.getVersion");
      return { product, userAgent: userAgent.replace("HeadlessChrome/", "Chrome/") };
    } finally {
      await browser.close();
    }
  })();
  return version;
}

/** The SHA-256 of the test server's key, so Chrome trusts its throwaway certificate and nothing else of the kind. */
export async function serverKeyHash(): Promise<string> {
  const der = await new Promise<Buffer>((resolve, reject) => {
    const socket = tls.connect({ host: "127.0.0.1", port: Number(port), rejectUnauthorized: false }, () => {
      resolve(socket.getPeerCertificate(true).raw);
      socket.end();
    });
    socket.on("error", reject);
  });
  return spkiHash(der);
}

/**
 * Chrome with a new profile and PassBundle's extension in it. `rules` are
 * its host resolver rules; `trustedKeys` the hashes of the only keys it
 * trusts beyond its own roots (--ignore-certificate-errors-spki-list, which
 * Chrome takes only with a profile folder of its own, as here).
 */
export async function launchChrome(rules: string, trustedKeys: string[]): Promise<Chrome> {
  const { userAgent } = await chromeVersion();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "passbundle-chrome-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chrome",
    headless,
    locale: "en-US",
    timezoneId: "UTC",
    // Playwright starts Chrome with extensions off; a person's has them on.
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      "--enable-unsafe-extension-debugging",
      `--ignore-certificate-errors-spki-list=${trustedKeys.join(",")}`,
      rules,
      ...(headless ? [`--user-agent=${userAgent}`] : []),
    ],
  });
  try {
    // Developer mode, as a person turns it on before loading an extension by hand.
    const extensions = await context.newPage();
    await extensions.goto("chrome://extensions");
    const developerMode = extensions.getByRole("switch", { name: "Developer mode" });
    await developerMode.click();
    await expect(developerMode).toBeChecked();
    await expect(extensions.getByRole("button", { name: "Load unpacked" })).toBeVisible();

    const cdp = await context.browser()!.newBrowserCDPSession();
    const { id } = await cdp.send("Extensions.loadUnpacked", { path: path.resolve(paths.extension) });
    // Loaded unpacked, the build has PassBundle's own ID (DESIGN.md,
    // "PassBundle's extension IDs"), and Chrome lists it under our name.
    expect(id).toBe(brand.extension.chromiumId);
    await expect(extensions.getByText(brand.nameFull, { exact: true })).toBeVisible();
    await expect
      .poll(() => context.serviceWorkers().some((w) => new URL(w.url()).host === id), { timeout: 15_000 })
      .toBe(true);
    await extensions.close();
    return { context, profile, extensionId: id };
  } catch (error) {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
    throw error;
  }
}

/** Closes Chrome and removes its profile. */
async function closeChrome(chrome: Chrome) {
  await chrome.context.close();
  fs.rmSync(chrome.profile, { recursive: true, force: true });
}

/**
 * `chrome(rules, trustedKeys)` launches Chrome (launchChrome) for the test,
 * which closes it when the test ends, even one that ran out of time, after a
 * screenshot of each of its windows if the test failed.
 */
export const test = base.extend<{ chrome: typeof launchChrome }>({
  chrome: async ({}, use, testInfo) => {
    const launched: Chrome[] = [];
    await use(async (rules, trustedKeys) => {
      const chrome = await launchChrome(rules, trustedKeys);
      launched.push(chrome);
      return chrome;
    });
    for (const [n, chrome] of launched.entries()) {
      if (testInfo.status !== testInfo.expectedStatus) {
        for (const [m, page] of chrome.context.pages().entries()) {
          await page
            .screenshot({ path: testInfo.outputPath(`chrome-${n + 1}-window-${m + 1}.png`), timeout: 5_000 })
            .catch(() => undefined);
        }
      }
      await closeChrome(chrome);
    }
  },
});

export { expect };
