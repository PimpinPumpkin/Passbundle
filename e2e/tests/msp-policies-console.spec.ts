// Default policies in the MSP console: the defaults every client follows, a
// client's own setting made in its admin console (whose Policies page says
// the MSP sets defaults), a changed default reaching the clients that follow
// it, and a client put back on the default. And a default required for every
// client: it reaches a client with its own setting, is locked on that
// client's Policies page, and turned off, names the clients that had their
// own setting. See DESIGN.md, "Default policies" and "Required for every
// client".
import { expect, test, type Page } from "@playwright/test";

import { signUpWithAuthenticator, switchOn, webUserFor } from "./support/web";

/** A toast message. Toasts here have no ARIA role, so find them by text. */
const toast = (page: Page, text: string) =>
  page.getByText(text, { exact: true });

test("an MSP admin changes a default policy and sees which clients took it, and puts a client with its own setting back on the default", async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const adminUser = webUserFor("msp-admin-policies", testInfo.repeatEachIndex);
  await signUpWithAuthenticator(admin, adminUser);
  await admin.goto("/#/msp");
  await admin
    .getByRole("textbox", { name: "Your MSP's name" })
    .fill("Northwind IT");
  await admin.getByRole("button", { name: "Create MSP" }).click();
  for (const name of ["Acme Dental", "Baker Law"]) {
    await admin.getByRole("textbox", { name: "New client's name" }).fill(name);
    await admin.getByRole("button", { name: "Add client" }).click();
    await expect(toast(admin, `Added ${name}`)).toBeVisible();
    await expect(
      admin
        .getByTestId(`msp-client-${name}`)
        .getByTestId("msp-client-policies"),
    ).toHaveText("Defaults");
  }

  // The defaults: the Business preset's policies on, the rest off.
  const defaults = admin.getByTestId("msp-default-policies");
  const row = (name: string) => defaults.getByTestId(`msp-policy-${name}`);
  await expect(
    row("Master password requirements").getByTestId("msp-policy-default"),
  ).toHaveText("On");
  await expect(
    row("Single organization").getByTestId("msp-policy-default"),
  ).toHaveText("On");
  await expect(
    row("Require two-step login").getByTestId("msp-policy-default"),
  ).toHaveText("Off");
  await expect(
    row("Remove Unlock with PIN").getByTestId("msp-policy-reach"),
  ).toHaveText("All 2 follow");
  await expect(row("Remove Unlock with PIN").getByTestId("msp-policy-own")).toHaveCount(0);

  // Baker Law turns on a policy in its own admin console. Its Policies page
  // says the MSP sets defaults, and the change makes it Baker Law's own.
  await admin
    .getByTestId("msp-client-Baker Law")
    .getByRole("link", { name: "Admin console" })
    .click();
  await expect(admin).toHaveURL(/#\/organizations\/[^/]+\/members/);
  const lawUrl = admin.url().replace(/\/members.*$/, "");
  await admin.goto(`${lawUrl}/settings/policies`);
  const note = admin.getByTestId("client-msp-policies");
  await expect(note).toContainText(
    "Northwind IT sets default policies for this organization.",
  );
  await expect(note).not.toContainText("Own settings here");
  await admin.getByRole("button", { name: /Remove Unlock with PIN/ }).click();
  await switchOn(admin.getByRole("switch", { name: "Enable policy" }));
  await admin.getByRole("button", { name: "Save", exact: true }).click();
  await expect(note).toContainText(
    "Own settings here: Remove Unlock with PIN.",
  );

  await admin.goto("/#/msp");
  await expect(
    admin
      .getByTestId("msp-client-Baker Law")
      .getByTestId("msp-client-policies"),
  ).toHaveText("1 own setting");
  await expect(
    row("Remove Unlock with PIN").getByTestId("msp-policy-own"),
  ).toContainText("Baker Law");
  await expect(
    row("Remove Unlock with PIN").getByTestId("msp-policy-reach"),
  ).toHaveText("1 follows, 1 has its own");

  // Turning on two-step login by default reaches both clients, after a
  // warning about who it revokes.
  await row("Require two-step login")
    .getByRole("button", { name: "Edit the default Require two-step login" })
    .click();
  const dialog = admin.getByRole("dialog");
  await expect(dialog.getByTestId("default-policy-followers")).toContainText(
    "Saving changes this policy in the clients that follow the default and are checked here.",
  );
  for (const name of ["Acme Dental", "Baker Law"]) {
    await expect(dialog.getByRole("checkbox", { name })).toBeChecked();
  }
  await switchOn(dialog.getByRole("switch", { name: "Enable policy" }));
  await dialog.getByRole("button", { name: "Save default" }).click();
  await expect(admin.getByRole("dialog")).toContainText(
    "Turn on Require two-step login in 2 clients?",
  );
  await admin.getByRole("button", { name: "Turn it on" }).click();
  await expect(
    toast(admin, "Saved the default. Changed in Acme Dental and Baker Law."),
  ).toBeVisible();
  await expect(
    row("Require two-step login").getByTestId("msp-policy-default"),
  ).toHaveText("On");

  // Baker Law goes back to the default for its own setting.
  await row("Remove Unlock with PIN")
    .getByRole("button", {
      name: "Use the default Remove Unlock with PIN in Baker Law",
    })
    .click();
  await admin.getByRole("button", { name: "Use default", exact: true }).click();
  await expect(toast(admin, "Changed in Baker Law.")).toBeVisible();
  await expect(
    row("Remove Unlock with PIN").getByTestId("msp-policy-reach"),
  ).toHaveText("All 2 follow");
  await expect(
    admin
      .getByTestId("msp-client-Baker Law")
      .getByTestId("msp-client-policies"),
  ).toHaveText("Defaults");

  // A changed default can leave a following client as it is: unchecked, Baker
  // Law keeps what it has, which becomes its own setting.
  await row("Remove Unlock with PIN")
    .getByRole("button", { name: "Edit the default Remove Unlock with PIN" })
    .click();
  const pin = admin.getByRole("dialog");
  await switchOn(pin.getByRole("switch", { name: "Enable policy" }));
  await pin.getByRole("checkbox", { name: "Baker Law" }).uncheck();
  await pin.getByRole("button", { name: "Save default" }).click();
  await expect(
    toast(admin, "Saved the default. Changed in Acme Dental. Baker Law kept its own setting."),
  ).toBeVisible();
  await expect(row("Remove Unlock with PIN").getByTestId("msp-policy-own")).toContainText("Baker Law");
  await expect(
    admin.getByTestId("msp-client-Baker Law").getByTestId("msp-client-policies"),
  ).toHaveText("1 own setting");

  const activity = admin.getByTestId("msp-activity");
  await expect(activity).toContainText(
    `${adminUser.email} set the default Require two-step login to on: 2 clients changed`,
  );
  await expect(activity).toContainText(
    `${adminUser.email} put Baker Law back on the default Remove Unlock with PIN`,
  );
  await adminContext.close();
});

test("an MSP admin requires a default for every client: it reaches a client with its own setting, is locked in that client, and turned off, lists who had their own", async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const adminUser = webUserFor("msp-admin-required", testInfo.repeatEachIndex);
  await signUpWithAuthenticator(admin, adminUser);
  await admin.goto("/#/msp");
  await admin.getByRole("textbox", { name: "Your MSP's name" }).fill("Northwind IT");
  await admin.getByRole("button", { name: "Create MSP" }).click();
  for (const name of ["Acme Dental", "Baker Law"]) {
    await admin.getByRole("textbox", { name: "New client's name" }).fill(name);
    await admin.getByRole("button", { name: "Add client" }).click();
    await expect(toast(admin, `Added ${name}`)).toBeVisible();
  }
  const defaults = admin.getByTestId("msp-default-policies");
  const row = (name: string) => defaults.getByTestId(`msp-policy-${name}`);
  const single = row("Single organization");
  await expect(single.getByTestId("msp-policy-default")).toHaveText("On");
  await expect(single.getByTestId("msp-policy-reach")).toHaveText("All 2 follow");

  // Baker Law turns off single organization in its own admin console: its
  // own setting.
  await admin.getByTestId("msp-client-Baker Law").getByRole("link", { name: "Admin console" }).click();
  await expect(admin).toHaveURL(/#\/organizations\/[^/]+\/members/);
  const lawPolicies = admin.url().replace(/\/members.*$/, "/settings/policies");
  await admin.goto(lawPolicies);
  await admin.getByRole("button", { name: /Single organization/ }).click();
  await admin.getByRole("checkbox", { name: "Turn on" }).uncheck();
  await admin.getByRole("button", { name: "Save", exact: true }).click();
  const note = admin.getByTestId("client-msp-policies");
  await expect(note).toContainText("Own settings here: Single organization.");
  await expect(admin.getByTestId("client-msp-required")).toHaveCount(0);

  await admin.goto("/#/msp");
  await expect(single.getByTestId("msp-policy-reach")).toHaveText("1 follows, 1 has its own");
  await expect(single.getByTestId("msp-policy-own")).toContainText("Baker Law");

  // Requiring it: the dialog says it replaces Baker Law's own setting, and
  // before saving, which clients change, with what turning it on does.
  await single.getByRole("button", { name: "Edit the default Single organization" }).click();
  const dialog = admin.getByRole("dialog");
  await dialog.getByRole("radio", { name: /Required for every client/ }).check();
  await expect(dialog.getByTestId("default-policy-required")).toContainText(
    "That includes the clients with their own setting: Baker Law.",
  );
  await expect(dialog.getByTestId("default-policy-followers")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Save default" }).click();
  const confirm = admin.getByRole("dialog").filter({ hasText: "Require Single organization for every client?" });
  await expect(confirm).toContainText("This changes it in Baker Law.");
  await expect(confirm).toContainText("belong to another organization are revoked");
  await expect(confirm).toContainText(
    "Nobody can change it in a client's admin console until you stop requiring it.",
  );
  await admin.getByRole("button", { name: "Require it" }).click();
  await expect(toast(admin, "Required for every client. Changed in Baker Law.")).toBeVisible();
  await expect(single.getByTestId("msp-policy-required")).toHaveText("Required");
  await expect(single.getByTestId("msp-policy-reach")).toHaveText("all 2 clients");
  await expect(single.getByTestId("msp-policy-own")).toHaveCount(0);
  await expect(admin.getByTestId("msp-client-Baker Law").getByTestId("msp-client-policies")).toHaveText(
    "Defaults",
  );

  // Baker Law's Policies page: required by Northwind IT, with a lock, and
  // the row doesn't open. The note says what that means.
  await admin.goto(lawPolicies);
  const locked = admin.getByTestId("keykeeper-required-policy").filter({ hasText: "Single organization" });
  await expect(locked).toContainText("Required by Northwind IT");
  await expect(locked).toContainText("On");
  await expect(admin.getByRole("button", { name: /Single organization/ })).toHaveCount(0);
  await expect(admin.getByTestId("client-msp-required")).toContainText(
    "Northwind IT requires a policy for every client",
  );
  await expect(admin.getByTestId("client-msp-required")).toContainText("only Northwind IT's console does");
  // Other policies still open as before.
  await expect(admin.getByRole("button", { name: /Remove Unlock with PIN/ })).toBeVisible();

  // Turning it off: the dialog names the clients that had their own setting,
  // which keep the required one.
  await admin.goto("/#/msp");
  await single.getByRole("button", { name: "Edit the default Single organization" }).click();
  const off = admin.getByRole("dialog");
  await expect(off.getByRole("radio", { name: /Required for every client/ })).toBeChecked();
  await off.getByRole("radio", { name: /^Default/ }).check();
  const hadOwn = off.getByTestId("default-policy-had-own");
  await expect(hadOwn).toContainText(
    "These clients had their own setting before you required it. They keep the required setting; change it in their admin console if one should go back.",
  );
  await expect(hadOwn.getByRole("listitem")).toHaveText(["Baker Law"]);
  await off.getByRole("button", { name: "Save default" }).click();
  await expect(
    toast(admin, "Stopped requiring it. Every client keeps its setting and follows the default."),
  ).toBeVisible();
  await expect(single.getByTestId("msp-policy-required")).toHaveCount(0);
  await expect(single.getByTestId("msp-policy-reach")).toHaveText("All 2 follow");

  // Unlocked again in Baker Law.
  await admin.goto(lawPolicies);
  await expect(admin.getByRole("button", { name: /Single organization/ })).toBeVisible();
  await expect(admin.getByTestId("keykeeper-required-policy")).toHaveCount(0);

  await admin.goto("/#/msp");
  const activity = admin.getByTestId("msp-activity");
  await expect(activity).toContainText(
    `${adminUser.email} required Single organization for every client: 1 client changed`,
  );
  await expect(activity).toContainText(
    `${adminUser.email} stopped requiring Single organization for every client: 1 client had its own setting before`,
  );
  await adminContext.close();
});
