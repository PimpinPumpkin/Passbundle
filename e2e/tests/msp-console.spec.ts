// The MSP console in the web vault: set up an MSP, add a client, add a
// technician, and the technician gets into the client without anyone
// confirming them by hand. Both accounts are real, made through the UI, since
// confirming encrypts the org key to the technician's real public key.
import { expect, test, type Page } from "@playwright/test";

import { signUp, webUserFor } from "./support/web";

/** A toast message. Toasts here have no ARIA role, so find them by text. */
const toast = (page: Page, text: string) => page.getByText(text, { exact: true });

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
  await admin.getByRole("textbox", { name: "Your MSP's name" }).fill("Northwind IT");
  await admin.getByRole("button", { name: "Create MSP" }).click();
  await expect(admin.getByTestId("msp-name")).toContainText("Northwind IT");
  await expect(admin.getByTestId("msp-name")).toContainText("Admin");

  // A client, with its keys made in the browser.
  await admin.getByRole("textbox", { name: "New client's name" }).fill("Acme Dental");
  await admin.getByRole("button", { name: "Add client" }).click();
  await expect(toast(admin, "Added Acme Dental")).toBeVisible();
  const client = admin.getByTestId("msp-client-Acme Dental");
  await expect(client.getByRole("link", { name: "Open" })).toBeVisible();

  // A technician: added to every client and confirmed by the console.
  await admin.getByRole("textbox", { name: "Email of someone to add" }).fill(techUser.email);
  await admin.getByRole("button", { name: "Add staff" }).click();
  await expect(toast(admin, "Confirmed 1 member")).toBeVisible();
  await expect(admin.getByTestId(`msp-staff-${techUser.email}`)).toContainText("Technician");

  // The technician sees the console in their nav and can open the client.
  // Reloading locks the web vault, so unlock it again.
  await tech.reload();
  await tech.getByRole("textbox", { name: /^Master password/ }).fill(techUser.password);
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
