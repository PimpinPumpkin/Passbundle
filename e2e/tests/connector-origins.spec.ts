// The vault's connector pages answer only the vault itself and PassBundle's
// own extension (DESIGN.md, "Connector pages"). A page on another site that
// frames the security key connector, as a real-time phishing page would,
// gets nothing: the server forbids the frame, and even where that header is
// lost the connector asks no key and sends nothing. The server refuses every
// security key answer made in a frame, whichever page asked for it. The
// connector pages still work under their own policy, and signing in with a
// security key still works in the web vault (its own frame) and in the
// extension (a tab of its own).
//
// WebAuthn won't take an IP address as a site's name, so these tests start a
// server of their own named vault.connectors.test, which the browser
// resolves to it. The other site's page is a fixture
// (fixtures/autofill/frames-security-key.html) on the fixture server: a
// real site, so the browser's local network checks treat both alike.
import { type ChildProcess, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type APIRequestContext,
  type BrowserContext,
  type Frame,
  type Page,
  expect,
  request as apiRequest,
  test,
} from "@playwright/test";

import { brand, connectorServerPort, hostResolverRules, port } from "../paths.mjs";

import { extensionIdOf, launchWithExtension, openPopup } from "./support/extension";
import { signUp, skipImport, webUserFor, type WebUser } from "./support/web";

const e2eDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const vaultHost = "vault.connectors.test";
const vault = `https://${vaultHost}`;
// The browser reaches the server by its name; these tests' own requests go
// straight to its address.
const serverAddress = `https://127.0.0.1:${connectorServerPort}`;
const rules = hostResolverRules.replace(
  "--host-resolver-rules=",
  `--host-resolver-rules=MAP ${vaultHost} 127.0.0.1:${connectorServerPort}, `,
);
const otherSite = "https://phish.example.test";
const otherPage = `${otherSite}/frames-security-key.html`;
const ourExtension = `chrome-extension://${brand.extension.chromiumId}`;
const connectorPolicy =
  "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; " +
  `frame-ancestors 'self' ${ourExtension}`;

let server: ChildProcess;
let dataDir: string;

test.beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-e2e-connectors-"));
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: e2eDir,
    env: {
      ...process.env,
      KK_PORT: connectorServerPort,
      KK_DOMAIN: vault,
      KK_DATA_DIR: dataDir,
    },
    stdio: "ignore",
  });
  const http = await apiRequest.newContext({ ignoreHTTPSErrors: true });
  await expect
    .poll(async () => (await http.get(`${serverAddress}/alive`).catch(() => null))?.status() ?? 0, {
      timeout: 60_000,
    })
    .toBe(200);
  await http.dispose();
});

test.afterAll(async () => {
  const exited = new Promise((resolve) => server.once("exit", resolve));
  server.kill("SIGTERM");
  await exited;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test.use({ launchOptions: { args: [rules] }, baseURL: vault, ignoreHTTPSErrors: true });

// ---- The server's API, as a client calls it ----

async function apiClient(): Promise<APIRequestContext> {
  return apiRequest.newContext({ baseURL: serverAddress, ignoreHTTPSErrors: true });
}

/** The master password hash the apps send, from the account's own KDF settings. */
async function masterPasswordHash(http: APIRequestContext, user: WebUser): Promise<string> {
  const prelogin = await http.post("/identity/accounts/prelogin", { data: { email: user.email } });
  expect(prelogin.status(), await prelogin.text()).toBe(200);
  const kdf = await prelogin.json();
  expect(kdf.kdf, "these tests derive PBKDF2 keys only").toBe(0);
  const salt = user.email.trim().toLowerCase();
  const masterKey = crypto.pbkdf2Sync(user.password, salt, kdf.kdfIterations, 32, "sha256");
  return crypto.pbkdf2Sync(masterKey, user.password, 1, 32, "sha256").toString("base64");
}

function signInForm(user: WebUser, hash: string) {
  return {
    grant_type: "password",
    username: user.email,
    password: hash,
    scope: "api offline_access",
    client_id: "web",
    deviceType: "9",
    deviceIdentifier: crypto.randomUUID(),
    deviceName: "chrome",
  };
}

/**
 * Starts signing in with the master password, up to the security key step:
 * the form to finish with, and the challenge the vault sent for the key.
 */
async function pendingSignIn(http: APIRequestContext, user: WebUser, hash: string) {
  const form = signInForm(user, hash);
  const response = await http.post("/identity/connect/token", { form });
  const body = await response.json();
  expect(response.status(), JSON.stringify(body)).toBe(400);
  expect(body.TwoFactorProviders).toEqual(["7"]);
  return { form, options: body.TwoFactorProviders2["7"] };
}

async function finishSignIn(http: APIRequestContext, form: Record<string, string>, answer: string) {
  const response = await http.post("/identity/connect/token", {
    form: { ...form, twoFactorProvider: "7", twoFactorToken: answer, twoFactorRemember: "0" },
  });
  return { status: response.status(), body: await response.json() };
}

// ---- Security keys ----

type Credential = {
  credentialId: string;
  isResidentCredential: boolean;
  rpId?: string;
  privateKey: string;
  userHandle?: string;
  signCount: number;
};

/**
 * A security key in this tab: Chromium's virtual authenticator, which answers
 * at once, holding a copy of `credential` when given.
 */
async function securityKey(context: BrowserContext, page: Page, credential?: Credential) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "usb",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  if (credential) {
    await cdp.send("WebAuthn.addCredential", { authenticatorId, credential });
  }
  return {
    async credential(): Promise<Credential> {
      const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
      expect(credentials).toHaveLength(1);
      return credentials[0] as Credential;
    },
  };
}

/**
 * Adds a security key for two-step login, through the API with the key in
 * this vault tab; returns the key's credential, to copy into other tabs.
 */
async function addSecurityKey(context: BrowserContext, page: Page, user: WebUser): Promise<Credential> {
  const key = await securityKey(context, page);
  const http = await apiClient();
  const hash = await masterPasswordHash(http, user);
  const signedIn = await http.post("/identity/connect/token", { form: signInForm(user, hash) });
  expect(signedIn.status(), await signedIn.text()).toBe(200);
  const headers = { Authorization: `Bearer ${(await signedIn.json()).access_token}` };
  const challenge = await http.post("/api/two-factor/get-webauthn-challenge", {
    data: { masterPasswordHash: hash },
    headers,
  });
  expect(challenge.status(), await challenge.text()).toBe(200);
  const options = await challenge.json();
  // Chromium asks a security key only for the focused tab.
  await page.bringToFront();
  const deviceResponse = await page.evaluate(async (options) => {
    const bytes = (s: string) =>
      Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const text = (b: ArrayBuffer) =>
      btoa(String.fromCharCode(...new Uint8Array(b)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    const { status: _status, errorMessage: _errorMessage, ...publicKey } = options;
    const made = (await navigator.credentials.create({
      publicKey: {
        ...publicKey,
        challenge: bytes(options.challenge),
        user: { ...options.user, id: bytes(options.user.id) },
        excludeCredentials: (options.excludeCredentials ?? []).map((c: { id: string }) => ({
          ...c,
          id: bytes(c.id),
        })),
      },
    })) as PublicKeyCredential;
    const response = made.response as AuthenticatorAttestationResponse;
    return {
      id: made.id,
      rawId: text(made.rawId),
      type: made.type,
      response: {
        attestationObject: text(response.attestationObject),
        clientDataJSON: text(response.clientDataJSON),
      },
    };
  }, options);
  const added = await http.put("/api/two-factor/webauthn", {
    data: { id: 1, name: "Test key", masterPasswordHash: hash, deviceResponse },
    headers,
  });
  expect(added.status(), await added.text()).toBe(200);
  await http.dispose();
  return key.credential();
}

/**
 * Asks the security key in this page or frame for its answer to a challenge,
 * and gives the answer as the vault's connector would send it.
 */
async function answerIn(target: Page | Frame, options: unknown): Promise<string> {
  return target.evaluate(async (options: any) => {
    const bytes = (s: string) =>
      Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const text = (b: ArrayBuffer) =>
      btoa(String.fromCharCode(...new Uint8Array(b)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    const answer = (await navigator.credentials.get({
      publicKey: {
        ...options,
        challenge: bytes(options.challenge),
        allowCredentials: options.allowCredentials.map((c: { id: string }) => ({ ...c, id: bytes(c.id) })),
      },
    })) as PublicKeyCredential;
    const response = answer.response as AuthenticatorAssertionResponse;
    return JSON.stringify({
      id: answer.id,
      rawId: text(answer.rawId),
      type: answer.type,
      extensions: answer.getClientExtensionResults(),
      response: {
        authenticatorData: text(response.authenticatorData),
        clientDataJson: text(response.clientDataJSON),
        signature: text(response.signature),
      },
    });
  }, options);
}

const clientData = (answer: string) =>
  JSON.parse(Buffer.from(JSON.parse(answer).response.clientDataJson, "base64url").toString());

// ---- The other site ----

/**
 * Opens the other site's page, which frames the vault's security key
 * connector as WebAuthnIFrame would, with the challenge it relayed from the
 * vault, naming itself as the parent.
 */
async function openOtherSite(page: Page, options: unknown) {
  const params = new URLSearchParams({
    data: Buffer.from(JSON.stringify(options)).toString("base64"),
    parent: encodeURIComponent(otherPage),
    btnText: encodeURIComponent("Read security key"),
    v: "1",
  });
  await page.goto(`${otherPage}#${encodeURIComponent(`${vault}/webauthn-connector.html?${params}`)}`);
}

/** As if a proxy in front of the server dropped its headers. */
async function dropConnectorHeaders(context: BrowserContext) {
  await context.route(`${vault}/webauthn-connector.html*`, async (route) => {
    const response = await route.fetch({ url: route.request().url().replace(vault, serverAddress) });
    const headers = { ...response.headers() };
    delete headers["content-security-policy"];
    delete headers["x-frame-options"];
    await route.fulfill({ response, headers });
  });
}

const received = (page: Page) => page.evaluate(() => (window as any).received as unknown[]);

// ---- Tests ----

test("connector pages may be framed only by the vault and PassBundle's extension", async () => {
  const http = await apiClient();
  for (const page of [
    "webauthn-connector.html",
    "webauthn-fallback-connector.html",
    "duo-redirect-connector.html",
    "sso-connector.html",
    "redirect-connector.html",
  ]) {
    const response = await http.get(`/${page}`);
    expect(response.status(), page).toBe(200);
    expect(response.headers()["content-security-policy"], page).toBe(connectorPolicy);
    expect(response.headers()["x-frame-options"], page).toBe("SAMEORIGIN");
    // HTTPS only, on a host name; names under it only when the server is
    // told to (HSTS_INCLUDE_SUBDOMAINS).
    expect(response.headers()["strict-transport-security"], page).toBe("max-age=31536000");
  }
  // The vault's other pages: the same, and no other extension.
  const main = (await http.get("/")).headers()["content-security-policy"];
  expect(main).toMatch(new RegExp(`frame-ancestors 'self' ${ourExtension} ?;`));
  expect(main).not.toContain("moz-extension");
  // Upstream's mobile page and its deep links are gone.
  expect((await http.get("/webauthn-mobile-connector.html")).status()).toBe(404);
  // No HSTS for a server at an address (the main test server).
  const atAddress = await http.get(`https://127.0.0.1:${port}/webauthn-connector.html`);
  expect(atAddress.status()).toBe(200);
  expect(atAddress.headers()["strict-transport-security"]).toBeUndefined();
  await http.dispose();
});

test("connector pages work under their own policy", async ({ page }) => {
  const refused: string[] = [];
  page.on("console", (m) => {
    if (m.text().includes("Content Security Policy")) refused.push(m.text());
  });
  page.on("pageerror", (e) => refused.push(String(e)));

  // The extension's security key tab: its script, styles, logo, and words.
  const options = { challenge: "dGVzdA", allowCredentials: [] };
  const params = new URLSearchParams({
    data: Buffer.from(JSON.stringify(options)).toString("base64"),
    parent: encodeURIComponent(`${vault}/`),
    v: "1",
    locale: "en",
  });
  await page.goto(`/webauthn-fallback-connector.html?${params}`);
  await expect(page.getByRole("button", { name: "Read security key" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Verify your Identity" })).toBeVisible();

  // Duo's answer for the web vault.
  await page.goto("/duo-redirect-connector.html?client=web&code=a-code&state=a-state");
  await expect(page.getByText("You successfully logged in")).toBeVisible();

  // The email links' redirect, into the vault.
  await page.goto("/redirect-connector.html#login");
  await expect(page).toHaveURL(`${vault}/#/login`);

  // Duo's start, for the extension: it goes on to Duo, which the policy
  // doesn't stop (Duo's host doesn't resolve in the tests).
  const duo = "https://api-a1b2c3.duosecurity.com/oauth/v1/authorize?client_id=x";
  const toDuo = page.waitForRequest((r) => r.url().startsWith("https://api-a1b2c3.duosecurity.com/"));
  await page.goto(`/duo-redirect-connector.html?duoFramelessUrl=${encodeURIComponent(duo)}`).catch(() => {});
  await toDuo;

  expect(refused).toEqual([]);
});

test("a page on another site that frames the security key connector gets nothing", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const user = webUserFor("connector-framed", testInfo.repeatEachIndex);
  await signUp(page, user);
  const credential = await addSecurityKey(context, page, user);

  // The other site relays a real sign-in's challenge to its own frame.
  const http = await apiClient();
  const hash = await masterPasswordHash(http, user);
  const { options } = await pendingSignIn(http, user, hash);
  const phish = await context.newPage();
  const key = await securityKey(context, phish, credential);
  const served = phish.waitForResponse((r) => r.url().startsWith(`${vault}/webauthn-connector.html`));
  await openOtherSite(phish, options);
  // The server sends the connector with its frame-ancestors, and the browser
  // shows an error page in the frame instead.
  expect((await served).headers()["content-security-policy"]).toBe(connectorPolicy);
  await expect
    .poll(() => phish.frames().map((f) => f.url()))
    .toEqual([phish.url(), "chrome-error://chromewebdata/"]);
  expect(await received(phish)).toEqual([]);
  expect((await key.credential()).signCount).toBe(credential.signCount);
  await http.dispose();
});

test("without the server's header, the connector itself answers no other site", async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const user = webUserFor("connector-headerless", testInfo.repeatEachIndex);
  await signUp(page, user);
  const credential = await addSecurityKey(context, page, user);

  const http = await apiClient();
  const hash = await masterPasswordHash(http, user);
  const { form, options } = await pendingSignIn(http, user, hash);
  await dropConnectorHeaders(context);
  const phish = await context.newPage();
  const key = await securityKey(context, phish, credential);
  await openOtherSite(phish, options);
  // The frame loads this time, and refuses: no key asked, nothing sent.
  const frame = phish.frameLocator("#key");
  await expect(frame.locator("body")).toHaveText("This page works only inside your vault.");
  await expect(frame.locator("body[data-refused]")).toHaveCount(1);
  expect(await received(phish)).toEqual([]);
  expect((await key.credential()).signCount).toBe(credential.signCount);

  // The server refuses an answer made in that frame anyway, as it does any
  // answer made in a frame: here the test asks, inside the vault's own frame.
  const inFrame = phish.frames().find((f) => f.url().startsWith(`${vault}/webauthn-connector.html`))!;
  const framedAnswer = await answerIn(inFrame, options);
  expect(clientData(framedAnswer)).toMatchObject({ origin: vault, crossOrigin: true, topOrigin: otherSite });
  const refused = await finishSignIn(http, form, framedAnswer);
  expect(refused.status, JSON.stringify(refused.body)).toBe(400);
  expect(JSON.stringify(refused.body)).toContain("used inside another page");

  // The same key, answering on the vault's own page, signs in.
  const again = await pendingSignIn(http, user, hash);
  const vaultPage = await context.newPage();
  await securityKey(context, vaultPage, credential);
  await vaultPage.goto("/404.html");
  const ownAnswer = await answerIn(vaultPage, again.options);
  expect(clientData(ownAnswer)).toMatchObject({ origin: vault, crossOrigin: false });
  const signedIn = await finishSignIn(http, again.form, ownAnswer);
  expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
  expect(signedIn.body.access_token).toBeTruthy();
  await http.dispose();
});

test("the web vault signs in with a security key, in its own frame", async ({ browser, context, page }, testInfo) => {
  test.setTimeout(120_000);
  const user = webUserFor("connector-web", testInfo.repeatEachIndex);
  await signUp(page, user);
  const credential = await addSecurityKey(context, page, user);

  const other = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: vault });
  const web = await other.newPage();
  const key = await securityKey(other, web, credential);
  await web.goto("/#/login");
  await web.getByLabel(/Email address/).fill(user.email);
  await web.getByRole("button", { name: "Continue" }).click();
  await web.getByRole("textbox", { name: /Master password/ }).fill(user.password);
  await web.getByRole("button", { name: "Log in", exact: true }).click();
  // The two-step page frames the connector, which asks the key at once.
  await expect(web).toHaveTitle(/^Items/, { timeout: 30_000 });
  expect((await key.credential()).signCount).toBeGreaterThan(credential.signCount);
  await other.close();
});

test("the extension signs in with a security key, in a tab of its own", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const { context, profile } = await launchWithExtension(rules);
  try {
    const extensionId = await extensionIdOf(context);
    // The manifest's key gives the extension PassBundle's own ID.
    expect(extensionId).toBe(brand.extension.chromiumId);

    const user = webUserFor("connector-extension", testInfo.repeatEachIndex);
    const web = await context.newPage();
    await web.goto(`${vault}/#/signup`);
    await web.getByLabel(/Email address/).fill(user.email);
    await web.getByLabel("Name").fill(user.name);
    await web.getByRole("button", { name: "Continue" }).click();
    await web.getByRole("textbox", { name: /^Master password/ }).first().fill(user.password);
    await web.getByRole("textbox", { name: /Confirm master password/ }).fill(user.password);
    await web.getByRole("button", { name: "Create account" }).click();
    await skipImport(web);
    const credential = await addSecurityKey(context, web, user);

    const popup = await openPopup(context, extensionId);
    await expect(async () => {
      await popup.getByRole("button", { name: "Log in" }).click();
      await expect(popup).toHaveURL(/#\/login/, { timeout: 1000 });
    }).toPass();
    await popup.getByRole("button", { name: "My own server" }).click();
    await popup.getByRole("textbox", { name: "Server address" }).fill(vault);
    await popup.getByLabel(/Email address/).fill(user.email);
    await popup.getByRole("button", { name: "Continue" }).click();
    await popup.getByRole("textbox", { name: /Master password/ }).fill(user.password);
    await popup.getByRole("button", { name: "Log in", exact: true }).click();

    // The extension opens the vault's security key page in a tab, never a frame.
    const opened = context.waitForEvent("page", (p) => p.url().includes("webauthn-fallback-connector.html"));
    await popup.getByRole("button", { name: "Open in new tab" }).click();
    const tab = await opened;
    const key = await securityKey(context, tab, credential);
    await tab.bringToFront();
    // The answer goes to the extension, which finishes signing in in a
    // window of its own; the popup then shows the account's vault.
    const popout = context.waitForEvent("page", (p) => p.url().includes("webAuthnResponse="));
    await tab.getByRole("button", { name: "Read security key" }).click();
    await expect(tab.getByText("WebAuthn verified successfully!")).toBeVisible();
    await popout;
    await expect(popup).toHaveURL(/#\/tabs\/vault/, { timeout: 30_000 });
    await expect(popup.getByText(user.email)).toBeVisible();
    expect((await key.credential()).signCount).toBeGreaterThan(credential.signCount);
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
