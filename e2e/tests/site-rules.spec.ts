// Site rules from a signed feed, end to end (DESIGN.md, "Fill rules for
// everyone", phase 2): the hand-made rules (tools/site-rules/rules.json),
// signed by tools/site-rules/sign.mjs with the test vectors' key, served from
// this machine, and mirrored by servers started with SITE_RULES_FEED=<that
// feed> and SITE_RULES_FEED_KEY=<the test public key>: an operator's own
// feed, so an ordinary build of the extension takes it and no test-only build
// is needed. The extension fills a sign-in inside a shadow root by the feed's
// selectors, where the generic matching finds no username, and refuses the
// same feed with one byte of its manifest changed.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import fs from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";

import { brand, siteRulesChangedServerPort, siteRulesFeedPort, siteRulesServerPort } from "../paths.mjs";

import { addLogin, waitForExtensionScan, waitForInlineMenuItem } from "./support/autofill";
import { createAccount, expect, logInPopup, openPopup, test, userFor } from "./support/extension";

const e2eDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const metaDir = path.resolve(e2eDir, "..");
const vectors = JSON.parse(fs.readFileSync(path.join(metaDir, "docs/vectors/site-rules-v1.json"), "utf8"));

const PAGE = "https://corpus.example.test/site-rules-shadow.html";
const RULE = "corpus-shadow-member-number";
const ITEM = "Member login";
const USERNAME = "member-4821";
const PASSWORD = "not-a-real-password-site-rules";

test.describe.configure({ mode: "serial", timeout: 180_000 });

type Feed = { dir: string; files: Record<string, string> };
type Server = { url: string; child: ChildProcess; dataDir: string };

let tmp: string;
let feedHost: HttpServer;
const asked = new Set<string>();
let good: Feed;
let changed: Feed;
let servers: Server[] = [];

/** The feed's files in a folder, by name. */
const read = (dir: string): Feed => ({
  dir,
  files: Object.fromEntries(fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")])),
});

/** Signs the hand-made rules with the test vectors' key, through the signing script, as an operator would. */
function signFeed(): Feed {
  // The test key, written for the script to read and removed at once. It's
  // the vectors' published test key (docs/vectors/site-rules-v1.json),
  // trusted here only because this test's server names it.
  const keyFile = path.join(tmp, "test-only-key.pem");
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(vectors.key.seed, "hex")]);
  fs.writeFileSync(keyFile, createPrivateKey({ key: der, format: "der", type: "pkcs8" }).export({ format: "pem", type: "pkcs8" }), {
    mode: 0o600,
  });
  // Rules last verified today, so the 90-day limit never runs out on this test.
  const source = JSON.parse(fs.readFileSync(path.join(metaDir, "tools/site-rules/rules.json"), "utf8"));
  const today = new Date().toISOString().slice(0, 10);
  for (const entry of Object.values<{ forms?: unknown[]; pathnames?: Record<string, { forms: unknown[] }> }>(source.hosts)) {
    for (const form of [...(entry.forms ?? []), ...Object.values(entry.pathnames ?? {}).flatMap((p) => p.forms)]) {
      (form as { passbundle: { verified: string } }).passbundle.verified = today;
    }
  }
  const sourceFile = path.join(tmp, "rules.json");
  fs.writeFileSync(sourceFile, JSON.stringify(source));
  const dir = path.join(tmp, "good");
  try {
    execFileSync(
      process.execPath,
      [
        path.join(metaDir, "tools/site-rules/sign.mjs"),
        ...["--key", keyFile, "--rules", sourceFile, "--out", dir, "--sequence", "1"],
        ...["--public-key", vectors.key.public],
      ],
      { stdio: "pipe" },
    );
  } finally {
    fs.rmSync(keyFile, { force: true });
  }
  return read(dir);
}

/** The same feed with one byte of its manifest changed: its sequence, 1, becomes 2. */
function changeOneByte(feed: Feed): Feed {
  const dir = path.join(tmp, "changed");
  fs.mkdirSync(dir);
  for (const [name, contents] of Object.entries(feed.files)) {
    fs.writeFileSync(path.join(dir, name), name === "manifest.json" ? contents.replace('"sequence":1', '"sequence":2') : contents);
  }
  const result = read(dir);
  expect(result.files["manifest.json"]).not.toBe(feed.files["manifest.json"]);
  expect(result.files["manifest.json"].length).toBe(feed.files["manifest.json"].length);
  return result;
}

async function startServer(http: APIRequestContext, port: string, feedUrl: string): Promise<Server> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-e2e-site-rules-server-"));
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: e2eDir,
    env: {
      ...process.env,
      KK_PORT: port,
      KK_DATA_DIR: dataDir,
      KK_SITE_RULES_FEED: feedUrl,
      KK_SITE_RULES_FEED_KEY: vectors.key.public,
    },
    stdio: "ignore",
  });
  const url = `https://127.0.0.1:${port}`;
  await expect
    .poll(async () => (await http.get(`${url}/alive`).catch(() => null))?.status() ?? 0, { timeout: 60_000 })
    .toBe(200);
  return { url, child, dataDir };
}

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(120_000);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-e2e-site-rules-"));
  good = signFeed();
  changed = changeOneByte(good);
  feedHost = createServer((req, res) => {
    const [, folder, name] = new URL(req.url ?? "/", "http://x").pathname.split("/");
    asked.add(`${folder}/${name}`);
    const feed = folder === "good" ? good : folder === "changed" ? changed : null;
    if (feed == null || !Object.hasOwn(feed.files, name)) {
      return res.writeHead(404).end();
    }
    res.writeHead(200, { "content-type": name.endsWith(".json") ? "application/json" : "text/plain" });
    res.end(feed.files[name]);
  });
  await new Promise<void>((resolve) => feedHost.listen(Number(siteRulesFeedPort), "127.0.0.1", resolve));
  const feedUrl = (folder: string) => `http://127.0.0.1:${siteRulesFeedPort}/${folder}/`;
  const alive = await playwright.request.newContext({ ignoreHTTPSErrors: true });
  try {
    servers = [
      await startServer(alive, siteRulesServerPort, feedUrl("good")),
      await startServer(alive, siteRulesChangedServerPort, feedUrl("changed")),
    ];
  } finally {
    await alive.dispose();
  }
  // Each server mirrors its feed as it starts: the rules file comes last.
  const rulesFile = Object.keys(good.files).find((name) => name.startsWith("forms-"))!;
  await expect
    .poll(() => asked.has(`good/${rulesFile}`) && asked.has(`changed/${rulesFile}`), { timeout: 30_000 })
    .toBe(true);
});

test.afterAll(async () => {
  for (const server of servers) {
    const exited = new Promise((resolve) => server.child.once("exit", resolve));
    server.child.kill("SIGTERM");
    await exited;
    fs.rmSync(server.dataDir, { recursive: true, force: true });
  }
  servers = [];
  await new Promise((resolve) => feedHost?.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A person with a login for the page, signed in to the extension on this server. */
async function signedIn(context: BrowserContext, extensionId: string, server: string, name: string, repeat: number) {
  const user = { ...userFor(name, repeat), email: `${name}-${repeat}-${Date.now()}@example.test` };
  const web = await createAccount(context, user, server);
  await addLogin(web, { name: ITEM, username: USERNAME, password: PASSWORD, uri: "https://corpus.example.test" });
  const view = web.getByRole("dialog", { name: "View Login" });
  await view.getByRole("button", { name: "Close" }).first().click();
  await expect(view).toBeHidden();
  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, user, server);
  return popup;
}

/**
 * Checks the feed now, as unlocking does, and answers what the server
 * mirrors (its source and manifest, through the extension's own session) and
 * which rules the extension kept for the page.
 */
async function checkFeed(context: BrowserContext) {
  return context.serviceWorkers()[0].evaluate(async (page) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const main = (self as any).bitwardenMain;
    const userId = await new Promise<string>((resolve) =>
      main.accountService.activeAccount$.subscribe((a: { id: string }) => resolve(a.id)),
    );
    await main.keykeeperSiteRules.refreshActive();
    const token = await main.apiService.getActiveBearerToken(userId);
    const api = await new Promise<string>((resolve) =>
      main.environmentService.getEnvironment$(userId).subscribe((e: { getApiUrl(): string }) => resolve(e.getApiUrl())),
    );
    const get = (name: string) =>
      fetch(`${api}/keykeeper/site-rules${name}`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.text());
    return {
      source: JSON.parse(await get("")),
      manifest: await get("/manifest.json"),
      rules: ((await main.keykeeperSiteRules.rulesFor(page)) as { id: string }[]).map((r) => r.id),
    };
  }, PAGE);
}

/**
 * Picks the login from the menu in the password field, with the keyboard, as
 * the shared helper does, but the field is in a shadow root, so the page's
 * own focus is the shadow host: it asks whether an input deep down still has
 * it (as autofill-corpus.spec.ts does), so Enter never submits the form.
 */
async function fillFromPasswordMenu(context: BrowserContext, page: Page) {
  await page.locator("#secret").click();
  await waitForInlineMenuItem(context, page, ITEM);
  const focusLeftThePage = () =>
    page.evaluate(() => {
      let el: Element | null = document.activeElement;
      while (el?.shadowRoot?.activeElement) {
        el = el.shadowRoot.activeElement;
      }
      return el?.tagName !== "INPUT";
    });
  await expect(async () => {
    if (!(await focusLeftThePage())) {
      await page.keyboard.press("ArrowDown");
    }
    await expect.poll(focusLeftThePage, { timeout: 1000 }).toBe(true);
  }).toPass({ timeout: 10_000 });
  await page.keyboard.press("Enter");
}

/** The selectors the content script found the member number field by, as the extension scanned the page. */
async function memberNumberSelectors(context: BrowserContext) {
  return context.serviceWorkers()[0].evaluate(async (page) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url === page);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const details = (self as any).bitwardenMain.overlayBackground.pageDetailsForTab[tab!.id!]?.get(0)?.details;
    return (details?.fields ?? []).find((f: { htmlID?: string }) => f.htmlID === "member-number")?.keykeeperSelectors ?? null;
  }, PAGE);
}

test("a sign-in inside a shadow root fills from the operator's signed feed, by its selectors", async ({
  context,
  extensionId,
}, testInfo) => {
  const popup = await signedIn(context, extensionId, servers[0].url, "site-rules", testInfo.repeatEachIndex);

  // "Use PassBundle's site rules" is on by default; an operator's feed goes
  // with "Use fixes other people share", on by default too.
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html#/autofill`);
  const settings = popup.getByTestId("site-fixes-settings");
  await expect(settings.getByRole("checkbox", { name: `Use ${brand.name}'s site rules` })).toBeChecked();
  await expect(settings.getByRole("checkbox", { name: "Use fixes other people share" })).toBeChecked();

  // The server says whose feed it is and mirrors its files unchanged; the
  // extension takes it, checked with the key the server names.
  const feed = await checkFeed(context);
  expect(feed.source).toEqual({ feed: "operator", key: vectors.key.public });
  expect(feed.manifest).toBe(good.files["manifest.json"]);
  expect(feed.rules).toEqual([RULE]);

  const page = await context.newPage();
  await page.goto(PAGE);
  await waitForExtensionScan(context, page, "secret");
  await expect.poll(() => memberNumberSelectors(context)).toEqual(["#signin-box >>> #member-number"]);
  await fillFromPasswordMenu(context, page);
  await expect(page.locator("#member-number")).toHaveValue(USERNAME);
  await expect(page.locator("#secret")).toHaveValue(PASSWORD);
});

test("the same feed with one byte of its manifest changed is refused, and the member number stays empty", async ({
  context,
  extensionId,
}, testInfo) => {
  await signedIn(context, extensionId, servers[1].url, "site-rules-changed", testInfo.repeatEachIndex);

  // The server mirrors the changed manifest as it got it (it can't check the
  // signature, the extension does), and the extension keeps nothing.
  const feed = await checkFeed(context);
  expect(feed.source).toEqual({ feed: "operator", key: vectors.key.public });
  expect(feed.manifest).toBe(changed.files["manifest.json"]);
  expect(feed.rules).toEqual([]);

  const page = await context.newPage();
  await page.goto(PAGE);
  await waitForExtensionScan(context, page, "secret");
  expect(await memberNumberSelectors(context)).toBeNull();
  await fillFromPasswordMenu(context, page);
  // The generic matching still fills the password, and finds no username.
  await expect(page.locator("#secret")).toHaveValue(PASSWORD);
  await expect(page.locator("#member-number")).toHaveValue("");
});
