// A company with its own IT, in the web vault: "New organization" for a
// business starts with the Business preset and an install command on the
// organization's Settings page; someone who joins with it gets in without
// anyone confirming them. See DESIGN.md, "A company's own IT".
import { generateKeyPairSync } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { Api } from "./api/support";
import { confirmMember, signUp, webUserFor } from "./support/web";

/** A toast message. Toasts here have no ARIA role, so find them by text. */
const toast = (page: Page, text: string) => page.getByText(text, { exact: true });

async function newOrganization(page: Page, name: string, kind: RegExp) {
  await page.goto("/#/create-organization");
  await page.getByRole("textbox", { name: /Organization name/ }).fill(name);
  await page.getByRole("radio", { name: kind }).check();
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(toast(page, `Created ${name}`)).toBeVisible();
  await page.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  return page.url().replace(/\/members.*$/, "");
}

/** The organization's Settings page, opened afresh. */
async function openSettings(page: Page, org: string) {
  await page.goto("/#/vault");
  await page.goto(`${org}/settings`);
  await expect(page.getByRole("heading", { name: "Install command" })).toBeVisible();
}

test("a business's organization starts with its policies and an install command, and people who join with it get in once approved", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(150_000);
  await signUp(page, webUserFor("own-it-owner", testInfo.repeatEachIndex));
  await page.goto("/#/create-organization");
  await expect(page.getByRole("radio", { name: /A business/ })).toBeChecked();
  const org = await newOrganization(page, "Northpoint Logistics", /A business/);

  // The Business preset's policies are on.
  await page.goto(`${org}/settings/policies`);
  for (const policy of [/^Single organization .* On$/, /^Master password requirements .* On$/]) {
    await expect(page.getByRole("button", { name: policy })).toBeVisible();
  }

  // The install command, ready to copy.
  await openSettings(page, org);
  const section = page.getByTestId("org-install");
  const command = section.getByTestId("org-install-command");
  await expect(command).toContainText("-EnrollmentToken");
  const token = /-EnrollmentToken '([A-Za-z0-9_-]{43})'/.exec((await command.textContent())!)![1];
  await expect(section.getByTestId("org-install-joins")).toContainText("0 people have joined with this command.");

  // Someone runs it and signs in. Their public key is real: the owner's web
  // vault encrypts the org key to it when it confirms them.
  const api = new Api(request);
  const { publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  const person = await api.account("Dana Fox", `dana.fox-${Date.now()}@api.example.test`, publicKey.toString("base64"));
  const joined = await api.call(person, "POST", "/api/keykeeper/enrollment/join", { token });
  expect(joined.status, JSON.stringify(joined.body)).toBe(200);

  // The command isn't limited to email domains, so the owner approves them
  // on the Members page, and they have the Everyone collection.
  const orgId = /organizations\/([0-9a-f-]{36})/.exec(org)![1];
  await page.goto("/#/vault");
  await page.goto(`${org}/members`);
  await confirmMember(page, person.email);
  await expect.poll(() => api.orgsOf(person)).toEqual([orgId]);
  expect((await api.call(person, "GET", "/api/collections")).body.data).toHaveLength(1);

  // Replacing the token changes the command.
  await openSettings(page, org);
  await expect(section.getByTestId("org-install-joins")).toContainText("1 person has joined with this command.");
  await section.getByRole("button", { name: "Replace token" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Replace token" }).click();
  await expect(toast(page, "Replaced the install token")).toBeVisible();
  await expect(command).not.toContainText(token);
});

test("a family's organization has no policies, and its owner can still make an install command", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await signUp(page, webUserFor("own-it-family", testInfo.repeatEachIndex));
  const org = await newOrganization(page, "Rivera Family", /A family or a group/);

  await page.goto(`${org}/settings/policies`);
  await expect(page.getByRole("button", { name: /^Single organization .* Off$/ })).toBeVisible();

  await openSettings(page, org);
  const section = page.getByTestId("org-install");
  await section.getByRole("button", { name: "Create install command" }).click();
  await expect(toast(page, "Created the install command")).toBeVisible();
  await expect(section.getByTestId("org-install-command")).toContainText("-EnrollmentToken");
});
