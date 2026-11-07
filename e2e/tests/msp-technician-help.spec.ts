// A technician's dead end in the MSP console, now with a next step
// (DESIGN.md, "Roles and permissions"): with no clients yet, it says who
// chooses their clients and whom to ask, and once they reach one, the way
// into it.
import { expect, test, type Page } from "@playwright/test";

import { reloadVault, signUpWithAuthenticator, webUserFor } from "./support/web";

/** A toast message. Toasts here have no ARIA role, so find them by text. */
const toast = (page: Page, text: string) => page.getByText(text, { exact: true });

test("a technician with no clients is told who chooses them and whom to ask, and then gets the client", async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  const techUser = webUserFor("help-tech", testInfo.repeatEachIndex);
  const tech = await (await browser.newContext()).newPage();
  await signUpWithAuthenticator(tech, techUser);

  const adminUser = webUserFor("help-admin", testInfo.repeatEachIndex);
  const admin = await (await browser.newContext()).newPage();
  await signUpWithAuthenticator(admin, adminUser);
  await admin.goto("/#/msp");
  await admin.getByRole("textbox", { name: "Your MSP's name" }).fill("Wingtip IT");
  await admin.getByRole("button", { name: "Create MSP" }).click();
  await expect(admin.getByTestId("msp-name")).toContainText("Wingtip IT");

  // The technician joins before there are any clients.
  await admin.getByRole("textbox", { name: "Email of someone to add" }).fill(techUser.email);
  await admin.getByRole("button", { name: "Add staff" }).click();
  await expect(toast(admin, `Invited ${techUser.email}`)).toBeVisible();
  const link = await admin.getByTestId("msp-invite-link").locator("pre").textContent();
  await tech.goto(link!.slice(link!.indexOf("/#/")));
  await tech.getByTestId("msp-invitation").getByRole("button", { name: "Join Wingtip IT" }).click();
  await expect(toast(tech, "You joined Wingtip IT")).toBeVisible();
  await expect(tech.getByTestId("msp-no-clients")).toHaveText(
    `You don't work in any of Wingtip IT's clients yet. An MSP admin chooses which clients each technician reaches: ask ${adminUser.name} to give you access.`,
  );
  await expect(tech.getByRole("textbox", { name: "New client's name" })).toHaveCount(0);

  // Once there's a client, they reach it (every client, by default), and its
  // admin console opens for them. A role with nothing in a client's admin
  // console gets plain words instead of that link (client-console.spec.ts in
  // the web vault; the console's own roles always have something there).
  await admin.goto("/#/vault");
  await admin.goto("/#/msp");
  await admin.getByRole("textbox", { name: "New client's name" }).fill("Acme Dental");
  await admin.getByRole("button", { name: "Add client" }).click();
  await expect(toast(admin, "Added Acme Dental")).toBeVisible();
  await reloadVault(tech);
  await tech.goto("/#/msp");
  const row = tech.getByTestId("msp-client-Acme Dental");
  await expect(row.getByRole("link", { name: "Admin console" })).toBeVisible();
  await expect(tech.getByTestId("msp-no-clients")).toHaveCount(0);
});
