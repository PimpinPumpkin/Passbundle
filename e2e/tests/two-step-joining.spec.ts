// Joining an organization that requires two-step login, in the web vault
// (DESIGN.md, "Joining"): someone who joins without it sees on their vault
// page why they aren't in yet, with the way to turn it on, and the owner's
// Members page says who's waiting for it instead of only "Needs
// confirmation". The extension's vault says it too. The API test covers the
// rest.
import { expect, test } from "@playwright/test";

import { Api } from "./api/support";
import {
  createAccount,
  test as extensionTest,
  logInPopup,
  openPopup,
  userFor,
} from "./support/extension";
import { signUp, webUserFor } from "./support/web";

test("someone waiting to turn on two-step login is told so, and so is the owner", async ({
  browser,
}, testInfo) => {
  test.setTimeout(150_000);
  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  const memberUser = webUserFor("two-step-member", testInfo.repeatEachIndex);
  await signUp(member, memberUser);

  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  await signUp(owner, webUserFor("two-step-owner", testInfo.repeatEachIndex));
  await owner.goto("/#/create-organization");
  await owner.getByRole("textbox", { name: /Organization name/ }).fill("Strict Dental");
  await owner.getByRole("radio", { name: /A family or a group/ }).check();
  await owner.getByRole("button", { name: "Create organization" }).click();
  await owner.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  const org = owner.url().replace(/\/members.*$/, "");

  await owner.goto(`${org}/settings/policies`);
  await owner.getByRole("button", { name: /^Require two-step login .* Off$/ }).click();
  const policy = owner.getByRole("dialog", { name: /Require two-step login/ });
  await policy.getByRole("checkbox", { name: /Turn on/ }).check();
  await policy.getByRole("button", { name: "Save" }).click();
  await expect(owner.getByRole("button", { name: /^Require two-step login .* On$/ })).toBeVisible();

  await owner.goto(`${org}/members`);
  await owner.getByRole("button", { name: "Invite member" }).click();
  const invite = owner.getByRole("dialog", { name: /Invite member/ });
  await invite.getByRole("textbox", { name: /Email/ }).fill(memberUser.email);
  await invite.getByRole("button", { name: "Save" }).click();
  await expect(invite).toBeHidden();

  // The owner's Members page says who's waiting for two-step login.
  await owner.goto("/#/vault");
  await owner.goto(`${org}/members`);
  await expect(owner.getByTestId("members-two-step-waiting")).toContainText(memberUser.email);
  await expect(
    owner.getByRole("row").filter({ hasText: memberUser.email }).getByText("Needs confirmation"),
  ).toBeVisible();

  // The member's vault says why they aren't in, with the way to turn it on.
  await member.goto("/#/settings/account");
  await member.goto("/#/vault");
  const notice = member.getByTestId("two-step-needed");
  await expect(notice).toContainText("Strict Dental requires two-step login");
  await notice.getByRole("link", { name: "Turn on two-step login" }).click();
  await expect(member).toHaveURL(/#\/settings\/security\/two-factor/);

  await memberContext.close();
  await ownerContext.close();
});

extensionTest("the extension's vault says which organization is waiting for two-step login", async ({
  context,
  extensionId,
  request,
}, testInfo) => {
  const user = userFor("two-step-extension", testInfo.repeatEachIndex);
  const web = await createAccount(context, user);
  await web.close();

  // The owner needs no app here: the organization, its policy, and the
  // invitation through the API.
  const api = new Api(request);
  const owner = await api.account("two-step-ext-owner");
  const orgId = await api.organization(owner, "Strict Clinic");
  const policy = await api.call(owner, "PUT", `/api/organizations/${orgId}/policies/0`, {
    policy: { enabled: true, data: null },
  });
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);
  const invited = await api.call(owner, "POST", `/api/organizations/${orgId}/users/invite`, {
    emails: [user.email],
    type: 2,
    collections: [],
    groups: [],
    permissions: {},
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);

  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, user);
  const notice = popup.getByTestId("two-step-needed");
  await expect(notice).toContainText("Strict Clinic requires two-step login");
  const settings = context.waitForEvent("page");
  await notice.getByRole("button", { name: "Turn on two-step login" }).click();
  await expect(await settings).toHaveURL(/#\/settings\/security\/two-factor$/);
});
