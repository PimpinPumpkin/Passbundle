// Two-step login for everyone, in the web vault and the extension (DESIGN.md,
// "Two-step login for everyone"): Joining and security requires it of every
// member, listing who isn't set up first, and a member without it is taken to
// set it up at their next sign-in; going back to admins asks first. Someone
// with no two-step login whom no rule covers gets a nudge on the vault page,
// in the web vault and the extension's popup, and Not now hides it on every
// device. The API test covers the rest.
import { expect, type Page, type Response, test } from "@playwright/test";

import {
  createAccount,
  test as extensionTest,
  logInPopup,
  openPopup,
  userFor,
} from "./support/extension";
import { giveAuthenticator } from "./support/two-step";
import {
  chooseRole,
  confirmMember,
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
  const nudge = member.getByTestId("two-step-nudge");
  await expect(nudge).toContainText("Add two-step login");
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
  // let the member in.
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
  // This test server sends no email, so the invitation joined them at once.
  await owner.goto("/#/vault");
  await owner.goto(`${org}/members`);
  await confirmMember(owner, memberUser.email);

  // Joining and security: everyone else needs the admins first, and the card
  // lists who requiring it of everyone would sign out, and how upstream's
  // policy differs.
  await owner.goto(`${org}/settings/joining`);
  const card = owner.getByTestId("admin-two-step");
  const admins = card.getByRole("checkbox", { name: "Require two-step login for admins" });
  const everyone = card.getByRole("checkbox", { name: "Everyone else too" });
  await expect(admins).not.toBeChecked();
  await expect(everyone).toBeDisabled();
  await expect(card.getByTestId("admin-two-step-members-not-set-up")).toContainText(memberUser.email);
  await expect(card).toContainText("Requiring it of everyone would sign out 1 member until they set it up.");
  await expect(card.getByTestId("admin-two-step-upstream")).toContainText(
    "Require two-step login is a separate policy: it counts email codes",
  );
  await admins.check();
  await everyone.check();
  await card.getByRole("button", { name: "Save" }).click();
  const ask = owner.getByRole("dialog", { name: /Require two-step login of everyone/ });
  await expect(ask).toContainText("1 member without one is signed out now");
  await ask.getByRole("button", { name: "Require it" }).click();
  // Then the master password (DESIGN.md, "Confirming sensitive changes").
  await confirmWithPassword(owner, ownerUser.password);
  await expect(everyone).toBeChecked();
  await expect(admins).toBeChecked();
  await expect(card).not.toContainText("Requiring it of everyone would sign out");

  // The member is signed out, and their next sign-in sets it up first.
  // (The server's word can sign the page out before this navigation
  // finishes, which Playwright reports as interrupted: either way, it ends
  // at the sign-in page.)
  await member.goto("/#/settings/account").catch((e: unknown) => {
    if (!String(e).includes("interrupted by another navigation")) {
      throw e;
    }
  });
  await member.waitForURL(/#\/login/, { timeout: 30_000 });
  await enterPassword(member, memberUser);
  await member.waitForURL(/#\/two-step-setup/);
  await expect(member.getByTestId("two-step-setup-why")).toContainText(
    "Two-step login is required for your role by Bright Smiles",
  );

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
