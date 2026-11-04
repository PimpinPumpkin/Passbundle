// A client's point of contact with a custom role, through the web vault: the
// MSP gives them "Manage users" only; they see the Members page but not
// Policies, can invite a regular member and open their edit dialog, and can't
// invite an admin, and their Options menu leaves out a member's event log. A
// custom role that only views event logs opens the event log and sees who
// acted, and one that also manages members opens a member's event log. Custom
// roles with our permissions can't also manage all collections, whose admin
// console tools would refuse them and sign them out, while upstream's Custom
// with only those still opens the admin console's Vault tab.
import { expect, test, type Page } from "@playwright/test";

import { reloadVault, signUp, signUpWithAuthenticator, webUserFor } from "./support/web";

const toast = (page: Page, text: string | RegExp) => page.getByText(text).first();

/**
 * The API calls the server refused as unauthorized or forbidden. The web vault
 * signs out on either, so a page that makes one is broken for that person.
 */
function refusedCalls(page: Page) {
  const refused: string[] = [];
  page.on("response", (response) => {
    if ([401, 403].includes(response.status()) && response.url().includes("/api/")) {
      refused.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
  return refused;
}

test("an MSP admin gives a client's point of contact a custom role that manages members, and nothing more", async ({
  browser,
}, testInfo) => {
  test.setTimeout(150_000);
  const pocContext = await browser.newContext();
  const poc = await pocContext.newPage();
  // A point of contact who manages members, and the MSP's admin, sign in with
  // two-step login (DESIGN.md, "Two-step login for admins").
  const pocUser = webUserFor("poc", testInfo.repeatEachIndex);
  await signUpWithAuthenticator(poc, pocUser);

  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await signUpWithAuthenticator(admin, webUserFor("roles-admin", testInfo.repeatEachIndex));
  await admin.goto("/#/msp");
  await admin.getByRole("textbox", { name: "Your MSP's name" }).fill("Roles IT");
  await admin.getByRole("button", { name: "Create MSP" }).click();
  await admin.getByRole("textbox", { name: "New client's name" }).fill("Fabrikam Dental");
  await admin.getByRole("button", { name: "Add client" }).click();
  await admin.getByTestId("msp-client-Fabrikam Dental").getByRole("link", { name: "Open" }).click();
  await expect(admin).toHaveURL(/#\/organizations\/[^/]+\/members/);
  const orgUrl = admin.url().replace(/\/members.*$/, "");

  // The MSP admin invites the point of contact with a Custom role: manage users only.
  await admin.getByRole("button", { name: "Invite member" }).click();
  const invite = admin.getByRole("dialog", { name: /Invite member/ });
  await invite.getByRole("textbox", { name: /Email/ }).fill(pocUser.email);
  await invite.getByRole("radio", { name: /^Custom/ }).check();
  const allCollections = invite.getByRole("checkbox", { name: "Manage all shared folders" });
  await expect(allCollections).toBeVisible();
  await invite.getByRole("checkbox", { name: "Manage users" }).check();
  // Permissions our server doesn't enforce aren't offered, and neither is
  // managing all collections on top of one it does.
  await expect(invite.getByRole("checkbox", { name: "Manage groups" })).toHaveCount(0);
  await expect(allCollections).toHaveCount(0);
  await expect(invite.getByTestId("custom-role-no-collections")).toContainText(
    "can't also manage all shared folders",
  );
  await invite.getByRole("button", { name: "Save" }).click();
  await expect(invite).toBeHidden();
  await admin.goto("/#/msp");
  await expect(toast(admin, "Confirmed 1 member")).toBeVisible();

  // The point of contact opens the organization, lands on Members, and sees
  // nothing else of the admin console.
  await reloadVault(poc);
  const refused = refusedCalls(poc);
  await poc.goto(orgUrl);
  await expect(poc).toHaveURL(/#\/organizations\/[^/]+\/members/);
  await expect(poc.getByRole("button", { name: "Invite member" })).toBeVisible();
  await expect(poc.getByRole("link", { name: "Members" })).toBeVisible();
  await expect(poc.getByRole("link", { name: "Policies" })).toHaveCount(0);

  // A member's Options menu doesn't offer their event log, which this role
  // can't view: opening it would be refused and sign them out.
  const ownRow = poc.getByRole("row").filter({ hasText: pocUser.email });
  await ownRow.getByRole("button", { name: "Options" }).click();
  await expect(poc.getByRole("menu")).toBeVisible();
  await expect(poc.getByRole("menuitem", { name: "Event logs" })).toHaveCount(0);
  await poc.keyboard.press("Escape");
  await expect(poc.getByRole("menu")).toBeHidden();

  const newHire = `front-desk-${testInfo.repeatEachIndex}@example.test`;
  await poc.getByRole("button", { name: "Invite member" }).click();
  const pocInvite = poc.getByRole("dialog", { name: /Invite member/ });
  await pocInvite.getByRole("textbox", { name: /Email/ }).fill(newHire);
  await pocInvite.getByRole("button", { name: "Save" }).click();
  await expect(pocInvite).toBeHidden();
  // A row, since the first text match is the avatar's hidden title.
  const newHireRow = poc.getByRole("row").filter({ hasText: newHire });
  await expect(newHireRow).toBeVisible();

  // Their edit dialog loads the member, the organization's groups, and the
  // collections, all within the role.
  await newHireRow.getByRole("button", { name: newHire }).click();
  const edit = poc.getByRole("dialog", { name: /Edit member/ });
  await expect(edit.getByRole("tab", { name: "Groups" })).toBeVisible();
  await edit.getByRole("button", { name: "Cancel" }).click();
  await expect(edit).toBeHidden();

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

  // Nothing they opened was refused, so they were never signed out.
  await expect(poc).toHaveURL(/#\/organizations\/[^/]+\/members/);
  expect(refused).toEqual([]);

  await pocContext.close();
  await adminContext.close();
});

test("upstream's Custom role that only manages all collections still opens the admin console's Vault tab", async ({
  browser,
}, testInfo) => {
  test.setTimeout(150_000);
  const managerContext = await browser.newContext();
  const manager = await managerContext.newPage();
  const managerUser = webUserFor("collections-manager", testInfo.repeatEachIndex);
  await signUp(manager, managerUser);

  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await signUpWithAuthenticator(admin, webUserFor("collections-admin", testInfo.repeatEachIndex));
  await admin.goto("/#/msp");
  await admin.getByRole("textbox", { name: "Your MSP's name" }).fill("Collections IT");
  await admin.getByRole("button", { name: "Create MSP" }).click();
  await admin.getByRole("textbox", { name: "New client's name" }).fill("Contoso Dental");
  await admin.getByRole("button", { name: "Add client" }).click();
  await admin.getByTestId("msp-client-Contoso Dental").getByRole("link", { name: "Open" }).click();
  await expect(admin).toHaveURL(/#\/organizations\/[^/]+\/members/);
  const orgUrl = admin.url().replace(/\/members.*$/, "");

  await admin.getByRole("button", { name: "Invite member" }).click();
  const invite = admin.getByRole("dialog", { name: /Invite member/ });
  await invite.getByRole("textbox", { name: /Email/ }).fill(managerUser.email);
  await invite.getByRole("radio", { name: /^Custom/ }).check();
  await invite.getByRole("checkbox", { name: "Manage all shared folders" }).check();
  await invite.getByRole("button", { name: "Save" }).click();
  await expect(invite).toBeHidden();
  await admin.goto("/#/msp");
  await expect(toast(admin, "Confirmed 1 member")).toBeVisible();

  await reloadVault(manager);
  const refused = refusedCalls(manager);
  await manager.goto(orgUrl);
  await expect(manager).toHaveURL(/#\/organizations\/[^/]+\/vault/);
  await expect(manager.getByRole("button", { name: "New" })).toBeVisible();
  expect(refused).toEqual([]);

  await managerContext.close();
  await adminContext.close();
});

test("a client's custom role that only views event logs opens the event log and sees who acted", async ({
  browser,
}, testInfo) => {
  test.setTimeout(150_000);
  const viewerContext = await browser.newContext();
  const viewer = await viewerContext.newPage();
  const viewerUser = webUserFor("log-viewer", testInfo.repeatEachIndex);
  await signUp(viewer, viewerUser);

  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const adminUser = webUserFor("events-admin", testInfo.repeatEachIndex);
  await signUpWithAuthenticator(admin, adminUser);
  await admin.goto("/#/msp");
  await admin.getByRole("textbox", { name: "Your MSP's name" }).fill("Events IT");
  await admin.getByRole("button", { name: "Create MSP" }).click();
  await admin.getByRole("textbox", { name: "New client's name" }).fill("Northwind Dental");
  await admin.getByRole("button", { name: "Add client" }).click();
  await admin.getByTestId("msp-client-Northwind Dental").getByRole("link", { name: "Open" }).click();
  await expect(admin).toHaveURL(/#\/organizations\/[^/]+\/members/);
  const orgUrl = admin.url().replace(/\/members.*$/, "");

  // The MSP admin invites them with a Custom role: view event logs only.
  await admin.getByRole("button", { name: "Invite member" }).click();
  const invite = admin.getByRole("dialog", { name: /Invite member/ });
  await invite.getByRole("textbox", { name: /Email/ }).fill(viewerUser.email);
  await invite.getByRole("radio", { name: /^Custom/ }).check();
  await invite.getByRole("checkbox", { name: /event logs/i }).check();
  await invite.getByRole("button", { name: "Save" }).click();
  await expect(invite).toBeHidden();
  await admin.goto("/#/msp");
  await expect(toast(admin, "Confirmed 1 member")).toBeVisible();

  // They open the organization and land on its event log, which names the
  // MSP admin who invited them.
  await reloadVault(viewer);
  const refused = refusedCalls(viewer);
  await viewer.goto(orgUrl);
  await expect(viewer).toHaveURL(/#\/organizations\/[^/]+\/reporting\/events/);
  await expect(
    viewer.getByRole("row").filter({ hasText: adminUser.name }).first(),
  ).toBeVisible();
  await expect(viewer.getByRole("link", { name: "Members" })).toHaveCount(0);

  // Nothing they opened was refused, so they were never signed out.
  await expect(viewer).toHaveURL(/#\/organizations\/[^/]+\/reporting\/events/);
  expect(refused).toEqual([]);

  await viewerContext.close();
  await adminContext.close();
});

test("a custom role that manages members and views event logs opens a member's event log from the Members page", async ({
  browser,
}, testInfo) => {
  test.setTimeout(150_000);
  const pocContext = await browser.newContext();
  const poc = await pocContext.newPage();
  const pocUser = webUserFor("poc-both", testInfo.repeatEachIndex);
  await signUpWithAuthenticator(poc, pocUser);

  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await signUpWithAuthenticator(admin, webUserFor("both-admin", testInfo.repeatEachIndex));
  await admin.goto("/#/msp");
  await admin.getByRole("textbox", { name: "Your MSP's name" }).fill("Both IT");
  await admin.getByRole("button", { name: "Create MSP" }).click();
  await admin.getByRole("textbox", { name: "New client's name" }).fill("Tailspin Dental");
  await admin.getByRole("button", { name: "Add client" }).click();
  await admin.getByTestId("msp-client-Tailspin Dental").getByRole("link", { name: "Open" }).click();
  await expect(admin).toHaveURL(/#\/organizations\/[^/]+\/members/);
  const orgUrl = admin.url().replace(/\/members.*$/, "");

  // The MSP admin invites them with a Custom role: manage users and view
  // event logs.
  await admin.getByRole("button", { name: "Invite member" }).click();
  const invite = admin.getByRole("dialog", { name: /Invite member/ });
  await invite.getByRole("textbox", { name: /Email/ }).fill(pocUser.email);
  await invite.getByRole("radio", { name: /^Custom/ }).check();
  await invite.getByRole("checkbox", { name: "Manage users" }).check();
  await invite.getByRole("checkbox", { name: /event logs/i }).check();
  await invite.getByRole("button", { name: "Save" }).click();
  await expect(invite).toBeHidden();
  await admin.goto("/#/msp");
  await expect(toast(admin, "Confirmed 1 member")).toBeVisible();

  // On the Members page, a member's Options menu offers their event log, and
  // it opens.
  await reloadVault(poc);
  const refused = refusedCalls(poc);
  await poc.goto(orgUrl);
  await expect(poc).toHaveURL(/#\/organizations\/[^/]+\/members/);
  const ownRow = poc.getByRole("row").filter({ hasText: pocUser.email });
  await ownRow.getByRole("button", { name: "Options" }).click();
  await poc.getByRole("menuitem", { name: "Event logs" }).click();
  const events = poc.getByRole("dialog", { name: /Event logs/ });
  await expect(events.getByRole("button", { name: "Refresh" })).toBeVisible();
  await poc.keyboard.press("Escape");
  await expect(events).toBeHidden();

  // Nothing they opened was refused, so they were never signed out.
  await expect(poc).toHaveURL(/#\/organizations\/[^/]+\/members/);
  expect(refused).toEqual([]);

  await pocContext.close();
  await adminContext.close();
});
