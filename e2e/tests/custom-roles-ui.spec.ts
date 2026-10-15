// A client's point of contact with a custom role, through the web vault: the
// MSP gives them "Manage users" only; they see the Members page but not
// Policies, can invite a regular member, and can't invite an admin.
import { expect, test, type Page } from "@playwright/test";

import { signUp, webUserFor } from "./support/web";

const toast = (page: Page, text: string | RegExp) => page.getByText(text).first();

test("an MSP admin gives a client's point of contact a custom role that manages members, and nothing more", async ({
  browser,
}, testInfo) => {
  test.setTimeout(150_000);
  // Known gap (DESIGN.md, "Roles and permissions"): the Members page also loads
  // the collection list, which a custom role can't read yet, and the refusal
  // signs the person out. Expected to fail until that's fixed; it turns red
  // when it passes, so remove this line then.
  test.fail();
  const pocContext = await browser.newContext();
  const poc = await pocContext.newPage();
  const pocUser = webUserFor("poc", testInfo.repeatEachIndex);
  await signUp(poc, pocUser);

  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await signUp(admin, webUserFor("roles-admin", testInfo.repeatEachIndex));
  await admin.goto("/#/msp");
  await admin.getByRole("textbox", { name: "Your MSP's name" }).fill("Roles IT");
  await admin.getByRole("button", { name: "Create MSP" }).click();
  await admin.getByRole("textbox", { name: "New client's name" }).fill("Fabrikam Dental");
  await admin.getByRole("button", { name: "Add client" }).click();
  await admin.getByTestId("msp-client-Fabrikam Dental").getByRole("link", { name: "Open" }).click();
  await expect(admin).toHaveURL(/#\/organizations\/[^/]+\/members/);
  const membersUrl = admin.url();

  // The MSP admin invites the point of contact with a Custom role: manage users only.
  await admin.getByRole("button", { name: "Invite member" }).click();
  const invite = admin.getByRole("dialog", { name: /Invite member/ });
  await invite.getByRole("textbox", { name: /Email/ }).fill(pocUser.email);
  await invite.getByRole("radio", { name: /^Custom/ }).check();
  await invite.getByRole("checkbox", { name: "Manage users" }).check();
  // Permissions our server doesn't enforce aren't offered.
  await expect(invite.getByRole("checkbox", { name: "Manage groups" })).toHaveCount(0);
  await invite.getByRole("button", { name: "Save" }).click();
  await expect(invite).toBeHidden();
  await admin.goto("/#/msp");
  await expect(toast(admin, "Confirmed 1 member")).toBeVisible();

  // The point of contact manages members, and sees nothing else of the admin console.
  await poc.reload();
  await poc.getByRole("textbox", { name: /^Master password/ }).fill(pocUser.password);
  await poc.getByRole("button", { name: "Unlock", exact: true }).click();
  await poc.waitForURL(/#\/vault/);
  await poc.goto(membersUrl);
  await expect(poc.getByRole("button", { name: "Invite member" })).toBeVisible();
  await expect(poc.getByRole("link", { name: "Members" })).toBeVisible();
  await expect(poc.getByRole("link", { name: "Policies" })).toHaveCount(0);

  const newHire = `front-desk-${testInfo.repeatEachIndex}@example.test`;
  await poc.getByRole("button", { name: "Invite member" }).click();
  const pocInvite = poc.getByRole("dialog", { name: /Invite member/ });
  await pocInvite.getByRole("textbox", { name: /Email/ }).fill(newHire);
  await pocInvite.getByRole("button", { name: "Save" }).click();
  await expect(pocInvite).toBeHidden();
  await expect(poc.getByText(newHire).first()).toBeVisible();

  // The server refuses anything beyond a regular member, whatever the dialog offers.
  await poc.getByRole("button", { name: "Invite member" }).click();
  const adminInvite = poc.getByRole("dialog", { name: /Invite member/ });
  await adminInvite.getByRole("textbox", { name: /Email/ }).fill(`would-be-admin-${testInfo.repeatEachIndex}@example.test`);
  const adminRadio = adminInvite.getByRole("radio", { name: /^Admin/ });
  if (await adminRadio.isEnabled()) {
    await adminRadio.check();
    await adminInvite.getByRole("button", { name: "Save" }).click();
    await expect(toast(poc, /Only Owners can invite|only add regular members/)).toBeVisible();
  }
  await expect(poc.getByText(`would-be-admin-${testInfo.repeatEachIndex}@example.test`)).toHaveCount(0);

  await pocContext.close();
  await adminContext.close();
});
