// Offboarding in the web vault (DESIGN.md, "Offboarding"): a client's owner
// removes one of its MSP's technicians on the Members page, which offers a new
// install token, and the MSP's console shows the technician as removed by the
// client, offering the same. The API tests (tests/api/offboarding.spec.ts)
// check what the server does; this checks what people see. The accounts are
// real, made through the UI, since confirming encrypts the org key to them.
import { expect, test, type Page } from "@playwright/test";

import { reloadVault, signUp, signUpWithAuthenticator, webUserFor } from "./support/web";

/** A toast message. Toasts here have no ARIA role, so find them by text. */
const toast = (page: Page, text: string) => page.getByText(text, { exact: true });

test("a client's owner removes one of its MSP's technicians: the Members page offers a new install token, and the MSP's console shows them removed by the client", async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  const techContext = await browser.newContext();
  const tech = await techContext.newPage();
  const techUser = webUserFor("offboard-tech", testInfo.repeatEachIndex);
  // An MSP's staff sign in with two-step login (DESIGN.md, "Two-step login
  // for admins"), so the MSP's admin and technician have an authenticator app.
  await signUpWithAuthenticator(tech, techUser);
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const ownerUser = webUserFor("offboard-owner", testInfo.repeatEachIndex);
  await signUp(owner, ownerUser);
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await signUpWithAuthenticator(admin, webUserFor("offboard-admin", testInfo.repeatEachIndex));

  // An MSP with a client and a technician, who joins from the invitation link.
  await admin.goto("/#/msp");
  await admin.getByRole("textbox", { name: "Your MSP's name" }).fill("Pine IT");
  await admin.getByRole("button", { name: "Create MSP" }).click();
  await admin.getByRole("textbox", { name: "New client's name" }).fill("Pine Dental");
  await admin.getByRole("button", { name: "Add client" }).click();
  await expect(toast(admin, "Added Pine Dental")).toBeVisible();
  await admin.getByRole("textbox", { name: "Email of someone to add" }).fill(techUser.email);
  await admin.getByRole("button", { name: "Add staff" }).click();
  await expect(toast(admin, `Invited ${techUser.email}`)).toBeVisible();
  const link = await admin.getByTestId("msp-invite-link").locator("pre").textContent();
  await tech.goto(link!.slice(link!.indexOf("/#/")));
  await tech.getByTestId("msp-invitation").getByRole("button", { name: "Join Pine IT" }).click();
  await expect(toast(tech, "You joined Pine IT")).toBeVisible();

  // The MSP adds the client's own owner, and the console confirms everyone.
  await admin.getByTestId("msp-client-Pine Dental").getByRole("link", { name: "Open" }).click();
  await expect(admin).toHaveURL(/#\/organizations\/[^/]+\/members/);
  const membersUrl = admin.url();
  await admin.getByRole("button", { name: "Invite member" }).click();
  const invite = admin.getByRole("dialog", { name: /Invite member/ });
  await invite.getByRole("textbox", { name: /Email/ }).fill(ownerUser.email);
  await invite.getByRole("radio", { name: /^Owner/ }).check();
  await invite.getByRole("button", { name: "Save" }).click();
  await expect(invite).toBeHidden();
  // Opening the console (or the Members page) confirms whoever is waiting.
  await expect(async () => {
    await admin.goto("/#/vault");
    await admin.goto("/#/msp");
    await admin.goto(membersUrl);
    for (const email of [ownerUser.email, techUser.email]) {
      const row = admin.getByRole("row").filter({ hasText: email });
      await expect(row).toHaveCount(1, { timeout: 5_000 });
      await expect(row.getByText("Needs confirmation")).toHaveCount(0, { timeout: 2_000 });
    }
  }).toPass({ timeout: 90_000 });

  // The client's owner removes the technician on the Members page.
  await reloadVault(owner);
  await owner.goto(membersUrl);
  await expect(owner.getByTestId("client-msp")).toContainText("Pine IT manages this organization");
  await expect(owner.getByTestId("install-token-prompt")).toHaveCount(0);
  await owner.getByPlaceholder("Search members").fill(techUser.email);
  const row = owner.getByRole("row").filter({ hasText: techUser.email });
  await row.getByRole("button", { name: "Options" }).click();
  await owner.getByRole("menuitem", { name: "Remove" }).click();
  await owner.getByRole("dialog").getByRole("button", { name: "Yes" }).click();
  await expect(toast(owner, "Removed user offboard-tech.")).toBeVisible();
  // The banner of the MSP's people no longer lists them.
  await expect(owner.getByTestId("client-msp-staff")).toHaveCount(1);

  // The Members page says whom to ask for a new install token.
  const prompt = owner.getByTestId("install-token-prompt");
  await expect(prompt).toContainText("1 person was removed since the install command was made.");
  await expect(prompt).toContainText("Pine IT manages it: ask them to replace the token.");
  await expect(prompt.getByRole("button", { name: "Replace token" })).toHaveCount(0);

  // The MSP's console shows the technician removed by the client, and offers
  // to replace the client's token.
  await admin.goto("/#/vault");
  await admin.goto("/#/msp");
  const client = admin.getByTestId("msp-client-Pine Dental");
  await expect(client.getByTestId("msp-client-removed")).toHaveText(`The client removed ${techUser.email}`);
  await expect(admin.getByTestId(`msp-staff-${techUser.email}`).getByTestId("msp-staff-removed")).toContainText(
    "Removed by the client in Pine Dental",
  );
  await client.getByTestId("msp-client-replace-token").getByRole("button").click();
  const install = admin.getByTestId("msp-install");
  await expect(install.getByTestId("msp-install-replace-prompt")).toContainText(
    "1 person was removed since the install command was made.",
  );
  await install.getByRole("button", { name: "Replace token" }).click();
  await admin.getByRole("dialog").getByRole("button", { name: "Replace token" }).click();
  await expect(toast(admin, "Replaced the install token")).toBeVisible();
  await expect(install.getByTestId("msp-install-replace-prompt")).toHaveCount(0);

  // With the new token, neither page offers it again, and the technician stays out.
  await admin.goto("/#/vault");
  await admin.goto("/#/msp");
  await expect(client.getByTestId("msp-client-replace-token")).toHaveCount(0);
  await reloadVault(owner);
  await owner.goto(membersUrl);
  await expect(owner.getByTestId("install-token-prompt")).toHaveCount(0);
  await owner.getByPlaceholder("Search members").fill(techUser.email);
  await expect(owner.getByRole("row").filter({ hasText: techUser.email })).toHaveCount(0);

  await techContext.close();
  await ownerContext.close();
  await adminContext.close();
});
