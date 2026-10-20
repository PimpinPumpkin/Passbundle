// The MSP console limits a client's install command to email domains, on the
// server that sends email (the limit trusts verified emails only). What the
// limit does at a join is in join-notices.spec.ts.
import { expect, test, type Page } from "@playwright/test";

import { signUp, webUserFor } from "../support/web";

const toast = (page: Page, text: string) => page.getByText(text, { exact: true });

test("an MSP admin limits a client's install command to its email domains, and lifts it", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const admin = webUserFor("domains-admin", testInfo.repeatEachIndex);
  await signUp(page, admin);
  await page.goto("/#/msp");
  await page.getByRole("textbox", { name: "Your MSP's name" }).fill("Fabrikam IT");
  await page.getByRole("button", { name: "Create MSP" }).click();
  await page.getByRole("textbox", { name: "New client's name" }).fill("Acme Dental");
  await page.getByRole("button", { name: "Add client" }).click();
  await expect(toast(page, "Added Acme Dental")).toBeVisible();

  const open = () =>
    page.getByTestId("msp-client-Acme Dental").getByRole("button", { name: "Install command" }).click();
  await open();
  const panel = page.getByTestId("msp-install");
  await expect(panel).toContainText(
    "Anyone who has it can ask to join, and an owner or admin approves each one, so treat it like a password.",
  );
  const field = panel.getByRole("textbox", { name: "Only these email domains can join" });
  await expect(field).toHaveValue("");

  await field.fill("acme.test, @Branch.acme.test");
  await panel.getByRole("button", { name: "Save domains" }).click();
  await expect(
    toast(page, "Only acme.test or branch.acme.test accounts can join Acme Dental with the command"),
  ).toBeVisible();
  await expect(panel).toContainText(
    "Only acme.test or branch.acme.test accounts with a verified email can join with it.",
  );
  await expect(field).toHaveValue("acme.test branch.acme.test");

  // It's saved: closed and opened again, the panel shows it.
  await open();
  await open();
  await expect(page.getByTestId("msp-install").getByRole("textbox", { name: "Only these email domains can join" })).toHaveValue(
    "acme.test branch.acme.test",
  );

  // A typo is refused by name.
  await field.fill("acme");
  await panel.getByRole("button", { name: "Save domains" }).click();
  await expect(page.getByText('"acme" isn\'t an email domain, like example.com')).toBeVisible();

  await field.fill("");
  await panel.getByRole("button", { name: "Save domains" }).click();
  await expect(toast(page, "Anyone with the command can ask to join Acme Dental")).toBeVisible();
  await expect(panel).toContainText("Anyone who has it can ask to join");

  // Activity loads with the console; a page reload would lock the vault.
  await page.goto("/#/vault");
  await page.goto("/#/msp");
  const activity = page.getByTestId("msp-activity");
  await expect(activity).toContainText(
    `${admin.email} limited Acme Dental's install command to acme.test, branch.acme.test accounts`,
  );
  await expect(activity).toContainText(`${admin.email} let anyone with Acme Dental's install command join`);
});
