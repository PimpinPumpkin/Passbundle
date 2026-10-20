// Default policies in the MSP console: the defaults every client follows, a
// client's own setting made in its admin console (whose Policies page says
// the MSP sets defaults), a changed default reaching the clients that follow
// it, and a client put back on the default. See DESIGN.md, "Default policies".
import { expect, test, type Page } from "@playwright/test";

import { signUp, webUserFor } from "./support/web";

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
  await signUp(admin, adminUser);
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
    row("Remove Unlock with PIN").getByTestId("msp-policy-own"),
  ).toHaveText("None");

  // Baker Law turns on a policy in its own admin console. Its Policies page
  // says the MSP sets defaults, and the change makes it Baker Law's own.
  await admin
    .getByTestId("msp-client-Baker Law")
    .getByRole("link", { name: "Open" })
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
  await admin.getByRole("checkbox", { name: "Turn on" }).check();
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
  await dialog.getByRole("checkbox", { name: "Turn on" }).check();
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
    row("Remove Unlock with PIN").getByTestId("msp-policy-own"),
  ).toHaveText("None");
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
  await pin.getByRole("checkbox", { name: "Turn on" }).check();
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
