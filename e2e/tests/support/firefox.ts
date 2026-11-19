// A real Firefox with the branded Firefox build of the extension, for the
// tests in tests/firefox (DESIGN.md, "The extension in Firefox").
//
// Why geckodriver and WebDriver classic: Playwright's Firefox can't load
// extensions. WebDriver BiDi can install one (webExtension.install), but
// Firefox's BiDi skips every page and frame that belongs to an extension
// (remote/shared/BrowsingContextUtils.sys.mjs, isBrowsingContextCompatible:
// "extension contexts until we support debugging webextensions, see Bug
// 1755014"), so it can't drive the popup or the extension's frames in a page.
// geckodriver installs the build as a temporary add-on, which needs no
// signing (POST /session/{id}/moz/addon/install with "temporary": true, as
// about:debugging's Load Temporary Add-on does), and with
// --allow-system-access (Firefox 138 and later) its commands may also run in
// the extension's own pages and frames. This file talks to geckodriver over
// plain HTTP: the few WebDriver commands the tests use, and nothing else.
//
// Each test gets its own geckodriver and Firefox with a new profile, which
// geckodriver makes and removes. No live network: every host name resolves
// to 127.0.0.1 (network.dns.forceResolve), so the test pages are the local
// fixture server at its port, and the test server is 127.0.0.1 already.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test as base, type TestInfo } from "@playwright/test";

import { brand, fixturePort, geckodriverPort, paths, port } from "../../paths.mjs";

export { expect };

export const serverUrl = `https://127.0.0.1:${port}`;
/** The autofill fixtures' host for a made-up site, at the fixture server's port. */
export const fixtureSite = (host: string) => `https://${host}:${fixturePort}`;

/**
 * The extension's moz-extension:// address. Firefox gives each install a
 * random one, unless the profile already maps the add-on's ID to one
 * (extensions.webextensions.uuids), which the profile here does.
 */
export const extensionUuid = "5b9e2c47-0d3a-4f6e-9a1c-7e8d2f4b6a10";
export const extensionUrl = `moz-extension://${extensionUuid}`;
export const popupUrl = `${extensionUrl}/popup/index.html`;

/** WebDriver's names for keys. */
export const Key = {
  ArrowDown: "",
  Enter: "",
  Escape: "",
} as const;

const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
const driverUrl = `http://127.0.0.1:${geckodriverPort}`;

/** Firefox's preferences for every test profile, on top of the ones geckodriver sets for testing. */
function preferences(): Record<string, string | number | boolean> {
  return {
    // The extension's address, fixed (above).
    "extensions.webextensions.uuids": JSON.stringify({ [brand.extension.firefoxId]: extensionUuid }),
    // No live network: every name but localhost resolves to 127.0.0.1, and no
    // DNS over HTTPS.
    "network.dns.forceResolve": "127.0.0.1",
    "network.trr.mode": 5,
    // Pages' and the extension's console in geckodriver's log, which a failed
    // test keeps.
    "devtools.console.stdout.content": true,
    "devtools.console.stdout.chrome": true,
    "intl.locale.requested": "en-US",
    "intl.accept_languages": "en-US",
  };
}

export class WebDriverError extends Error {
  constructor(
    readonly error: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, route: string, body?: unknown): Promise<T> {
  const response = await fetch(driverUrl + route, {
    method,
    headers: method === "POST" ? { "content-type": "application/json" } : {},
    // WebDriver wants a JSON body on every POST, even an empty one.
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    // Longer than any command's own limit (a page load's is 60 seconds), so a
    // geckodriver that stops answering fails the test instead of holding it.
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let json: { value: any };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`geckodriver, ${method} ${route}: ${response.status} ${text}`);
  }
  if (!response.ok) {
    const { error, message } = json.value ?? {};
    throw new WebDriverError(error, `geckodriver, ${method} ${route}: ${error}: ${message}`);
  }
  return json.value as T;
}

/** A locator: XPath when it starts with / or (, otherwise CSS. */
const by = (selector: string) =>
  selector.startsWith("/") || selector.startsWith("(")
    ? { using: "xpath", value: selector }
    : { using: "css selector", value: selector };

export class Firefox {
  private constructor(
    private readonly driver: ChildProcess,
    private readonly dir: string,
    readonly logPath: string,
    private readonly sessionId: string,
    /** Firefox's version, as it tells WebDriver. */
    readonly version: string,
  ) {}

  /** geckodriver and Firefox with a new profile. Stop it with stop(). */
  static async start(): Promise<Firefox> {
    if (!paths.firefox) {
      throw new Error("KK_FIREFOX isn't set: it names the Firefox to test in (e2e/README.md).");
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-firefox-"));
    const profiles = path.join(dir, "profiles");
    fs.mkdirSync(profiles);
    const logPath = path.join(dir, "geckodriver.log");
    const log = fs.openSync(logPath, "a");
    const driver = spawn(
      paths.geckodriver,
      ["--port", geckodriverPort, "--allow-system-access", "--profile-root", profiles, "--log", "info"],
      { stdio: ["ignore", log, log], env: { ...process.env, TZ: "UTC" } },
    );
    fs.closeSync(log);
    let failed: Error | undefined;
    driver.once("error", (error) => (failed = error));
    try {
      await expect
        .poll(
          async () => {
            if (failed) throw new Error(`geckodriver (${paths.geckodriver}) didn't start: ${failed.message}`);
            if (driver.exitCode != null) throw new Error(`geckodriver stopped: ${fs.readFileSync(logPath, "utf8")}`);
            return call<{ ready: boolean }>("GET", "/status").then(
              (status) => status.ready,
              () => false,
            );
          },
          { timeout: 15_000, message: "geckodriver answers" },
        )
        .toBe(true);
      const session = await call<{ sessionId: string; capabilities: { browserVersion: string } }>(
        "POST",
        "/session",
        {
          capabilities: {
            alwaysMatch: {
              browserName: "firefox",
              // The test server and the fixture server have throwaway
              // certificates. Firefox takes any certificate for the whole
              // session then, the extension's own requests included.
              acceptInsecureCerts: true,
              "moz:firefoxOptions": {
                binary: paths.firefox,
                args: ["-headless"],
                prefs: preferences(),
                env: { TZ: "UTC" },
              },
            },
          },
        },
      );
      const firefox = new Firefox(driver, dir, logPath, session.sessionId, session.capabilities.browserVersion);
      await firefox.cmd("POST", "/timeouts", { implicit: 0, pageLoad: 60_000, script: 30_000 });
      return firefox;
    } catch (error) {
      driver.kill();
      // Keep what geckodriver said: it's the reason.
      const said = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").slice(-4000) : "";
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error(`${error instanceof Error ? error.message : error}\ngeckodriver's log:\n${said}`);
    }
  }

  /** Ends the session, which quits Firefox, then geckodriver; a failed test keeps screenshots and the log. */
  async stop(testInfo?: TestInfo) {
    if (testInfo && testInfo.status !== testInfo.expectedStatus) {
      await this.keepForFailure(testInfo).catch(() => {});
    }
    await call("DELETE", `/session/${this.sessionId}`).catch(() => {});
    if (this.driver.exitCode == null && this.driver.signalCode == null) {
      const exited = new Promise((resolve) => this.driver.once("exit", resolve));
      this.driver.kill();
      await exited;
    }
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  private async keepForFailure(testInfo: TestInfo) {
    // Each tab as it is. Firefox may be gone by now (that can be the failure),
    // and the log is kept all the same.
    try {
      const handles = await this.handles();
      for (const [i, handle] of handles.entries()) {
        await this.switchTo(handle);
        await this.top();
        const url = await this.url();
        const png = Buffer.from(await this.cmd<string>("GET", "/screenshot"), "base64");
        await testInfo.attach(`firefox-tab-${i + 1}.png`, { body: png, contentType: "image/png" });
        await testInfo.attach(`firefox-tab-${i + 1}-url.txt`, { body: url, contentType: "text/plain" });
      }
    } catch (error) {
      await testInfo.attach("firefox-tabs.txt", { body: `No screenshots: ${error}`, contentType: "text/plain" });
    }
    await testInfo.attach("geckodriver.log", { path: this.logPath, contentType: "text/plain" });
  }

  cmd<T = unknown>(method: string, route: string, body?: unknown): Promise<T> {
    return call<T>(method, `/session/${this.sessionId}${route}`, body);
  }

  /** Installs the Firefox build as a temporary add-on, and returns its add-on ID. */
  installExtension(): Promise<string> {
    return this.cmd<string>("POST", "/moz/addon/install", { path: paths.firefoxExtension, temporary: true });
  }

  // Tabs. Each test keeps to one window, so that whichever tab is chosen is
  // the one on screen, as for a person.

  handle = () => this.cmd<string>("GET", "/window");
  handles = () => this.cmd<string[]>("GET", "/window/handles");
  switchTo = (handle: string) => this.cmd("POST", "/window", { handle });

  /** A new tab in this window, chosen. */
  async newTab(): Promise<string> {
    const { handle } = await this.cmd<{ handle: string }>("POST", "/window/new", { type: "tab" });
    await this.switchTo(handle);
    return handle;
  }

  /** Closes the chosen tab. */
  closeTab = () => this.cmd("DELETE", "/window");

  goto = (url: string) => this.cmd("POST", "/url", { url });
  url = () => this.cmd<string>("GET", "/url");
  title = () => this.cmd<string>("GET", "/title");

  /** Runs a script in the chosen tab or frame; a promise it returns is awaited. */
  run<T = unknown>(script: string, ...args: unknown[]): Promise<T> {
    return this.cmd<T>("POST", "/execute/sync", { script, args });
  }

  // Frames.

  /** Back to the tab's own page. */
  top = () => this.cmd("POST", "/frame", { id: null });

  /** Out to the frame that holds the chosen one. */
  parentFrame = () => this.cmd("POST", "/frame/parent");

  /**
   * Into the frame of the tab's page whose address contains `part`, at any
   * depth, found by its place among each page's frames: the extension puts
   * its frames inside closed shadow roots, where no selector reaches, but a
   * frame is a frame. The menu inside a field is two deep: the page holds
   * overlay/menu.html, which holds the button or the list.
   */
  async intoFrame(part: string, timeout = 15_000) {
    await expect
      .poll(
        async () => {
          await this.top();
          return this.findFrame(part, 0);
        },
        { timeout, message: `a frame at ${part}` },
      )
      .toBe(true);
  }

  /** Depth first from the chosen frame: ends inside the one found, or back where it started. */
  private async findFrame(part: string, depth: number): Promise<boolean> {
    if (depth > 3) return false;
    for (let i = 0; ; i++) {
      try {
        await this.cmd("POST", "/frame", { id: i });
      } catch (error) {
        if (error instanceof WebDriverError && error.error === "no such frame") return false;
        throw error;
      }
      const href = await this.run<string>("return location.href").catch(() => "");
      if (href.includes(part) || (await this.findFrame(part, depth + 1))) return true;
      await this.parentFrame();
    }
  }

  // Elements.

  /** The first element the selector finds that's shown, or null. */
  async shown(selector: string): Promise<string | null> {
    const found = await this.cmd<Record<string, string>[]>("POST", "/elements", by(selector));
    for (const element of found) {
      const id = element[ELEMENT];
      const displayed = await this.cmd<boolean>("GET", `/element/${id}/displayed`).catch(() => false);
      if (displayed) return id;
    }
    return null;
  }

  /** Waits until the selector finds an element that's shown. */
  async waitFor(selector: string, timeout = 15_000): Promise<string> {
    let id: string | null = null;
    await expect
      .poll(async () => (id = await this.shown(selector)), { timeout, message: `${selector} is shown` })
      .not.toBeNull();
    return id!;
  }

  /** Clicks an element once it's shown, again if something was over it or it was replaced. */
  async click(selector: string, timeout = 15_000) {
    await expect(async () => {
      const id = await this.waitFor(selector, 1_000);
      await this.cmd("POST", `/element/${id}/click`);
    }).toPass({ timeout });
  }

  /** Types into an element once it's shown, key by key, as a person does. */
  async type(selector: string, text: string, timeout = 15_000) {
    const id = await this.waitFor(selector, timeout);
    await this.cmd("POST", `/element/${id}/value`, { text });
  }

  /**
   * Presses keys on an element once it's shown: WebDriver focuses it first.
   * For a button in one of the extension's frames, Enter is a person's way to
   * press it that needs no screen position: a click WebDriver synthesizes
   * inside such a frame (another process) never reached its button in
   * Firefox 158.
   */
  async pressOn(selector: string, ...keys: string[]) {
    const id = await this.waitFor(selector);
    await this.cmd("POST", `/element/${id}/value`, { text: keys.join("") });
  }

  /** A form field's value. */
  async value(selector: string): Promise<string> {
    const id = await this.waitFor(selector);
    return this.cmd<string>("GET", `/element/${id}/property/value`);
  }

  /** Presses keys where the focus is, in the chosen tab or frame. */
  async press(...keys: string[]) {
    await this.cmd("POST", "/actions", {
      actions: [
        {
          type: "key",
          id: "keyboard",
          actions: keys.flatMap((value) => [
            { type: "keyDown", value },
            { type: "keyUp", value },
          ]),
        },
      ],
    });
    await this.cmd("DELETE", "/actions");
  }

  // The popup, in a tab of its own.

  openPopup = () => this.goto(popupUrl);

  /** Signs the popup in to a server of one's own, as Chrome's tests do (support/extension.ts, logInPopup). */
  async signIn(account: { email: string; password: string }, server = serverUrl) {
    // The carousel draws its buttons before they work, and an early click is
    // dropped: click until the app actually goes to the sign-in.
    await expect(async () => {
      if (!(await this.url()).includes("#/login")) {
        await this.click("//button[normalize-space(.)='Sign in']", 2_000);
      }
      await expect.poll(() => this.url(), { timeout: 1_000 }).toContain("#/login");
    }).toPass({ timeout: 30_000 });
    // "Where's your vault?": our own server, typed in place.
    await this.click("//button[@data-part='segment'][normalize-space(.)='Self-hosted']");
    await this.type("#keykeeper-server-address", server);
    await this.type("[data-testid='login-email-input']", account.email);
    await this.click("[data-testid='login-continue-button']");
    await this.type("[data-testid='login-master-password-input']", account.password);
    await this.click("[data-testid='login-submit-button']");
    await this.waitForVault();
  }

  /** The popup's vault, after a sign-in or an unlock (key derivation and the first sync take a while on a slow runner). */
  waitForVault = () => this.waitFor(heading("Items"), 60_000);
}

/** A heading whose text contains these words, as Chrome's tests look for one. */
export const heading = (words: string) =>
  `//*[self::h1 or self::h2 or self::h3 or self::h4 or self::h5 or self::h6 or @role='heading'][contains(normalize-space(.), '${words}')]`;

/** An item in the popup's vault list, by name. */
export const itemNamed = (name: string) => `//*[@data-testid='item-name'][normalize-space(.)='${name}']`;

/** Whether the build in KK_FIREFOX_EXTENSION is the Firefox one: the Chrome build writes the same folder. */
function checkFirefoxBuild() {
  const manifestPath = path.join(paths.firefoxExtension, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No extension build at ${paths.firefoxExtension} (KK_FIREFOX_EXTENSION): npm run build:prod:firefox in apps/browser.`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const id = manifest.browser_specific_settings?.gecko?.id;
  if (id !== brand.extension.firefoxId) {
    throw new Error(
      `${paths.firefoxExtension} isn't the branded Firefox build (its add-on ID is ${id ?? "missing"}, not ${brand.extension.firefoxId}): build it with npm run build:prod:firefox after brand/apply.mjs.`,
    );
  }
}

export const test = base.extend<{ firefox: Firefox }, { firefoxVersion: string }>({
  // Once per run, before any test and on a time limit of its own: Firefox's
  // first start on a fresh runner reads it from a disk the cloud fills in as
  // it's read. Says which Firefox and geckodriver the tests ran on.
  firefoxVersion: [
    async ({}, use) => {
      checkFirefoxBuild();
      const firefox = await Firefox.start();
      const version = firefox.version;
      await firefox.stop();
      const driver = spawnSync(paths.geckodriver, ["--version"], { encoding: "utf8" }).stdout.split("\n")[0];
      console.log(`Firefox ${version} (${paths.firefox}), ${driver}`);
      await use(version);
    },
    { scope: "worker", timeout: 120_000 },
  ],
  // A Firefox of its own for each test, with the extension installed. A new
  // install opens its welcome page in a tab; the test starts once it has, on
  // the first tab, so the welcome page can't come up over a page later.
  firefox: async ({ firefoxVersion }, use, testInfo) => {
    testInfo.annotations.push({ type: "Firefox", description: firefoxVersion });
    const firefox = await Firefox.start();
    try {
      const first = await firefox.handle();
      const id = await firefox.installExtension();
      expect(id, "the add-on ID Firefox installed it under").toBe(brand.extension.firefoxId);
      await expect
        .poll(async () => (await firefox.handles()).length, {
          timeout: 15_000,
          message: "a new install opens its welcome page in a tab",
        })
        .toBeGreaterThan(1);
      for (const handle of await firefox.handles()) {
        if (handle !== first) {
          await firefox.switchTo(handle);
          await firefox.closeTab();
        }
      }
      await firefox.switchTo(first);
      await use(firefox);
    } finally {
      await firefox.stop(testInfo);
    }
  },
});
