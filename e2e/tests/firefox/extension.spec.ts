// The extension in Firefox (DESIGN.md, "The extension in Firefox"): the
// branded Firefox build (KK_FIREFOX_EXTENSION) as a temporary add-on in a real
// Firefox (KK_FIREFOX), driven through geckodriver (support/firefox.ts says
// why that way). A handful of the paths people take every day, not a copy of
// the Chrome specs: it's ours and named for us, it signs in to the test
// server, locks and unlocks, fills a saved login on a test page from the menu
// inside the field, and saves a new login from a sign-in.
//
// Accounts and their items are made through the API with real keys
// (support/vault-crypto.ts); the extension is what signs in to them, and what
// it saved is read back from the server and decrypted.
import type { APIRequestContext } from "@playwright/test";

import { brand, paths } from "../../paths.mjs";
import {
  expect,
  fixtureSite,
  heading,
  itemNamed,
  Key,
  popupUrl,
  test,
  type Firefox,
  WebDriverError,
} from "../support/firefox";
import { decrypt, realAccount, realPersonalLogin, type RealAccount } from "../support/vault-crypto";

// Tier 1 always has a Firefox; only a local run without one skips.
test.skip(!paths.firefox && !process.env.CI, "KK_FIREFOX isn't set: it names the Firefox to test in (e2e/README.md).");

// Each test starts a Firefox, makes an account, and signs in, before what it checks.
test.describe.configure({ timeout: 180_000 });

test("is PassBundle's extension, under our add-on ID and name, with no Bitwarden branding", async ({ firefox }) => {
  // The fixture checked the add-on ID Firefox installed it under.
  await firefox.openPopup();
  expect(await firefox.run("return browser.i18n.getMessage('extName')")).toBe(brand.nameFull);
  await expect.poll(() => firefox.title()).toBe(brand.name);
  // The welcome carousel, labeled with our name.
  await firefox.waitFor(`//section[@aria-label='Welcome to ${brand.name}']`);
  const text = (await firefox.run<string>("return document.body.innerText")).replaceAll(
    `Bitwarden Inc. and ${brand.name} contributors`,
    "",
  );
  expect(text).not.toContain("Bitwarden");
});

test("signs in to the test server, locks, and unlocks with the master password", async ({ firefox, request }) => {
  const account = await realAccount(request, "firefox-lock");
  await realPersonalLogin(request, account, {
    name: "Office router",
    username: "admin",
    password: "not-a-real-password-2",
    uri: "https://router.example.test",
  });
  await firefox.openPopup();
  await firefox.signIn(account);
  await firefox.waitFor(itemNamed("Office router"));

  await lockNow(firefox);
  // Locked, not signed out: the lock screen, with the account's own master password.
  await firefox.type("input[name='masterPassword']", account.password);
  await firefox.click("//button[@type='submit'][normalize-space(.)='Unlock']");
  await firefox.waitForVault();
  await firefox.waitFor(itemNamed("Office router"));
});

test("fills a saved login on a test page from the menu inside the field", async ({ firefox, request }) => {
  const site = fixtureSite("login.example.test");
  const account = await realAccount(request, "firefox-fill");
  await realPersonalLogin(request, account, {
    name: "Example login",
    username: "alice-example",
    password: "not-a-real-password-1",
    uri: site,
  });
  await firefox.openPopup();
  await firefox.signIn(account);
  await firefox.waitFor(itemNamed("Example login"));

  await firefox.newTab();
  await firefox.goto(`${site}/simple-login.html`);
  await chooseFirstInlineMenuItem(firefox, "#username", "Example login");

  await expect.poll(() => firefox.value("#username")).toBe("alice-example");
  await expect.poll(() => firefox.value("#password")).toBe("not-a-real-password-1");
});

test("offers to save a new login after a sign-in, and saves what was typed", async ({ firefox, request }) => {
  const site = fixtureSite("shop.example.test");
  const account = await realAccount(request, "firefox-save");
  await firefox.openPopup();
  await firefox.signIn(account);
  const popup = await firefox.handle();

  const page = await firefox.newTab();
  await firefox.goto(`${site}/simple-login.html`);
  // The extension scans a page shortly after it loads, and only then watches
  // for its sign-in: wait for that, as Chrome's tests do
  // (support/autofill.ts, waitForExtensionScan), from the popup.
  await firefox.switchTo(popup);
  await expect
    .poll(() => firefox.run(scanned, `${site}/simple-login.html`, "username"), { timeout: 15_000 })
    .toBe("scanned and watched");
  await firefox.switchTo(page);

  // A person typing, then Enter.
  await firefox.type("#username", "sam@shop.example.test");
  await firefox.type("#password", `a-new-password-for-the-shop-3${Key.Enter}`);
  await expect.poll(() => firefox.url()).toBe(`${site}/signed-in.html`);

  // The save prompt, the extension's page in a frame of the next page. Its
  // Save is pressed with Enter (Firefox.pressOn says why not a click).
  await firefox.intoFrame("notification/bar.html");
  await firefox.pressOn("//button[normalize-space(.)='Save']", Key.Enter);
  await firefox.top();

  await expect
    .poll(() => savedLogins(request, account), { timeout: 20_000 })
    .toEqual([{ username: "sam@shop.example.test", password: "a-new-password-for-the-shop-3", hosts: ["shop.example.test"] }]);
});

/**
 * Locks from the account switcher, where "Lock now" lives, and opens the
 * popup again on the lock screen. After it locks, the extension restarts
 * itself to clear what was in memory (upstream's BrowserProcessReloadService),
 * which Firefox does for a temporary add-on too; Chrome's tests turn that off
 * (biometric-unlock.spec.ts, lockNow), since Chrome can't restart an extension
 * loaded from the command line. So the background page is marked first, and
 * the popup that's opened next is checked to be the restarted extension's.
 *
 * Before the restart the popup closes itself, as the toolbar's popup does
 * (BrowserPopupUtils.closeCurrentPopupOrPopout: an address without
 * "uilocation" counts as the popup), and in Firefox an extension's page may
 * close its own tab. A window's last tab closing closes the window, and the
 * last window quits Firefox, so another tab stays open first.
 */
async function lockNow(firefox: Firefox) {
  const popup = await firefox.handle();
  await firefox.newTab();
  await firefox.switchTo(popup);
  await firefox.run("chrome.extension.getBackgroundPage().keykeeperTestBeforeLock = true");
  await firefox.goto(`${popupUrl}#/account-switcher`);
  // Clicked once: the tab can close before WebDriver hears back from the
  // click, which isn't a failure. Whether it locked is what's checked next.
  const lock = await firefox.waitFor("//button[normalize-space(.)='Lock now']");
  await firefox.cmd("POST", `/element/${lock}/click`).catch((error) => {
    console.log(`Lock now, while its tab closed: ${error}`);
  });
  // Each try opens a popup in a tab of its own.
  await expect(async () => {
    const handles = await firefox.handles();
    if (!handles.includes(await firefox.handle().catch(() => ""))) {
      await firefox.switchTo(handles[0]);
    }
    await firefox.newTab();
    try {
      await firefox.goto(popupUrl);
      const background = await firefox.run<string>(`
        const page = chrome.extension.getBackgroundPage();
        if (!page || !page.bitwardenMain) return "starting";
        return page.keykeeperTestBeforeLock ? "not restarted yet" : "restarted";
      `);
      expect(background, "the extension restarted after locking").toBe("restarted");
    } catch (error) {
      await firefox.closeTab().catch(() => {});
      throw error;
    }
  }).toPass({ timeout: 60_000, intervals: [1_000] });
  await firefox.waitFor("input[name='masterPassword']", 30_000);
  await firefox.waitFor(heading("locked"));
}

/**
 * Picks the first item in the menu inside a field with the keyboard, as
 * Chrome's tests do (support/autofill.ts, chooseFirstInlineMenuItem). The menu
 * is the extension's own pages in frames of the page: the page holds
 * overlay/menu.html, which holds the list (menu-list.html). ArrowDown in the
 * field moves the focus into the list, and Enter there fills. Keys go where
 * WebDriver's chosen frame is, so Enter is pressed from inside the list.
 *
 * First the list shows the item, as Chrome's tests wait for
 * (waitForInlineMenuItem): its text, as a person sees it. Not the
 * background's list of what it offers, as these tests once asked: Firefox
 * gives an extension's page its full APIs only when every frame around it is
 * that extension's too, so overlay/menu.html inside a web page gets what a
 * content script gets, with no getBackgroundPage, and the list, sandboxed,
 * gets none.
 */
async function chooseFirstInlineMenuItem(firefox: Firefox, field: string, itemName: string) {
  await expect(async () => {
    await firefox.top();
    await firefox.click(field);
    await firefox.intoFrame("menu-list.html", 5_000);
    if (!diagDone) {
      diagDone = true;
      await diagFrames(firefox, "menu open, before the list check");
      await firefox.intoFrame("menu-list.html", 5_000);
      // What these tests did before: the list's parent frame, and its APIs.
      await firefox.parentFrame();
      console.log("DIAG parentFrame() from menu-list.html lands in: " + (await firefox.run<string>(probe)));
      await firefox.intoFrame("menu-list.html", 5_000);
      const host = await firefox.cmd<Record<string, string>>("POST", "/element", { using: "css selector", value: "autofill-inline-menu-list" });
      const root = await firefox
        .cmd("GET", `/element/${Object.values(host)[0]}/shadow`)
        .then((r) => JSON.stringify(r), (e) => `failed: ${e}`);
      console.log("DIAG Get Element Shadow Root on the list's host: " + root);
      console.log("DIAG the list's page sees host.shadowRoot: " + (await firefox.run<string>("return String(document.querySelector('autofill-inline-menu-list').shadowRoot)")));
      console.log("DIAG shadowText: " + JSON.stringify(await firefox.shadowText("autofill-inline-menu-list").catch((e) => `failed: ${e}`)));
      await firefox.intoFrame("menu-list.html", 5_000);
    }
    await expect
      .poll(() => firefox.shadowText("autofill-inline-menu-list"), { timeout: 5_000 })
      .toContain(itemName);
    await firefox.top();
    await firefox.press(Key.ArrowDown);
    await firefox.intoFrame("menu-list.html", 5_000);
    await expect.poll(() => firefox.run<boolean>("return document.hasFocus()"), { timeout: 3_000 }).toBe(true);
  }).toPass({ timeout: 45_000 });
  await diagFrames(firefox, "after ArrowDown, focus in the list");
  await firefox.intoFrame("menu-list.html", 5_000);
  await firefox.press(Key.Enter);
  await firefox.top();
  await expect.poll(() => firefox.value(field), { timeout: 5_000 }).not.toBe("").catch(() => {});
  console.log("DIAG after Enter, " + field + " is " + JSON.stringify(await firefox.value(field)));
}

let diagDone = false;

/** Diagnostic only (branch firefox-tests-diag): what each frame is, and which extension APIs it has. */
const probe = `
  const info = { href: location.href, locationOrigin: location.origin, selfOrigin: String(self.origin) };
  const t = (f) => { try { return f(); } catch (e) { return "throws " + e.message; } };
  info.chrome = t(() => typeof chrome);
  info.browser = t(() => typeof browser);
  info.getBackgroundPage = t(() => typeof chrome.extension.getBackgroundPage);
  info.extensionKeys = t(() => Object.getOwnPropertyNames(chrome.extension).sort().join(","));
  info.runtimeKeys = t(() => Object.getOwnPropertyNames(browser.runtime).sort().join(","));
  info.tabs = t(() => typeof chrome.tabs);
  info.hasFocus = document.hasFocus();
  info.active = document.activeElement ? document.activeElement.tagName : null;
  return JSON.stringify(info);
`;

async function diagFrames(firefox: Firefox, label: string) {
  const lines: string[] = [];
  const walk = async (path: number[]) => {
    const info = await firefox.run<string>(probe).catch((e) => `run failed: ${e}`);
    lines.push(`[${path.join(".") || "top"}] ${info}`);
    if (path.length > 3) return;
    for (let i = 0; ; i++) {
      try {
        await firefox.cmd("POST", "/frame", { id: i });
      } catch (error) {
        if (!(error instanceof WebDriverError && error.error === "no such frame")) lines.push(`  frame ${i}: ${error}`);
        break;
      }
      await walk([...path, i]);
      await firefox.parentFrame();
    }
  };
  await firefox.top();
  await walk([]);
  // The same tab from the browser's side: each frame's process and principal.
  try {
    await firefox.cmd("POST", "/moz/context", { context: "chrome" });
    lines.push(
      await firefox.run<string>(`
        const out = [];
        const t = (f) => { try { return f(); } catch (e) { return "throws " + e.message; } };
        out.push("fissionAutostart " + t(() => Services.appinfo.fissionAutostart) + ", remote extensions " + t(() => WebExtensionPolicy.useRemoteWebExtensions));
        const walk = (bc, depth) => {
          const wg = bc.currentWindowGlobal;
          out.push("  ".repeat(depth + 1) + t(() => wg.documentURI.spec) +
            " | process " + t(() => wg.domProcess.remoteType) +
            " | addon " + t(() => (wg.documentPrincipal.addonPolicy ? wg.documentPrincipal.addonPolicy.id : "none")) +
            " | principal " + t(() => wg.documentPrincipal.origin) +
            " | sandboxFlags " + bc.sandboxFlags);
          for (const child of bc.children) walk(child, depth + 1);
        };
        walk(gBrowser.selectedBrowser.browsingContext, 0);
        return out.join("\\n");
      `),
    );
  } catch (error) {
    lines.push(`chrome context: ${error}`);
  } finally {
    await firefox.cmd("POST", "/moz/context", { context: "content" }).catch(() => {});
  }
  await firefox.top();
  console.log(`DIAG frames (${label}):\n${lines.join("\n")}`);
}

/** Whether the extension has scanned the tab at this address, the field included, and watches it for a sign-in. */
const scanned = `
  const [url, fieldId] = arguments;
  return (async () => {
    const main = chrome.extension.getBackgroundPage()?.bitwardenMain;
    if (!main) return "no background yet";
    const tab = (await browser.tabs.query({})).find((t) => t.url === url);
    if (!tab) return "no tab at " + url;
    const details = main.overlayBackground.pageDetailsForTab[tab.id]?.get(0)?.details;
    const found = Boolean(details?.fields?.some((f) => f.htmlID === fieldId));
    const watched = main.overlayNotificationsBackground.websiteOriginsWithFields.has(tab.id);
    return found && watched ? "scanned and watched" : "scanned " + found + ", watched " + watched;
  })();
`;

/** The account's logins as the server has them, decrypted with its key (and each item's own key, where it has one). */
async function savedLogins(request: APIRequestContext, account: RealAccount) {
  const got = await request.get("/api/ciphers", { headers: { Authorization: `Bearer ${account.token}` } });
  expect(got.status(), await got.text()).toBe(200);
  const ciphers: any[] = (await got.json()).data;
  return ciphers
    .filter((c) => c.type === 1 && !c.deletedDate)
    .map((c) => {
      const key = c.key ? decrypt(account.userKey, c.key) : account.userKey;
      const text = (value: string | null) => (value == null ? null : decrypt(key, value).toString("utf8"));
      return {
        username: text(c.login.username),
        password: text(c.login.password),
        hosts: (c.login.uris ?? []).map((u: { uri: string }) => new URL(text(u.uri)!).hostname),
      };
    });
}
