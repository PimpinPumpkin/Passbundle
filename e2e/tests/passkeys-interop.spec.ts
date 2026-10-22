// Passkeys made by the browser extension and by our own apps' core work in
// each other (docs/core.md, "Passkeys"): the core signs in with a passkey the
// extension made, with a signature the passkey's public key verifies, and
// the extension signs in on the site with one the core made. The core goes
// through the app's own calls (the interop tool tier 1 builds from the
// linked passbundle-apps branch, KK_CORE_INTEROP); the site
// (fixtures/autofill/passkeys.html) checks the extension's answers as a site
// would, and this test checks the core's the same way.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { core, coreTool, serverCertificate } from "./support/core";
import {
  answerAndClose,
  createAccount,
  expect,
  logInPopup,
  openPopup,
  test,
  userFor,
} from "./support/extension";

test.skip(!coreTool && !process.env.CI, "KK_CORE_INTEROP isn't set; tier 1 builds the core's interop tool");

const rpId = "passkeys.example.test";
const site = `https://${rpId}/passkeys.html`;
// The account's ID on the site, as the site's page gives it.
const userHandle = Buffer.from("user-1");

const sha256 = (data: Buffer | string) => crypto.createHash("sha256").update(data).digest();

test("the core signs in with a passkey the extension made", async ({ context, extensionId }, testInfo) => {
  test.setTimeout(180_000);
  const user = userFor("passkeys-core", testInfo.repeatEachIndex);
  await createAccount(context, user);
  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, user);

  const page = await context.newPage();
  await page.goto(site);
  const saving = context.waitForEvent("page");
  await page.getByRole("button", { name: "Make a passkey" }).click();
  const save = await saving;
  await answerAndClose(save, save.getByRole("button", { name: "Save passkey as new login" }));
  await expect(page.getByRole("status")).toHaveText("Made a passkey");
  const publicKey = Buffer.from(
    await page.evaluate(() => (window as unknown as { passkeyPublicKey: string }).passkeyPublicKey),
    "base64",
  );

  // What a browser would hand an authenticator: the hash of its client data.
  const clientData = JSON.stringify({
    type: "webauthn.get",
    challenge: crypto.randomBytes(32).toString("base64url"),
    origin: `https://${rpId}`,
    crossOrigin: false,
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-passkeys-"));
  const cert = await serverCertificate(dir);
  const read = core(dir, cert, user, {
    action: "signWithPasskey",
    rpId,
    clientDataHash: sha256(clientData).toString("base64url"),
  });

  // The core reads the extension's passkey as the extension wrote it.
  const item = read.items.find((i) => i.passkey);
  expect(item?.passkey).toMatchObject({ rpId, userName: "ana@passkeys.example.test", discoverable: true, usable: true });
  // And signs as a site checks: its ID, someone present, the account, and
  // the signature with the public key the site kept when it was made.
  const signed = read.passkey!;
  const data = Buffer.from(signed.authenticatorData, "base64url");
  expect(data.subarray(0, 32).equals(sha256(rpId))).toBe(true);
  expect(data[32] & 0x01).toBe(0x01);
  expect(signed.credentialId).toBe(item!.passkey!.credentialId);
  expect(Buffer.from(signed.userHandle, "base64url").equals(userHandle)).toBe(true);
  const key = crypto.createPublicKey({ key: publicKey, format: "der", type: "spki" });
  const verified = crypto.verify(
    "sha256",
    Buffer.concat([data, sha256(clientData)]),
    key,
    Buffer.from(signed.signature, "base64url"),
  );
  expect(verified).toBe(true);
});

test("the extension signs in with a passkey the core made", async ({ context, extensionId }, testInfo) => {
  test.setTimeout(180_000);
  const user = userFor("passkeys-ext", testInfo.repeatEachIndex);
  await createAccount(context, user);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-passkeys-"));
  const cert = await serverCertificate(dir);
  const made = core(dir, cert, user, {
    action: "makePasskey",
    rpId,
    rpName: "Passkeys Example",
    userName: "ana@passkeys.example.test",
    userHandle: userHandle.toString("base64url"),
  }).passkey!;

  // The extension gets it from the server when it signs in.
  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, user);
  const page = await context.newPage();
  await page.goto(site);
  // The site's server knows the passkey's public key from when it was made.
  await page.evaluate(
    (key) => (window as unknown as { usePublicKey: (k: string) => Promise<void> }).usePublicKey(key),
    Buffer.from(made.publicKey, "base64url").toString("base64"),
  );
  const choosing = context.waitForEvent("page");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  const choose = await choosing;
  await expect(choose.getByRole("heading", { name: "Log in with passkey?" })).toBeVisible();
  // The core names a new login after the site's ID.
  await answerAndClose(choose, choose.getByRole("button", { name: new RegExp(rpId.replace(/\./g, "\\.")) }));
  await expect(page.getByRole("status")).toHaveText("Signed in with a passkey, signature checked");
});
