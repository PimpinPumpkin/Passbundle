// Two-step login for admins, in the web vault (DESIGN.md, "Two-step login for
// admins"): an admin of a Business organization who hasn't set up two-step
// login accepts the role (this test server sends no email, so the invitation
// joined them without asking), which signs them out; they sign in, are taken
// to "Set up two-step login to continue", set up an authenticator app, save
// the recovery code, and sign in with it to their vault. The organization's
// Settings page lists who isn't set up, and turning it off asks first. The
// API test covers the rest.
import { expect, test, type Page } from "@playwright/test";

import { totp } from "./api/support";
import { giveAuthenticator } from "./support/two-step";
import { confirmMember, signUp, webUserFor, type WebUser } from "./support/web";

async function enterPassword(page: Page, user: WebUser) {
  await page.goto("/#/login");
  await page.getByLabel(/Email address/).fill(user.email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("textbox", { name: /Master password/ }).fill(user.password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
}

test("an admin without two-step login is taken to set it up, then signs in with it", async ({
  browser,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const adminUser = webUserFor("setup-admin", testInfo.repeatEachIndex);
  const signUpContext = await browser.newContext();
  await signUp(await signUpContext.newPage(), adminUser);
  await signUpContext.close();

  // An owner who uses an authenticator app makes a business organization,
  // which requires two-step login for its admins, and makes them an admin.
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const ownerUser = webUserFor("setup-owner", testInfo.repeatEachIndex);
  await signUp(owner, ownerUser);
  await giveAuthenticator(request, ownerUser);
  await owner.goto("/#/create-organization");
  await owner.getByRole("textbox", { name: /Organization name/ }).fill("Acme Dental");
  await owner.getByRole("radio", { name: /A business/ }).check();
  await owner.getByRole("button", { name: "Create organization" }).click();
  await owner.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  const org = owner.url().replace(/\/members.*$/, "");
  await owner.getByRole("button", { name: "Invite member" }).click();
  const invite = owner.getByRole("dialog", { name: /Invite member/ });
  await invite.getByRole("textbox", { name: /Email/ }).fill(adminUser.email);
  await invite.getByRole("radio", { name: /^Admin/ }).check();
  await invite.getByRole("button", { name: "Save" }).click();
  await expect(invite).toBeHidden();
  await confirmMember(owner, adminUser.email);

  // This test server sends no email, so the invitation joined them without
  // asking: the rule leaves them alone until they accept the role. They sign
  // in to their vault, which asks them to.
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await enterPassword(admin, adminUser);
  await admin.waitForURL(/#\/vault/);
  const acceptRole = admin.getByTestId("accept-role");
  await expect(acceptRole).toContainText("Acme Dental made you an admin");
  await acceptRole.getByRole("button", { name: "Accept the role" }).click();
  // Without two-step login, accepting signs them out.
  await admin.waitForURL(/#\/login/);

  // The Settings page says it's on and who hasn't set it up.
  await owner.goto(`${org}/settings/account`);
  const card = owner.getByTestId("admin-two-step");
  await expect(card.getByRole("checkbox", { name: "Require two-step login for admins" })).toBeChecked();
  await expect(card.getByTestId("admin-two-step-not-set-up")).toContainText(adminUser.email);
  await expect(card.getByTestId("admin-two-step-not-set-up")).not.toContainText(ownerUser.email);
  await expect(card.getByTestId("admin-two-step-you")).toHaveCount(0);

  // The admin signs in again: their password checks out, and they're taken to
  // set up two-step login before anything else.
  await enterPassword(admin, adminUser);
  await admin.waitForURL(/#\/two-step-setup/);
  await expect(admin.getByTestId("two-step-setup-why")).toContainText(
    "Two-step login is required for your role by Acme Dental",
  );
  // The password they just typed is enough: it isn't asked again.
  await expect(admin.getByTestId("two-step-setup-password")).toHaveCount(0);
  await admin.getByTestId("two-step-setup-authenticator").click();
  const key = (await admin.getByTestId("two-step-setup-key").innerText()).trim();
  expect(key).toMatch(/^[A-Z2-7]{32}$/);
  await admin.getByTestId("two-step-setup-code").fill(totp(key));
  await admin.getByRole("button", { name: "Turn on" }).click();
  await expect(admin.getByTestId("two-step-setup-done")).toBeVisible();
  await expect(admin.getByTestId("two-step-setup-recovery")).toHaveText(/^\s*[A-Z2-7]{32}\s*$/);

  // Then they sign in as usual, with their authenticator, to their vault.
  // The sign-in page already has their email.
  await admin.getByTestId("two-step-setup-continue").click();
  await admin.waitForURL(/#\/login/);
  await expect(admin.getByLabel(/Email address/)).toHaveValue(adminUser.email);
  await admin.getByRole("button", { name: "Continue" }).click();
  await admin.getByRole("textbox", { name: /Master password/ }).fill(adminUser.password);
  await admin.getByRole("button", { name: "Log in", exact: true }).click();
  await admin.waitForURL(/#\/2fa/);
  await admin.getByRole("textbox", { name: /Verification code/ }).fill(totp(key, Date.now() + 30_000));
  await admin.getByRole("button", { name: "Continue" }).click();
  await admin.waitForURL(/#\/vault/);
  await expect(admin).toHaveTitle(/^Items/);

  // They're off the list; turning it off asks first, and then it's off.
  // (Reloading would lock the vault: move away and back instead.)
  await owner.goto(`${org}/members`);
  await owner.goto(`${org}/settings/account`);
  await expect(card.getByTestId("admin-two-step-not-set-up")).not.toContainText(adminUser.email);
  await card.getByRole("checkbox", { name: "Require two-step login for admins" }).uncheck();
  await card.getByRole("button", { name: "Save" }).click();
  const confirm = owner.getByRole("dialog", { name: /Turn off two-step login for admins/ });
  await confirm.getByRole("button", { name: "Turn it off" }).click();
  await expect(card.getByRole("checkbox", { name: "Require two-step login for admins" })).not.toBeChecked();

  await adminContext.close();
  await ownerContext.close();
});
