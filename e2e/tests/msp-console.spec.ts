// The MSP console in the web vault: set up an MSP, add a client, add a
// technician, and the technician gets into the client without anyone
// confirming them by hand. Both accounts are real, made through the UI, since
// confirming encrypts the org key to the technician's real public key.
import { expect, test, type Page } from "@playwright/test";

import { brand } from "../paths.mjs";

import { signUp, webUserFor } from "./support/web";

/** A toast message. Toasts here have no ARIA role, so find them by text. */
const toast = (page: Page, text: string) =>
  page.getByText(text, { exact: true });

test("an MSP admin adds a client and a technician, and the technician gets in once they accept, without a manual confirm", async ({
  browser,
}, testInfo) => {
  // These tests drive several accounts end to end; CI machines are slower.
  test.setTimeout(120_000);
  const techContext = await browser.newContext();
  const tech = await techContext.newPage();
  const techUser = webUserFor("msp-tech", testInfo.repeatEachIndex);
  await signUp(tech, techUser);

  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await signUp(admin, webUserFor("msp-admin", testInfo.repeatEachIndex));

  // Set up the MSP.
  await admin.goto("/#/msp");

  await admin
    .getByRole("textbox", { name: "Your MSP's name" })
    .fill("Northwind IT");
  await admin.getByRole("button", { name: "Create MSP" }).click();
  await expect(admin.getByTestId("msp-name")).toContainText("Northwind IT");
  await expect(admin.getByTestId("msp-name")).toContainText("Admin");

  // A client, with its keys made in the browser.
  await admin
    .getByRole("textbox", { name: "New client's name" })
    .fill("Acme Dental");
  await admin.getByRole("button", { name: "Add client" }).click();
  await expect(toast(admin, "Added Acme Dental")).toBeVisible();
  const client = admin.getByTestId("msp-client-Acme Dental");
  await expect(client.getByRole("link", { name: "Open" })).toBeVisible();

  // The default policies (the Business preset), applied without building
  // any. Account recovery is on too (the API and mail tests check it), but the
  // server only shows it when it can send email, and this test server sends
  // none.
  await expect(client.getByTestId("msp-client-policies")).toHaveText("Defaults");
  await client.getByRole("link", { name: "Open" }).click();
  await expect(admin).toHaveURL(/#\/organizations\/[^/]+\/members/);
  const clientUrl = admin.url().replace(/\/members.*$/, "");
  await admin.goto(`${clientUrl}/settings/policies`);
  for (const policy of [
    /Master password requirements/,
    /^Single organization/,
    /^Vault lock/,
  ]) {
    await expect(admin.getByRole("button", { name: policy })).toContainText(
      "On",
    );
  }
  await admin.goto("/#/msp");

  // The client's install command for the RMM, with its enrollment token, join
  // secret, and the client's key fingerprint.
  await admin
    .getByTestId("msp-client-Acme Dental")
    .getByRole("button", { name: "Install command" })
    .click();
  const command = admin.getByTestId("msp-install-command");
  const shape = new RegExp(
    `^\\.\\\\${brand.installScript.replace(".", "\\.")} -ServerUrl 'https://127\\.0\\.0\\.1:\\d+' -EnrollmentToken '[A-Za-z0-9_-]{43}' -JoinSecret '[A-Za-z0-9_-]{43}' -OrgKey '[A-Za-z0-9_-]{43}'$`,
  );
  await expect(command).toHaveText(shape);
  const firstCommand = await command.textContent();
  await expect(admin.getByTestId("msp-install")).toContainText(
    "0 people have joined",
  );

  // Replacing the token changes the command, after a warning.
  await admin.getByRole("button", { name: "Replace token" }).click();
  await admin
    .getByRole("dialog")
    .getByRole("button", { name: "Replace token" })
    .click();
  await expect(toast(admin, "Replaced the install token")).toBeVisible();
  await expect(command).toHaveText(shape);
  await expect(command).not.toHaveText(firstCommand!);

  // Limiting the command to email domains trusts verified emails only, and
  // this test server sends no email, so the console says why it can't. The
  // mail tests set it.
  await admin
    .getByRole("textbox", { name: "Only these email domains can join" })
    .fill("acme.test");
  await admin.getByRole("button", { name: "Save domains" }).click();
  await expect(
    admin.getByText(/needs verified emails, and this server can't send email/),
  ).toBeVisible();

  // Health per client: a weak password that expires in 5 days, added in the
  // client's own vault, shows up in the console.
  await admin.goto(`${clientUrl}/vault`);
  await admin.getByRole("button", { name: "Everyone", exact: true }).first().click();
  await admin.getByRole("button", { name: "New", exact: true }).click();
  await admin.getByRole("menuitem", { name: "Login" }).click();
  const item = admin.getByRole("dialog", { name: "New Login" });
  await item.getByRole("textbox", { name: /Item name/ }).fill("Front desk PC");
  await item.getByRole("textbox", { name: "Username", exact: true }).fill("frontdesk@acme.test");
  await item.getByRole("textbox", { name: "Password", exact: true }).fill("password1");
  const inFiveDays = new Date();
  inFiveDays.setUTCDate(inFiveDays.getUTCDate() + 5);
  await item.getByTestId("keykeeper-expires").fill(inFiveDays.toISOString().slice(0, 10));
  await item.getByRole("button", { name: "Save" }).click();
  await expect(item).toBeHidden();
  // Saving opens the item's view; close it.
  await admin.getByRole("dialog", { name: "View Login" }).getByRole("button", { name: "Close" }).first().click();
  await admin.goto("/#/msp");
  const row = admin.getByTestId("msp-client-Acme Dental");
  await expect(row.getByTestId("msp-client-weak")).toHaveText("1");
  await expect(row.getByTestId("msp-client-expiring")).toHaveText("1");
  await expect(row.getByTestId("msp-client-reused")).toHaveText("0");

  // The same item in the list of what's expiring across all clients, which
  // opens it in the client's vault.
  const expiring = admin.getByTestId("msp-expiring").getByTestId("msp-expiring-Front desk PC");
  await expect(expiring).toContainText("Acme Dental");
  await expect(expiring).toContainText("Expires in 5 days");
  await expiring.getByRole("link", { name: "Front desk PC" }).click();
  await expect(admin).toHaveURL(/#\/organizations\/[0-9a-f-]{36}\/vault/);
  const opened = admin.getByRole("dialog", { name: /^View/ });
  await expect(opened.getByRole("textbox", { name: "Username" })).toHaveValue("frontdesk@acme.test");
  await opened.getByRole("button", { name: "Close" }).first().click();
  await admin.goto("/#/msp");

  // A technician: invited, even with an account, since joining an MSP's staff
  // is theirs to accept. They accept from the link, and the console confirms
  // them in every client.
  await admin
    .getByRole("textbox", { name: "Email of someone to add" })
    .fill(techUser.email);
  await admin.getByRole("button", { name: "Add staff" }).click();
  await expect(toast(admin, `Invited ${techUser.email}`)).toBeVisible();
  const link = await admin.getByTestId("msp-invite-link").locator("pre").textContent();
  await tech.goto(link!.slice(link!.indexOf("/#/")));
  await tech
    .getByTestId("msp-invitation")
    .getByRole("button", { name: "Join Northwind IT" })
    .click();
  await expect(toast(tech, "You joined Northwind IT")).toBeVisible();
  await admin.goto("/#/vault");
  await admin.goto("/#/msp");
  // Either the console confirms them as it opens (and says so), or the web
  // vault's background work already has (it runs when items change and every
  // few minutes); the technician getting into the client below is the proof.
  await expect(admin.getByTestId(`msp-staff-${techUser.email}`)).toContainText(
    "Technician",
  );

  // The technician sees the console in their nav and can open the client.
  // Reloading locks the web vault, so unlock it again.
  await tech.reload();
  await tech
    .getByRole("textbox", { name: /^Master password/ })
    .fill(techUser.password);
  await tech.getByRole("button", { name: "Unlock", exact: true }).click();
  await tech.getByRole("link", { name: "MSP console" }).click();
  await expect(tech.getByTestId("msp-name")).toContainText("Technician");
  const techClient = tech.getByTestId("msp-client-Acme Dental");
  await techClient.getByRole("link", { name: "Open" }).click();
  await expect(tech).toHaveURL(/#\/organizations\/[^/]+\/members/);
  await expect(tech.getByText(techUser.email).first()).toBeVisible();

  // Technicians can't manage the MSP.
  await tech.goto("/#/msp");
  await expect(tech.getByTestId("msp-name")).toBeVisible();
  await expect(tech.getByRole("button", { name: "Add client" })).toHaveCount(0);
  await expect(tech.getByRole("button", { name: "Add staff" })).toHaveCount(0);

  await techContext.close();
  await adminContext.close();
});

test("a client's own owner sees its MSP on the Members page and removes it; the MSP's staff can't", async ({
  browser,
}, testInfo) => {
  // These tests drive several accounts end to end; CI machines are slower.
  test.setTimeout(120_000);
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const ownerUser = webUserFor("client-owner", testInfo.repeatEachIndex);
  await signUp(owner, ownerUser);

  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const adminUser = webUserFor("msp-admin-2", testInfo.repeatEachIndex);
  await signUp(admin, adminUser);
  await admin.goto("/#/msp");
  await admin.getByRole("textbox", { name: "Your MSP's name" }).fill("Contoso IT");
  await admin.getByRole("button", { name: "Create MSP" }).click();
  await admin.getByRole("textbox", { name: "New client's name" }).fill("Fabrikam Law");
  await admin.getByRole("button", { name: "Add client" }).click();
  await admin.getByTestId("msp-client-Fabrikam Law").getByRole("link", { name: "Open" }).click();
  await expect(admin).toHaveURL(/#\/organizations\/[^/]+\/members/);
  const membersUrl = admin.url();

  // The MSP's own staff see the banner, without a way to remove the MSP.
  const banner = admin.getByTestId("client-msp");
  await expect(banner).toContainText("Contoso IT manages this organization");
  await expect(banner.getByRole("button")).toHaveCount(0);

  // The MSP adds the client's owner, and the console confirms them.
  await admin.getByRole("button", { name: "Invite member" }).click();
  const invite = admin.getByRole("dialog", { name: /Invite member/ });
  await invite.getByRole("textbox", { name: /Email/ }).fill(ownerUser.email);
  await invite.getByRole("radio", { name: /^Owner/ }).check();
  await invite.getByRole("button", { name: "Save" }).click();
  await expect(invite).toBeHidden();
  await admin.goto("/#/msp");
  await expect(toast(admin, "Confirmed 1 member")).toBeVisible();

  // The client's owner removes the MSP from their own Members page.
  await owner.reload();
  await owner.getByRole("textbox", { name: /^Master password/ }).fill(ownerUser.password);
  await owner.getByRole("button", { name: "Unlock", exact: true }).click();
  await owner.waitForURL(/#\/vault/);
  await owner.goto(membersUrl);
  const ownerBanner = owner.getByTestId("client-msp");
  await expect(ownerBanner).toContainText("Contoso IT manages this organization");
  // It says what each of the MSP's people can do here.
  const staffLine = ownerBanner.getByTestId("client-msp-staff");
  await expect(staffLine).toHaveCount(1);
  await expect(staffLine).toContainText(adminUser.email);
  await expect(staffLine).toContainText("Owner, with every vault item");
  await ownerBanner.getByRole("button", { name: "Remove Contoso IT" }).click();
  await owner.getByRole("dialog").getByRole("button", { name: "Remove Contoso IT" }).click();
  await expect(toast(owner, "Removed Contoso IT")).toBeVisible();
  await expect(ownerBanner).toHaveCount(0);
  await expect(owner.getByText(adminUser.email)).toHaveCount(0);
  await expect(owner.getByText(ownerUser.email).first()).toBeVisible();

  await ownerContext.close();
  await adminContext.close();
});

test("an MSP admin invites someone without an account, who signs up and joins from the link; Activity shows it", async ({
  browser,
}, testInfo) => {
  // These tests drive several accounts end to end; CI machines are slower.
  test.setTimeout(120_000);
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const adminUser = webUserFor("invite-admin", testInfo.repeatEachIndex);
  await signUp(admin, adminUser);
  await admin.goto("/#/msp");
  await admin.getByRole("textbox", { name: "Your MSP's name" }).fill("Tailspin IT");
  await admin.getByRole("button", { name: "Create MSP" }).click();
  await admin.getByRole("textbox", { name: "New client's name" }).fill("Tailspin Client");
  await admin.getByRole("button", { name: "Add client" }).click();
  await expect(admin.getByTestId("msp-client-Tailspin Client")).toBeVisible();

  // No account uses this address yet, so adding them invites them.
  const hireUser = webUserFor("invited-tech", testInfo.repeatEachIndex);
  await admin.getByRole("textbox", { name: "Email of someone to add" }).fill(hireUser.email);
  await admin.getByRole("button", { name: "Add staff" }).click();
  await expect(toast(admin, `Invited ${hireUser.email}`)).toBeVisible();
  await expect(admin.getByTestId(`msp-invite-${hireUser.email}`)).toContainText("Invited");
  const link = await admin.getByTestId("msp-invite-link").locator("pre").textContent();
  expect(link).toMatch(/#\/msp\?invite=[A-Za-z0-9_-]{43}$/);

  // They create an account with that address and open the link.
  const hireContext = await browser.newContext();
  const hire = await hireContext.newPage();
  await signUp(hire, hireUser);
  await hire.goto(link!.slice(link!.indexOf("/#/")));
  const invitation = hire.getByTestId("msp-invitation");
  await expect(invitation).toContainText(`${adminUser.email} invited you to join Tailspin IT as a technician`);
  await invitation.getByRole("button", { name: "Join Tailspin IT" }).click();
  await expect(toast(hire, "You joined Tailspin IT")).toBeVisible();
  await expect(hire.getByTestId("msp-name")).toContainText("Technician");
  await expect(invitation).toHaveCount(0);

  // The admin's console confirms them, and Activity tells the story.
  await admin.goto("/#/vault");
  await admin.goto("/#/msp");
  await expect(toast(admin, "Confirmed 1 member")).toBeVisible();
  const activity = admin.getByTestId("msp-activity");
  await expect(activity).toContainText(`${adminUser.email} confirmed ${hireUser.email} in Tailspin Client`);
  await expect(activity).toContainText(`${hireUser.email} accepted the invitation and joined as a technician`);
  await expect(activity).toContainText(`${adminUser.email} invited ${hireUser.email} to join as a technician`);
  await expect(activity).toContainText(`${adminUser.email} added the client Tailspin Client with the default policies`);
  await expect(admin.getByTestId(`msp-invite-${hireUser.email}`)).toHaveCount(0);

  await hireContext.close();
  await adminContext.close();
});
