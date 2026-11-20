// Tier 2: passkeys in the browser extension, in Google Chrome as a person has
// it, on a site whose checks we didn't write (DESIGN.md, "Passkeys"). Tier 1
// (tests/extension-passkeys.spec.ts) runs Playwright's Chromium against a
// page whose checks we wrote; here it's Chrome's stable channel with the
// extension loaded unpacked (chrome.ts), and Harbor Books
// (relying-party.mjs), whose server is SimpleWebAuthn's: its library makes
// every request, with its defaults or with residentKey and
// userVerification "required", and checks every answer, the signature and
// the counter included. The site is at https://www.harbor-books.test with
// the RP ID harbor-books.test, with a certificate from an authority this
// test makes, which only this test's Chrome trusts.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { convertCOSEtoPKCS } from "@simplewebauthn/server/helpers";

import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";

import { chromeSitePort } from "../paths.mjs";
import { answerAndClose, logInPopup, openPopup } from "../tests/support/extension";
import { type RealAccount, realAccount } from "../tests/support/vault-crypto";

import { type Chrome, chromeVersion, expect, serverKeyHash, test } from "./chrome";
import { makeCertificates, origin, rpID, rpName, siteHost, spkiHash, startRelyingParty } from "./relying-party.mjs";

// PassBundle's AAGUID (DESIGN.md, "Passkeys"), as the site's library names a passkey's maker.
const passBundleAAGUID = "09c5ee5f-0845-48e6-aef4-c7c443317de5";
// The site's own name for the person, apart from their PassBundle account.
const siteAccount = "ana@harbor-books.test";
// Chrome reaches the site by its name and the test server by its address;
// every other name fails to resolve. No live network.
const rules = `--host-resolver-rules=MAP ${siteHost} 127.0.0.1:${chromeSitePort}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`;

let site: Awaited<ReturnType<typeof startRelyingParty>>;
let certificates: string;
let trustedKeys: string[];

test.beforeAll(async () => {
  // Chrome's first start on a fresh runner (DESIGN.md, "Testing") is here,
  // with a limit of its own.
  test.setTimeout(120_000);
  const { product } = await chromeVersion();
  console.log(`Google Chrome, stable channel: ${product}`);
  certificates = fs.mkdtempSync(path.join(os.tmpdir(), "passbundle-harbor-books-"));
  const made = makeCertificates(certificates);
  site = await startRelyingParty({ port: chromeSitePort, chain: made.chain, key: made.key });
  // The site's authority and the test server's own certificate, and nothing else.
  trustedKeys = [spkiHash(made.ca), await serverKeyHash()];
});

// Each test gets a fresh database: the site's too.
test.beforeEach(() => site.accounts.clear());

test.afterAll(async () => {
  await site?.close();
  if (certificates) fs.rmSync(certificates, { recursive: true, force: true });
});

/** Chrome signed in to the account in the extension, with the site open: Chrome's own HTTPS checks pass, not ignored. */
async function chromeAt(
  launch: (rules: string, trustedKeys: string[]) => Promise<Chrome>,
  account: RealAccount,
  query: string,
): Promise<{ chrome: Chrome; page: Page }> {
  const chrome = await launch(rules, trustedKeys);
  const popup = await openPopup(chrome.context, chrome.extensionId);
  await logInPopup(popup, { email: account.email, name: "ana", password: account.password });
  // Chrome's popup closes once the person clicks on the page; here it's a
  // tab, so the test closes it.
  await popup.close();
  const page = await chrome.context.newPage();
  await page.goto(`${origin}/?${query}`);
  // A secure context, with a certificate Chrome trusts (not an error it was
  // told to ignore): what WebAuthn asks of a site's origin.
  expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
  const cdp = await chrome.context.newCDPSession(page);
  const security = new Promise<{ securityState: string }>((resolve) =>
    cdp.once("Security.visibleSecurityStateChanged", (event) => resolve(event.visibleSecurityState)),
  );
  await cdp.send("Security.enable");
  expect((await security).securityState).toBe("secure");
  await cdp.detach();
  return { chrome, page };
}

/** Opens the site at another address in the same tab. */
const visit = (page: Page, query: string) => page.goto(`${origin}/?${query}`);

/** "Add a passkey" on the site, saved as a new login in the extension's window. */
async function addPasskey(context: BrowserContext, page: Page) {
  const saving = context.waitForEvent("page");
  await page.getByRole("button", { name: "Add a passkey" }).click();
  const save = await saving;
  await expect(save.getByRole("heading", { name: "Save passkey" })).toBeVisible();
  await answerAndClose(save, save.getByRole("button", { name: "Save passkey as new login" }));
  await expect(page.getByRole("status")).toHaveText("Passkey added");
}

/** "Sign in with a passkey" on the site, with the login picked in the extension's window. */
async function signIn(context: BrowserContext, page: Page) {
  const choosing = context.waitForEvent("page");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  const choose = await choosing;
  await expect(choose.getByRole("heading", { name: "Sign in with a passkey?" })).toBeVisible();
  await answerAndClose(choose, choose.getByRole("button", { name: new RegExp(rpName) }));
  await expect(page.getByRole("status")).toHaveText(`Signed in as ${siteAccount}`);
}

/** The site library's last answer, as its server kept it (or its refusal, in its words). */
function lastVerification(kind: "registration" | "authentication") {
  const last = site.verifications.at(-1);
  expect(last?.kind, last?.error).toBe(kind);
  return last.verification;
}

/** A value the clients encrypted (type 2: AES-256-CBC, then HMAC-SHA256), decrypted after its MAC checks. */
function decrypt(key: Buffer, value: string): Buffer {
  expect(value.startsWith("2."), "type 2").toBe(true);
  const [iv, data, mac] = value
    .slice(2)
    .split("|")
    .map((part) => Buffer.from(part, "base64"));
  const check = crypto
    .createHmac("sha256", key.subarray(32))
    .update(Buffer.concat([iv, data]))
    .digest();
  expect(crypto.timingSafeEqual(check, mac), "MAC").toBe(true);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key.subarray(0, 32), iv);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/** The account's logins with passkeys, as the server holds them, decrypted with the account's key. */
async function passkeyLogins(request: APIRequestContext, account: RealAccount) {
  const sync = await request.get("/api/sync?excludeDomains=true", {
    headers: { Authorization: `Bearer ${account.token}` },
  });
  expect(sync.status(), await sync.text()).toBe(200);
  const ciphers: any[] = (await sync.json()).ciphers;
  return ciphers
    .filter((c) => !c.deletedDate && c.login?.fido2Credentials?.length)
    .map((c) => {
      // An item's own key, where it has one, wrapped by the account's.
      const key = c.key ? decrypt(account.userKey, c.key) : account.userKey;
      const text = (value: string | null) => (value == null ? null : decrypt(key, value).toString("utf8"));
      return {
        name: text(c.name),
        username: text(c.login.username),
        uris: (c.login.uris ?? []).map((u: { uri: string }) => text(u.uri)),
        passkeys: c.login.fido2Credentials.map((f: Record<string, string>) => ({
          credentialId: text(f.credentialId)!,
          rpId: text(f.rpId),
          rpName: text(f.rpName),
          userName: text(f.userName),
          userHandle: text(f.userHandle),
          counter: text(f.counter),
          discoverable: text(f.discoverable),
          keyValue: text(f.keyValue)!,
        })),
      };
    });
}

/** A passkey's credential ID in the vault (a GUID, or "b64." and base64url), as the site has it: base64url. */
const credentialIdOf = (id: string) =>
  (id.startsWith("b64.") ? Buffer.from(id.slice(4), "base64url") : Buffer.from(id.replace(/-/g, ""), "hex")).toString(
    "base64url",
  );

/** The public point of the vault's private key, as the site's library gives a COSE key's: 0x04, x, y. */
function publicPointOf(keyValue: string): Buffer {
  const privateKey = crypto.createPrivateKey({ key: Buffer.from(keyValue, "base64url"), format: "der", type: "pkcs8" });
  const jwk = crypto.createPublicKey(privateKey).export({ format: "jwk" });
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
}

/**
 * The vault holds one login with the passkey the site keeps: its credential
 * ID, the private key to the site's public key, the site's ID for the
 * person, and a counter at 0.
 */
async function expectVaultHasSitesPasskey(request: APIRequestContext, account: RealAccount) {
  const kept = site.accounts.get(siteAccount)!;
  expect(kept.credentials).toHaveLength(1);
  const [credential] = kept.credentials;
  const logins = await passkeyLogins(request, account);
  expect(logins).toHaveLength(1);
  const [login] = logins;
  expect(login.name).toBe(rpName);
  expect(login.username).toBe(siteAccount);
  expect(login.uris).toEqual([expect.stringMatching(new RegExp(`^${origin.replace(/\./g, "\\.")}/`))]);
  expect(login.passkeys).toHaveLength(1);
  const [passkey] = login.passkeys;
  expect(passkey).toMatchObject({ rpId: rpID, rpName, userName: siteAccount, counter: "0" });
  expect(passkey.userHandle).toBe(kept.webauthnUserID);
  expect(credentialIdOf(passkey.credentialId)).toBe(credential.id);
  expect(publicPointOf(passkey.keyValue).equals(Buffer.from(convertCOSEtoPKCS(credential.publicKey)))).toBe(true);
  return { passkey, credential };
}

test("a passkey made with the site library's defaults is verified, saved in a new login, and signs in, discoverable and named, here and in a second Chrome profile after a sync", async ({
  chrome: launch,
  request,
}) => {
  test.setTimeout(300_000);
  const account = await realAccount(request, "chrome-passkeys");
  const { chrome, page } = await chromeAt(launch, account, `account=${siteAccount}`);

  // The library's defaults: residentKey and userVerification "preferred",
  // its default algorithms offered, credProps asked. Its server verifies the
  // answer as it does by default: challenge, origin, RP ID, someone present
  // and verified, the attestation ("none"), and the key.
  await addPasskey(chrome.context, page);
  const made = lastVerification("registration");
  expect(made.verified).toBe(true);
  expect(made.registrationInfo).toMatchObject({
    fmt: "none",
    aaguid: passBundleAAGUID,
    origin,
    rpID,
    userVerified: true,
    credentialType: "public-key",
  });
  const { passkey } = await expectVaultHasSitesPasskey(request, account);
  // "preferred" is made discoverable.
  expect(passkey.discoverable).toBe("true");

  // Discoverable: no allowCredentials, so the passkey says whose it is.
  await signIn(chrome.context, page);
  const discoverable = lastVerification("authentication");
  expect(discoverable.verified).toBe(true);
  expect(discoverable.authenticationInfo).toMatchObject({ newCounter: 0, userVerified: true, origin, rpID });

  // Named: the site lists the account's passkeys (allowCredentials).
  await visit(page, `account=${siteAccount}&allow=1`);
  await signIn(chrome.context, page);
  expect(lastVerification("authentication").verified).toBe(true);

  // A second Chrome profile, signed in to the same account, gets it from
  // the server and signs in with it.
  const second = await chromeAt(launch, account, `account=${siteAccount}`);
  await signIn(second.chrome.context, second.page);
  const fromSecond = lastVerification("authentication");
  expect(fromSecond.verified).toBe(true);
  expect(fromSecond.authenticationInfo).toMatchObject({ newCounter: 0, origin, rpID });
  // It counts no sign-ins (always 0), which the library takes as an
  // authenticator without a counter; nothing in the vault changed.
  await expectVaultHasSitesPasskey(request, account);
});

test('a passkey made with residentKey and userVerification "required" is verified and signs in where the site requires user verification', async ({
  chrome: launch,
  request,
}) => {
  test.setTimeout(240_000);
  const account = await realAccount(request, "chrome-passkeys-required");
  const { chrome, page } = await chromeAt(launch, account, `account=${siteAccount}&ask=required`);

  await addPasskey(chrome.context, page);
  const made = lastVerification("registration");
  expect(made.verified).toBe(true);
  expect(made.registrationInfo).toMatchObject({ aaguid: passBundleAAGUID, userVerified: true });
  const { passkey } = await expectVaultHasSitesPasskey(request, account);
  expect(passkey.discoverable).toBe("true");

  await signIn(chrome.context, page);
  const signedIn = lastVerification("authentication");
  expect(signedIn.verified).toBe(true);
  expect(signedIn.authenticationInfo).toMatchObject({ newCounter: 0, userVerified: true });
});

test("a site that names a passkey PassBundle has (excludeCredentials) is told it's already registered, as WebAuthn says, and nothing new is saved", async ({
  chrome: launch,
  request,
}) => {
  test.setTimeout(240_000);
  const account = await realAccount(request, "chrome-passkeys-exclude");
  const { chrome, page } = await chromeAt(launch, account, `account=${siteAccount}`);
  await addPasskey(chrome.context, page);
  await expectVaultHasSitesPasskey(request, account);

  // The site asks for another, naming the one it has.
  await visit(page, `account=${siteAccount}&exclude=1`);
  const informing = chrome.context.waitForEvent("page");
  await page.getByRole("button", { name: "Add a passkey" }).click();
  const inform = await informing;
  await expect(inform.getByText("A passkey already exists for this application.")).toBeVisible();
  // Its own Close, not the window's: closing the window hands the request
  // to Chrome's own passkey prompt.
  const close = inform.getByRole("button", { name: "Close", exact: true });
  await expect(close).toBeVisible();
  await answerAndClose(inform, close);
  // WebAuthn's InvalidStateError, which the site's library reads as a
  // passkey it already has (its code), not as someone cancelling.
  await expect(page.getByRole("status")).toHaveText(
    "Couldn't add a passkey: InvalidStateError ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED The authenticator was previously registered",
  );
  // Nothing new on either side.
  await expectVaultHasSitesPasskey(request, account);
});

test("Chrome itself takes the site, its name, and its RP ID: with PassBundle signed out, Chrome's own authenticator makes a passkey there and signs in with it, verified by the library", async ({
  chrome: launch,
}) => {
  // A check of the site rather than of PassBundle: the extension, signed
  // out, hands the requests to Chrome, whose own WebAuthn checks the origin
  // and the RP ID, and answers with a virtual authenticator of its own.
  const chrome = await launch(rules, trustedKeys);
  const page = await chrome.context.newPage();
  await page.goto(`${origin}/?account=${siteAccount}`);
  const cdp = await chrome.context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByRole("status")).toHaveText("Passkey added");
  expect(lastVerification("registration").registrationInfo.aaguid).not.toBe(passBundleAAGUID);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByRole("status")).toHaveText(`Signed in as ${siteAccount}`);
  expect(lastVerification("authentication").verified).toBe(true);
});
