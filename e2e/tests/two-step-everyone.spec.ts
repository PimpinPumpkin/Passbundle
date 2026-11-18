// Two-step login for everyone, in the web vault and the extension (DESIGN.md,
// "Two-step login for everyone"): Joining and security requires it of every
// member, asking first; a member without it accepts their place on their
// vault page (this test server sends no email, so the invitation joined them
// without asking) and is taken to set it up at their next sign-in; the card
// lists them; going back to admins asks first. Someone
// with no two-step login whom no rule covers gets a nudge on the vault page,
// in the web vault and the extension's popup, and Not now hides it on every
// device. On the server that sends email, someone whose only second step is
// email codes gets the nudge to a stronger method instead. The API tests
// cover the rest.
import { expect, type Page, request as requests, type Response, test } from "@playwright/test";

import { mailServerPort } from "../paths.mjs";

import {
  createAccount,
  test as extensionTest,
  logInPopup,
  openPopup,
  userFor,
} from "./support/extension";
import { giveAuthenticator, giveEmailCodes } from "./support/two-step";
import {
  chooseRole,
  confirmWithPassword,
  reloadVault,
  signUp,
  webUserFor,
  type WebUser,
} from "./support/web";

async function enterPassword(page: Page, user: WebUser) {
  await page.goto("/#/login");
  await page.getByLabel(/Email address/).fill(user.email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("textbox", { name: /Master password/ }).fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/** The vault page asking the server whether to nudge, as it opens. */
const nudgeAnswer = (page: Page) =>
  page.waitForResponse(
    (r: Response) => r.url().includes("/api/keykeeper/two-step-nudge") && r.request().method() === "GET",
  );

/** Reloads the vault, and says whether the server told it to nudge. */
async function reloadAndAsk(page: Page): Promise<boolean> {
  const answer = nudgeAnswer(page);
  await reloadVault(page);
  return (await (await answer).json()).show;
}

/** Reloads the vault, and says which nudge the server named, if any. */
async function reloadAndAskWhich(page: Page): Promise<string | null> {
  const answer = nudgeAnswer(page);
  await reloadVault(page);
  return (await (await answer).json()).nudge;
}

/** The server that sends email, where an account can turn on email codes. */
const mailServer = `https://127.0.0.1:${mailServerPort}`;

/** Requests to the server that sends email, for the test to dispose of. */
const mailServerRequests = () =>
  requests.newContext({ baseURL: mailServer, ignoreHTTPSErrors: true });

const strongerText =
  "Codes by email are only as safe as your email account. An authenticator app or a security key is safer.";

test("Joining and security requires two-step login of everyone, and the vault nudges someone without it until Not now", async ({
  browser,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  // Someone with no two-step login, whom no rule covers: the vault nudges
  // them, and Not now hides it, there and when the vault opens again.
  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  const memberUser = webUserFor("everyone-member", testInfo.repeatEachIndex);
  await signUp(member, memberUser);
  // A one-line banner on the vault page.
  const nudge = member.getByTestId("two-step-nudge");
  await expect(nudge).toContainText("Your password is all that protects your account.");
  await expect(nudge.getByRole("link", { name: "Set it up" })).toHaveAttribute(
    "href",
    /#\/settings\/security\/two-factor$/,
  );
  await nudge.getByRole("button", { name: "Not now" }).click();
  await expect(nudge).toHaveCount(0);
  expect(await reloadAndAsk(member)).toBe(false);
  await expect(nudge).toHaveCount(0);

  // An owner with an authenticator app isn't nudged. They make a group, and
  // invite the member.
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const ownerUser = webUserFor("everyone-owner", testInfo.repeatEachIndex);
  await signUp(owner, ownerUser);
  await giveAuthenticator(request, ownerUser);
  expect(await reloadAndAsk(owner)).toBe(false);
  await expect(owner.getByTestId("two-step-nudge")).toHaveCount(0);
  await owner.goto("/#/create-organization");
  await owner.getByRole("textbox", { name: /Organization name/ }).fill("Bright Smiles");
  await owner.getByRole("radio", { name: /A family or a group/ }).check();
  await owner.getByRole("button", { name: "Create organization" }).click();
  await owner.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  const org = owner.url().replace(/\/members.*$/, "");
  await owner.getByRole("button", { name: "Invite member" }).click();
  const invite = owner.getByRole("dialog", { name: /Invite member/ });
  await invite.getByRole("textbox", { name: /Email/ }).fill(memberUser.email);
  await chooseRole(invite, "User");
  await invite.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(invite).toBeHidden();

  // Joining and security: everyone else needs the admins first, and the card
  // says how upstream's policy differs. The member hasn't accepted their
  // place themselves, so the rule doesn't count them yet.
  await owner.goto(`${org}/settings/joining`);
  const card = owner.getByTestId("admin-two-step");
  const admins = card.getByRole("checkbox", { name: "Require two-step login for admins" });
  const everyone = card.getByRole("checkbox", { name: "Everyone else too" });
  const members = card.getByTestId("admin-two-step-members-not-set-up");
  await expect(admins).not.toBeChecked();
  await expect(everyone).toBeDisabled();
  await expect(members).toContainText("Every other member has set it up.");
  await expect(card.getByTestId("admin-two-step-upstream")).toContainText(
    "Require two-step login is a separate policy: it counts email codes",
  );
  await admins.check();
  await everyone.check();
  await card.getByRole("button", { name: "Save" }).click();
  const ask = owner.getByRole("dialog", { name: /Require two-step login of everyone/ });
  await expect(ask).toContainText("Every member must use an authenticator app, a security key or passkey, or Duo.");
  await ask.getByRole("button", { name: "Require it" }).click();
  // Then the master password (DESIGN.md, "Confirming sensitive changes").
  await confirmWithPassword(owner, ownerUser.password);
  await expect(everyone).toBeChecked();
  await expect(admins).toBeChecked();

  // The member's vault asks them to accept their place. Accepting takes it
  // on, and the rule with it: without two-step login, they're signed out,
  // and their next sign-in sets it up first.
  await reloadVault(member);
  const role = member.getByTestId("accept-role");
  await expect(role).toContainText("Bright Smiles made you a member");
  await role.getByRole("button", { name: "Accept the role" }).click();
  await member.waitForURL(/#\/login/, { timeout: 30_000 });
  // The sign-in page, once signing out is done.
  await expect(member.getByLabel(/Email address/)).toBeVisible({ timeout: 30_000 });
  await enterPassword(member, memberUser);
  await member.waitForURL(/#\/two-step-setup/);
  await expect(member.getByTestId("two-step-setup-why")).toContainText(
    "Two-step login is required for your role by Bright Smiles",
  );

  // The owner's card lists them now. (Reloading would lock the vault: move
  // away and back instead.)
  await owner.goto(`${org}/members`);
  await owner.goto(`${org}/settings/joining`);
  await expect(members).toContainText(memberUser.email);

  // Back to admins only asks first.
  await everyone.uncheck();
  await card.getByRole("button", { name: "Save" }).click();
  const stop = owner.getByRole("dialog", { name: /Stop requiring two-step login of everyone/ });
  await stop.getByRole("button", { name: "Stop requiring it" }).click();
  await confirmWithPassword(owner, ownerUser.password);
  await expect(everyone).not.toBeChecked();
  await expect(admins).toBeChecked();

  await memberContext.close();
  await ownerContext.close();
});

extensionTest("the extension's popup nudges too: Set it up opens the web vault's two-step settings, and Not now there hides it in the web vault", async ({
  context,
  extensionId,
}, testInfo) => {
  test.setTimeout(150_000);
  const user = userFor("ext-nudge", testInfo.repeatEachIndex);
  const web = await createAccount(context, user);
  await expect(web.getByTestId("two-step-nudge")).toBeVisible();

  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, user);
  const nudge = popup.getByTestId("two-step-nudge");
  await expect(nudge).toContainText("Add two-step login");
  const settings = context.waitForEvent("page");
  await nudge.getByRole("button", { name: "Set it up" }).click();
  await expect(await settings).toHaveURL(/#\/settings\/security\/two-factor$/);
  await nudge.getByRole("button", { name: "Not now" }).click();
  await expect(nudge).toHaveCount(0);

  // The server keeps Not now for the account, so the web vault doesn't nudge
  // either.
  expect(await reloadAndAsk(web)).toBe(false);
  await expect(web.getByTestId("two-step-nudge")).toHaveCount(0);
});

test("someone whose only second step is email codes gets the nudge to a stronger method, with Set it up and Not now", async ({
  browser,
}, testInfo) => {
  test.setTimeout(150_000);
  const context = await browser.newContext({ baseURL: mailServer, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const user = webUserFor("email-nudge", testInfo.repeatEachIndex);
  await signUp(page, user);
  const nudge = page.getByTestId("two-step-nudge");
  await expect(nudge).toContainText("Your password is all that protects your account.");

  // Email codes on: the second nudge, in place of the first.
  const api = await mailServerRequests();
  await giveEmailCodes(api, user);
  expect(await reloadAndAskWhich(page)).toBe("stronger");
  await expect(nudge).toContainText(strongerText);
  await expect(nudge).not.toContainText("Your password is all that protects your account.");
  await expect(nudge).toHaveAttribute("data-nudge", "stronger");
  await expect(nudge.getByRole("link", { name: "Set it up" })).toHaveAttribute(
    "href",
    /#\/settings\/security\/two-factor$/,
  );
  await nudge.getByRole("button", { name: "Not now" }).click();
  await expect(nudge).toHaveCount(0);
  expect(await reloadAndAskWhich(page)).toBeNull();
  await expect(nudge).toHaveCount(0);

  await api.dispose();
  await context.close();
});

extensionTest("the extension's popup nudges someone with email codes alone to a stronger method, and Not now there hides it in the web vault", async ({
  context,
  extensionId,
}, testInfo) => {
  test.setTimeout(150_000);
  const user = userFor("ext-email-nudge", testInfo.repeatEachIndex);
  const web = await createAccount(context, user, mailServer);
  await expect(web.getByTestId("two-step-nudge")).toBeVisible();
  // Signed in before email codes go on, so the popup needs no code.
  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, user, mailServer);
  const nudge = popup.getByTestId("two-step-nudge");
  await expect(nudge).toContainText("Add two-step login");

  const api = await mailServerRequests();
  await giveEmailCodes(api, user);
  await popup.reload();
  await expect(nudge).toContainText("Add a stronger second step", { timeout: 30_000 });
  await expect(nudge).toContainText(strongerText);
  const settings = context.waitForEvent("page");
  await nudge.getByRole("button", { name: "Set it up" }).click();
  await expect(await settings).toHaveURL(/#\/settings\/security\/two-factor$/);
  await nudge.getByRole("button", { name: "Not now" }).click();
  await expect(nudge).toHaveCount(0);

  // The server keeps Not now for the account, so the web vault doesn't nudge
  // either.
  expect(await reloadAndAskWhich(web)).toBeNull();
  await expect(web.getByTestId("two-step-nudge")).toHaveCount(0);
  await api.dispose();
});
