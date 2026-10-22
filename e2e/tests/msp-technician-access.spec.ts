// Technician access in the MSP console: an MSP admin limits a new technician
// to one client with a custom role and no install commands, the technician
// sees just that and works inside it, then the admin widens their access from
// the Staff section and it reaches every client at once, then gives them a
// different role in one client.
import { expect, test, type Page } from "@playwright/test";

import { signUp, webUserFor } from "./support/web";

/** A toast message. Toasts here have no ARIA role, so find them by text. */
const toast = (page: Page, text: string) =>
  page.getByText(text, { exact: true });

test("an MSP admin chooses a technician's clients, role, and install commands, and the technician gets just that", async ({
  browser,
}, testInfo) => {
  // These tests drive several accounts end to end; CI machines are slower.
  test.setTimeout(180_000);
  const techContext = await browser.newContext();
  const tech = await techContext.newPage();
  const techUser = webUserFor("access-tech", testInfo.repeatEachIndex);
  await signUp(tech, techUser);

  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const adminUser = webUserFor("access-admin", testInfo.repeatEachIndex);
  await signUp(admin, adminUser);
  await admin.goto("/#/msp");
  await admin.getByRole("textbox", { name: "Your MSP's name" }).fill("Wingtip IT");
  await admin.getByRole("button", { name: "Create MSP" }).click();
  for (const name of ["Acme Dental", "Baker Law"]) {
    await admin.getByRole("textbox", { name: "New client's name" }).fill(name);
    await admin.getByRole("button", { name: "Add client" }).click();
    await expect(toast(admin, `Added ${name}`)).toBeVisible();
  }

  // Access chosen while adding them: Acme Dental only, a custom role that
  // manages users, and no install commands.
  await admin
    .getByRole("textbox", { name: "Email of someone to add" })
    .fill(techUser.email);
  await admin.getByRole("button", { name: "Choose access" }).click();
  const newAccess = admin.getByTestId("msp-new-staff-access");
  await newAccess.getByRole("radio", { name: "Only the clients chosen here" }).check();
  await newAccess.getByRole("checkbox", { name: "Acme Dental" }).check();
  await newAccess.getByRole("radio", { name: "Custom" }).check();
  await newAccess.getByRole("checkbox", { name: "Manage users" }).check();
  await newAccess.getByRole("checkbox", { name: "Sees install commands" }).uncheck();
  await admin.getByRole("button", { name: "Add staff" }).click();
  await expect(toast(admin, `Invited ${techUser.email}`)).toBeVisible();
  await expect(admin.getByTestId(`msp-invite-${techUser.email}`)).toContainText(
    "Acme Dental · Custom role · No install commands",
  );

  // They accept from the link, and the console confirms them in Acme Dental.
  const link = await admin.getByTestId("msp-invite-link").locator("pre").textContent();
  await tech.goto(link!.slice(link!.indexOf("/#/")));
  await tech
    .getByTestId("msp-invitation")
    .getByRole("button", { name: "Join Wingtip IT" })
    .click();
  await expect(toast(tech, "You joined Wingtip IT")).toBeVisible();
  await admin.goto("/#/vault");
  await admin.goto("/#/msp");
  await expect(toast(admin, "Confirmed 1 member")).toBeVisible();
  const staffRow = admin.getByTestId(`msp-staff-${techUser.email}`);
  await expect(staffRow.getByTestId("msp-staff-access")).toHaveText(
    "Acme Dental · Custom role · No install commands",
  );
  await expect(admin.getByTestId(`msp-staff-${adminUser.email}`)).toContainText(
    "Owner of every client",
  );

  // The technician sees only that client, without its install command, and
  // opens it where their role starts. Reloading locks the vault; unlock it.
  // (It returns to the console, where they accepted the invitation.)
  await tech.reload();
  await tech
    .getByRole("textbox", { name: /^Master password/ })
    .fill(techUser.password);
  const unlock = tech.getByRole("button", { name: "Unlock", exact: true });
  await unlock.click();
  await expect(unlock).toBeHidden();
  await tech.goto("/#/vault");
  await tech.goto("/#/msp");
  const techDental = tech.getByTestId("msp-client-Acme Dental");
  await expect(techDental).toBeVisible();
  await expect(tech.getByTestId("msp-client-Baker Law")).toHaveCount(0);
  await expect(
    techDental.getByRole("button", { name: "Install command" }),
  ).toHaveCount(0);
  await techDental.getByRole("link", { name: "Open" }).click();
  await expect(tech).toHaveURL(/#\/organizations\/[^/]+\/members/);
  await expect(tech.getByRole("button", { name: "Invite member" })).toBeVisible();
  await expect(tech.getByRole("link", { name: "Policies" })).toHaveCount(0);

  // The admin widens their access from the Staff section: every client, as
  // admin, with install commands. The console confirms them in Baker Law.
  await admin.goto("/#/msp");
  await staffRow.getByRole("button", { name: "Edit access" }).click();
  const editor = admin.getByTestId("msp-access-editor");
  await expect(editor.getByRole("checkbox", { name: "Acme Dental" })).toBeChecked();
  await expect(editor.getByRole("checkbox", { name: "Manage users" })).toBeChecked();
  await editor.getByRole("radio", { name: "Every client" }).check();
  await editor.getByRole("radio", { name: "Admin" }).check();
  await editor.getByRole("checkbox", { name: "Sees install commands" }).check();
  await editor.getByRole("button", { name: "Save access" }).click();
  await expect(toast(admin, "Confirmed 1 member")).toBeVisible();
  await expect(toast(admin, `Saved ${techUser.email}'s access`)).toBeVisible();
  await expect(editor).toHaveCount(0);
  await expect(staffRow.getByTestId("msp-staff-access")).toHaveText(
    "Every client · Admin · Install commands",
  );
  await expect(admin.getByTestId("msp-activity")).toContainText(
    `${adminUser.email} set ${techUser.email}'s access: every client, as admin, install commands`,
  );

  // Now the technician reaches both clients, with install commands.
  await tech.goto("/#/vault");
  await tech.goto("/#/msp");
  for (const name of ["Acme Dental", "Baker Law"]) {
    await expect(
      tech
        .getByTestId(`msp-client-${name}`)
        .getByRole("button", { name: "Install command" }),
    ).toBeVisible();
  }

  // A different role in one client: a custom role that manages users at
  // Baker Law, admin everywhere else.
  await staffRow.getByRole("button", { name: "Edit access" }).click();
  await editor.getByRole("button", { name: "Add a client with a different role" }).click();
  const row = editor.getByTestId("client-role");
  await row.getByRole("combobox", { name: "Client" }).selectOption({ label: "Baker Law" });
  await row.getByRole("combobox", { name: "Role there" }).selectOption({ label: "Custom" });
  await row.getByRole("checkbox", { name: "Manage users" }).check();
  await editor.getByRole("button", { name: "Save access" }).click();
  await expect(toast(admin, `Saved ${techUser.email}'s access`)).toBeVisible();
  await expect(staffRow.getByTestId("msp-staff-access")).toHaveText(
    "Every client · Admin · Install commands · Custom role in Baker Law",
  );
  await expect(admin.getByTestId("msp-activity")).toContainText(
    `${adminUser.email} set ${techUser.email}'s access: every client, as admin, install commands; in Baker Law, custom role (manage users), no vault items`,
  );
  // Admin at Acme Dental still, so its policies are theirs; not at Baker Law.
  await tech.goto("/#/vault");
  await tech.goto("/#/msp");
  await tech.getByTestId("msp-client-Baker Law").getByRole("link", { name: "Open" }).click();
  await expect(tech.getByRole("button", { name: "Invite member" })).toBeVisible();
  await expect(tech.getByRole("link", { name: "Policies" })).toHaveCount(0);

  await techContext.close();
  await adminContext.close();
});
