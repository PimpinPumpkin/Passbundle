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

test("an MSP admin adds a client and a technician, and the technician gets in without a manual confirm", async ({
  browser,
}, testInfo) => {
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

  // Business defaults, applied without building any policies. Account
  // recovery is on too (the API and mail tests check it), but the server only
  // shows it when it can send email, and this test server sends none.
  await expect(client).toContainText("Business");
  await client.getByRole("link", { name: "Open" }).click();
  await expect(admin).toHaveURL(/#\/organizations\/[^/]+\/members/);
  await admin.goto(admin.url().replace(/\/members.*$/, "/settings/policies"));
  for (const policy of [
    /Master password requirements/,
    /^Single organization/,
  ]) {
    await expect(admin.getByRole("button", { name: policy })).toContainText(
      "On",
    );
  }
  await admin.goto("/#/msp");

  // The client's install command for the RMM, with its enrollment token.
  await admin
    .getByTestId("msp-client-Acme Dental")
    .getByRole("button", { name: "Install command" })
    .click();
  const command = admin.getByTestId("msp-install-command");
  const shape = new RegExp(
    `^\\.\\\\${brand.installScript.replace(".", "\\.")} -ServerUrl https://127\\.0\\.0\\.1:\\d+ -EnrollmentToken [A-Za-z0-9_-]{43}$`,
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

  // A technician: added to every client and confirmed by the console.
  await admin
    .getByRole("textbox", { name: "Email of someone to add" })
    .fill(techUser.email);
  await admin.getByRole("button", { name: "Add staff" }).click();
  await expect(toast(admin, "Confirmed 1 member")).toBeVisible();
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
