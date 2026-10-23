// The Provisioning page (DESIGN.md, "Provisioning from Entra ID"): an owner
// makes the token Microsoft Entra ID uses, shown once; Entra's request adds
// someone; the owner lets them in from the page, and their own web vault then
// confirms them in the background with the organization's real key. The SCIM
// requests stand in for Entra's, in the shapes Microsoft documents.
import { expect, test, type Page } from "@playwright/test";

import { signUp, webUserFor } from "./support/web";

const toast = (page: Page, text: string) => page.getByText(text, { exact: true });

async function createOrganization(owner: Page, name: string): Promise<string> {
  await owner.goto("/#/create-organization");
  await owner.getByRole("textbox", { name: /Organization name/ }).fill(name);
  await owner.getByRole("radio", { name: /A family or a group/ }).check();
  await owner.getByRole("button", { name: "Create organization" }).click();
  await expect(toast(owner, `Created ${name}`)).toBeVisible();
  await owner.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  return /organizations\/([0-9a-f-]{36})/.exec(owner.url())![1];
}

test("an owner connects Entra, and lets in the person it adds", async ({ browser, request, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const index = testInfo.repeatEachIndex;
  // The person Entra will add, signed up already: this server sends no
  // email, so their invitation is accepted at once.
  const newHire = webUserFor("provisioned-hire", index);
  const hire = await (await browser.newContext()).newPage();
  await signUp(hire, newHire);

  const owner = await (await browser.newContext()).newPage();
  await signUp(owner, webUserFor("provisioning-owner", index));
  const orgId = await createOrganization(owner, "Lakeside Clinic");

  // Settings, then Provisioning.
  await owner.goto(`/#/organizations/${orgId}/settings/policies`);
  await owner.getByRole("link", { name: "Provisioning" }).click();
  await owner.waitForURL(/settings\/provisioning/);
  const page = owner.getByTestId("provisioning");
  /** Opens the page afresh: a reload or a same-route goto keeps it as it was. */
  const openPage = async () => {
    await owner.goto("/#/vault");
    await expect(owner.getByRole("heading", { name: "All items" })).toBeVisible();
    await owner.goto(`/#/organizations/${orgId}/settings/provisioning`);
    await expect(page.getByTestId("provisioning-url")).toBeVisible();
  };
  await expect(page.getByTestId("provisioning-url")).toHaveText(`${baseURL}/scim/v2/${orgId}`);
  await expect(page.getByTestId("provisioning-steps")).toContainText("Create your own application");
  await page.getByRole("button", { name: "Create token" }).click();
  const shown = page.getByTestId("provisioning-token");
  await expect(shown).toHaveText(/^pbscim1_[A-Za-z0-9_-]{43}$/);
  const token = (await shown.textContent())!.trim();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(shown).toHaveCount(0);
  await expect(page.getByTestId("provisioning-token-info")).toContainText("Not used yet.");

  // Entra adds them.
  const created = await request.fetch(`/scim/v2/${orgId}/Users`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/scim+json" },
    data: JSON.stringify({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      externalId: `lakeside-${index}`,
      userName: `hire-${index}@lakeside.onmicrosoft.com`,
      active: true,
      emails: [{ primary: true, type: "work", value: newHire.email }],
      name: { givenName: "New", familyName: "Hire" },
    }),
  });
  expect(created.status(), await created.text()).toBe(201);

  // The page lists them as waiting, and the token as used. Nothing shows it again.
  await openPage();
  await expect(page.getByTestId("provisioning-token-info")).toContainText("Last sync");
  await expect(page.getByTestId("provisioning-token")).toHaveCount(0);
  const waiting = page.getByTestId("provisioning-waiting");
  await expect(waiting).toContainText(newHire.email);
  await expect(waiting).toContainText("has joined");
  await expect(page.getByRole("checkbox", { name: `Let in ${newHire.email}` })).toBeChecked();
  await page.getByRole("button", { name: "Let them in" }).click();
  await expect(toast(owner, `Letting in ${newHire.email}`)).toBeVisible();
  await expect(page.getByTestId("provisioning-waiting")).toHaveCount(0);

  // The owner's web vault lets them in: no Confirm clicked.
  await expect(async () => {
    await owner.goto("/#/vault");
    await owner.goto(`/#/organizations/${orgId}/members`);
    const row = owner.getByRole("row").filter({ hasText: newHire.email });
    await expect(row).toBeVisible({ timeout: 5_000 });
    await expect(row.getByText("Needs confirmation")).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout: 60_000, intervals: [3_000] });
  await hire.goto("/#/vault");
  await expect(hire.getByRole("button", { name: "Lakeside Clinic" }).first()).toBeVisible({ timeout: 30_000 });

  // Replacing the token stops the old one; revoking stops provisioning.
  await openPage();
  await page.getByRole("button", { name: "Replace token" }).click();
  await owner.getByRole("dialog").getByRole("button", { name: "Replace token" }).click();
  await expect(page.getByTestId("provisioning-token")).toHaveText(/^pbscim1_/);
  const replaced = (await page.getByTestId("provisioning-token").textContent())!.trim();
  expect(replaced).not.toBe(token);
  const old = await request.fetch(`/scim/v2/${orgId}/Users`, { headers: { Authorization: `Bearer ${token}` } });
  expect(old.status()).toBe(401);
  await page.getByRole("button", { name: "Revoke" }).click();
  await owner.getByRole("dialog").getByRole("button", { name: "Revoke" }).click();
  await expect(toast(owner, "Revoked the provisioning token")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create token" })).toBeVisible();
  const gone = await request.fetch(`/scim/v2/${orgId}/Users`, { headers: { Authorization: `Bearer ${replaced}` } });
  expect(gone.status()).toBe(401);
});
