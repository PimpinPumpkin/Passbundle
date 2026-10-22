// Passkeys in the browser extension (DESIGN.md, "Passkeys"): a site makes one
// through the extension, saved as a new login, and signs in with it; then a
// new browser, signed in to the same account, gets it from the server and
// signs in with it too. The site (fixtures/autofill/passkeys.html) checks
// each answer as a site would: its challenge, its own origin, its ID, and
// the signature with the passkey's public key.
import type { BrowserContext, Page } from "@playwright/test";

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

const site = "https://passkeys.example.test/passkeys.html";

/** Signs in on the site with the account's passkey, picked in the extension's window. */
async function signIn(context: BrowserContext, page: Page) {
  const choosing = context.waitForEvent("page");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  const choose = await choosing;
  await expect(choose.getByRole("heading", { name: "Log in with passkey?" })).toBeVisible();
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
