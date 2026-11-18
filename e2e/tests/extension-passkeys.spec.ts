// Passkeys in the browser extension (DESIGN.md, "Passkeys"): a site makes one
// through the extension, saved as a new login, and signs in with it; then a
// new browser, signed in to the same account, gets it from the server and
// signs in with it too. The site (fixtures/autofill/passkeys.html) checks
// each answer as a site would: its challenge, its own origin, its ID, and
// the signature with the passkey's public key.
//
// Where an organization's "Remove individual vault" binds a member, a passkey
// that counts its sign-ins in one of their own logins is refused before it
// signs, since the server won't take its raised counter (DESIGN.md,
// "Passkeys"; docs/core.md, "Passkeys", "A counter that can't be saved").
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";

import crypto from "node:crypto";
import fs from "node:fs";

import {
  answerAndClose,
  createAccount,
  expect,
  extensionIdOf,
  launchWithExtension,
  logInPopup,
  openPopup,
  test,
  userFor,
} from "./support/extension";
import {
  encrypt,
  realAccount,
  realCollection,
  realMember,
  realOrganization,
  type RealAccount,
} from "./support/vault-crypto";

const rpId = "passkeys.example.test";
const site = `https://${rpId}/passkeys.html`;

/** Signs in on the site with the account's passkey, picked in the extension's window. */
async function signIn(context: BrowserContext, page: Page) {
  const choosing = context.waitForEvent("page");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  const choose = await choosing;
  await expect(choose.getByRole("heading", { name: "Sign in with a passkey?" })).toBeVisible();
  await answerAndClose(choose, choose.getByRole("button", { name: /Passkeys Example/ }));
  await expect(page.getByRole("status")).toHaveText("Signed in with a passkey, signature checked");
}

test("a site makes a passkey through the extension and signs in with it, here and in another browser after a sync", async ({
  context,
  extensionId,
}, testInfo) => {
  test.setTimeout(180_000);
  const user = userFor("passkeys", testInfo.repeatEachIndex);
  await createAccount(context, user);
  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, user);

  // Making one: the extension asks where to save it.
  const page = await context.newPage();
  await page.goto(site);
  const saving = context.waitForEvent("page");
  await page.getByRole("button", { name: "Make a passkey" }).click();
  const save = await saving;
  await expect(save.getByRole("heading", { name: "Save passkey" })).toBeVisible();
  await answerAndClose(save, save.getByRole("button", { name: "Save passkey as new login" }));
  await expect(page.getByRole("status")).toHaveText("Made a passkey");
  const publicKey = await page.evaluate(() => (window as unknown as { passkeyPublicKey: string }).passkeyPublicKey);

  await signIn(context, page);

  // The login it went in, in the vault.
  await popup.reload();
  await expect(popup.getByText("Passkeys Example").first()).toBeVisible();

  // Another browser, signed in to the same account, gets it from the server.
  const other = await launchWithExtension();
  try {
    const otherPopup = await openPopup(other.context, await extensionIdOf(other.context));
    await logInPopup(otherPopup, user);
    const otherPage = await other.context.newPage();
    await otherPage.goto(site);
    // The site's server knows the passkey's public key from when it was made.
    await otherPage.evaluate(
      (key) => (window as unknown as { usePublicKey: (k: string) => Promise<void> }).usePublicKey(key),
      publicKey,
    );
    await signIn(other.context, otherPage);
  } finally {
    await other.context.close();
    fs.rmSync(other.profile, { recursive: true, force: true });
  }
});

/** What the extension says, in the apps' words, when it refuses a counting passkey in a login kept out of Personal. */
const keptOut =
  "Your organization keeps items out of Personal, so this login can't be changed. Its passkey counts its sign-ins, and signing in would change the login. You can move it to a shared folder in the web vault, then try again.";

const auth = (account: RealAccount) => ({ Authorization: `Bearer ${account.token}` });

/** A passkey's key pair: the private key as the vault keeps it, the public key as the site's server would. */
function passkeyKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  return { publicKey: publicKey.toString("base64"), keyValue: privateKey.toString("base64url") };
}

/**
 * A login of the account's own with a passkey for the site, encrypted with
 * its own key, as an import from another authenticator leaves one: its
 * counter is whatever that authenticator had counted.
 */
async function ownPasskeyLogin(
  request: APIRequestContext,
  account: RealAccount,
  name: string,
  counter: number,
  keyValue: string,
): Promise<string> {
  const e = (value: string) => encrypt(account.userKey, value);
  const created = await request.post("/api/ciphers", {
    headers: auth(account),
    data: {
      type: 1,
      organizationId: null,
      encryptedFor: account.userId,
      name: e(name),
      notes: null,
      favorite: false,
      reprompt: 0,
      fields: [],
      login: {
        username: e("ana@passkeys.example.test"),
        password: null,
        totp: null,
        uris: [{ uri: e(site), match: null }],
        fido2Credentials: [
          {
            credentialId: e(crypto.randomUUID()),
            keyType: e("public-key"),
            keyAlgorithm: e("ECDSA"),
            keyCurve: e("P-256"),
            keyValue: e(keyValue),
            rpId: e(rpId),
            userHandle: e(Buffer.from("user-1").toString("base64url")),
            userName: e("ana@passkeys.example.test"),
            counter: e(String(counter)),
            rpName: e("Passkeys Example"),
            userDisplayName: e("Ana"),
            discoverable: e("true"),
            creationDate: new Date().toISOString(),
          },
        ],
      },
    },
  });
  expect(created.status(), await created.text()).toBe(200);
  return (await created.json()).id;
}

/** When the server last saved an item. */
async function savedAt(request: APIRequestContext, account: RealAccount, id: string): Promise<string> {
  const got = await request.get(`/api/ciphers/${id}`, { headers: auth(account) });
  expect(got.status(), await got.text()).toBe(200);
  return (await got.json()).revisionDate;
}

/** Hands the site the public key its server would have kept for this passkey. */
async function siteKnows(page: Page, publicKey: string) {
  await page.evaluate(
    (key) => (window as unknown as { usePublicKey: (k: string) => Promise<void> }).usePublicKey(key),
    publicKey,
  );
}

/** Starts a sign-in on the site: the extension's window, to pick a login in. */
async function chooser(context: BrowserContext, page: Page): Promise<Page> {
  const choosing = context.waitForEvent("page");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  const choose = await choosing;
  await expect(choose.getByRole("heading", { name: "Sign in with a passkey?" })).toBeVisible();
  return choose;
}

/** A login in the extension's window, by its name. */
const row = (choose: Page, login: string) => choose.getByRole("button", { name: new RegExp(login) });

test("a passkey that counts its sign-ins, in a member's own login where the organization keeps items out of Personal, is refused before it signs, and says why", async ({
  context,
  extensionId,
  request,
}) => {
  test.setTimeout(240_000);
  const owner = await realAccount(request, "passkeys-kept-out-owner");
  const member = await realAccount(request, "passkeys-kept-out-member");
  // Passkeys for the site in their own logins, from before the organization
  // kept items out of Personal: imported from an authenticator that counts
  // its sign-ins, and one at 0, as every passkey PassBundle makes.
  const counting = passkeyKeys();
  const atZero = passkeyKeys();
  const ownersKey = passkeyKeys();
  const imported = await ownPasskeyLogin(request, member, "Imported passkey", 7, counting.keyValue);
  await ownPasskeyLogin(request, member, "Passkey made here", 0, atZero.keyValue);
  const ownersLogin = await ownPasskeyLogin(request, owner, "Owner's imported passkey", 7, ownersKey.keyValue);

  // "Remove individual vault" (policy 5), then the member joins.
  const org = await realOrganization(request, owner, "Harbor Clinic");
  const frontDesk = await realCollection(request, owner, org, "Front desk");
  const policy = await request.put(`/api/organizations/${org.id}/policies/5`, {
    headers: auth(owner),
    data: { policy: { enabled: true, data: null } },
  });
  expect(policy.status(), await policy.text()).toBe(200);
  await realMember(request, owner, org, member, [
    { id: frontDesk, readOnly: false, hidePasswords: false, manage: false },
  ]);
  const importedSaved = await savedAt(request, member, imported);

  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, { email: member.email, name: "member", password: member.password });
  const page = await context.newPage();
  await page.goto(site);

  // A passkey at 0 has nothing to save, and signs in as ever.
  await siteKnows(page, atZero.publicKey);
  const first = await chooser(context, page);
  await answerAndClose(first, row(first, "Passkey made here"));
  await expect(page.getByRole("status")).toHaveText("Signed in with a passkey, signature checked");

  // The counting one: the window says why, in the apps' words.
  await siteKnows(page, counting.publicKey);
  const refused = await chooser(context, page);
  await row(refused, "Imported passkey").click();
  await expect(refused.getByText(keptOut, { exact: true })).toBeVisible();
  await answerAndClose(refused, refused.getByRole("button", { name: "Close", exact: true }));
  // The site hears only that nothing was signed, as when someone closes the
  // window without picking, never the words.
  await expect(page.getByRole("status")).toHaveText(
    /^Signing in failed: \S+ The operation either timed out or was not allowed\.$/,
  );
  // Its counter wasn't raised and saved: the login is as it was.
  expect(await savedAt(request, member, imported)).toBe(importedSaved);

  // The organization's owner isn't bound: their own counting passkey signs
  // in, and its raised counter is saved.
  const ownersSaved = await savedAt(request, owner, ownersLogin);
  const other = await launchWithExtension();
  try {
    const otherPopup = await openPopup(other.context, await extensionIdOf(other.context));
    await logInPopup(otherPopup, { email: owner.email, name: "owner", password: owner.password });
    const otherPage = await other.context.newPage();
    await otherPage.goto(site);
    await siteKnows(otherPage, ownersKey.publicKey);
    const choose = await chooser(other.context, otherPage);
    await answerAndClose(choose, row(choose, "Owner's imported passkey"));
    await expect(otherPage.getByRole("status")).toHaveText("Signed in with a passkey, signature checked");
    await expect.poll(() => savedAt(request, owner, ownersLogin)).not.toBe(ownersSaved);
  } finally {
    await other.context.close();
    fs.rmSync(other.profile, { recursive: true, force: true });
  }
});
