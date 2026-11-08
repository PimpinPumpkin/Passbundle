// Settings, Joining and security (DESIGN.md, "A company's own IT"): a
// company's own IT admin, who isn't an owner, opens what the server lets
// owners and admins manage there: two-step login for admins, how people join,
// the install command, and script access. Organization info stays the
// owners'. Nothing the page loads is refused, since the web vault signs out on
// a 401 or 403. A custom role that manages policies has the Settings menu but
// not this page, and its address sends them away. Real keys throughout.
import { expect, test, type Page } from "@playwright/test";

import { brand } from "../paths.mjs";

import {
  acceptRole,
  chooseRole,
  reloadVault,
  signUpWithAuthenticator,
  webUserFor,
} from "./support/web";

/** A toast message. Toasts here have no ARIA role, so find them by text. */
const toast = (page: Page, text: string) => page.getByText(text, { exact: true });

/** Every API call a page made that was refused with a 401 or 403. */
function refusedCalls(page: Page) {
  const refused: string[] = [];
  page.on("response", (response) => {
    if ([401, 403].includes(response.status()) && response.url().includes("/api/")) {
      refused.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
  return refused;
}

async function invite(owner: Page, email: string, role: "Admin" | "Custom", permission?: string) {
  await owner.getByRole("button", { name: "Invite member" }).click();
  const dialog = owner.getByRole("dialog", { name: /Invite member/ });
  await dialog.getByRole("textbox", { name: /Email/ }).fill(email);
  await chooseRole(dialog, role);
  if (permission) {
    await dialog.getByRole("checkbox", { name: permission }).check();
  }
  await dialog.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(dialog).toBeHidden();
}

test("a company's admin, not only its owners, opens Joining and security: two-step login for admins, joining, the install command, and script access", async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const index = testInfo.repeatEachIndex;
  // The admin and a custom role that manages policies, signed up first so
  // their invitations join them at once (this test server sends no email).
  const adminUser = webUserFor("company-it-admin", index);
  const admin = await (await browser.newContext()).newPage();
  await signUpWithAuthenticator(admin, adminUser);
  const policiesUser = webUserFor("company-policies", index);
  const policies = await (await browser.newContext()).newPage();
  await signUpWithAuthenticator(policies, policiesUser);

  const ownerUser = webUserFor("company-it-owner", index);
  const owner = await (await browser.newContext()).newPage();
  await signUpWithAuthenticator(owner, ownerUser);
  await owner.goto("/#/create-organization");
  await owner.getByRole("textbox", { name: /Organization name/ }).fill("Litware Clinic");
  await owner.getByRole("radio", { name: /A business/ }).check();
  await owner.getByRole("button", { name: "Create organization" }).click();
  await owner.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  const org = owner.url().replace(/\/members.*$/, "");
  await invite(owner, adminUser.email, "Admin");
  await invite(owner, policiesUser.email, "Custom", "Manage policies");
  await acceptRole(admin);
  await acceptRole(policies);
  // The owner's web vault lets them in on its own when it opens Members.
  await owner.goto("/#/vault");
  await owner.goto(`${org}/members`);
  for (const email of [adminUser.email, policiesUser.email]) {
    const row = owner.getByRole("row").filter({ hasText: email });
    await expect(row).toBeVisible();
    await expect(row.getByText("Needs confirmation")).toHaveCount(0, { timeout: 30_000 });
  }

  // The admin's Settings menu has Joining and security, not Organization
  // info, and the page has all four parts.
  const refused = refusedCalls(admin);
  await reloadVault(admin);
  await admin.goto(`${org}/settings`);
  await expect(admin.getByRole("link", { name: "Policies" })).toBeVisible();
  await expect(admin.getByRole("link", { name: "Organization info" })).toHaveCount(0);
  await admin.getByRole("link", { name: "Joining and security" }).click();
  await expect(admin).toHaveURL(/\/settings\/joining$/);
  await expect(admin.getByRole("heading", { name: "Joining and security" })).toBeVisible();
  const twoStep = admin.getByTestId("admin-two-step");
  await expect(
    twoStep.getByRole("checkbox", { name: "Require two-step login for admins" }),
  ).toBeChecked();
  await expect(admin.getByTestId("script-access").getByText("No tokens yet.")).toBeVisible();

  // The install command, for the computers they choose.
  const install = admin.getByTestId("org-install");
  const command = install.getByTestId("org-install-command");
  await expect(command).toHaveText(
    new RegExp(
      `^\\.\\\\${brand.installScript.replace(".", "\\.")} -ServerUrl 'https://127\\.0\\.0\\.1:\\d+' -EnrollmentToken '[A-Za-z0-9_-]{43}' -JoinSecret '[A-Za-z0-9_-]{43}' -OrgKey '[A-Za-z0-9_-]{43}'$`,
    ),
  );
  await install.getByTestId("org-install-platform").getByText("Mac", { exact: true }).click();
  await expect(command).toHaveText(
    /^\.\/make-profile\.sh --server-url '[^']+' --enrollment-token '[A-Za-z0-9_-]{43}' --join-secret '[A-Za-z0-9_-]{43}' --org-key '[A-Za-z0-9_-]{43}' > \S+\.mobileconfig$/,
  );
  await expect(install.getByTestId("org-install-phrase")).toContainText(
    "People who join see the organization's fingerprint phrase",
  );

  // How people join: the admin asks for approval, and it's saved.
  const joining = admin.getByTestId("org-joining");
  await joining
    .getByRole("checkbox", { name: "Let people in when they accept an invitation" })
    .uncheck();
  await joining.getByRole("button", { name: "Save" }).click();
  await expect(toast(admin, "Saved how people join")).toBeVisible();
  await expect(joining.getByTestId("org-joining-source")).toContainText(
    "This organization's own setting.",
  );
  expect(refused).toEqual([]);

  // The owner sees it there too; Organization info is still theirs.
  await owner.goto("/#/vault");
  await owner.goto(`${org}/settings/joining`);
  await expect(
    owner
      .getByTestId("org-joining")
      .getByRole("checkbox", { name: "Let people in when they accept an invitation" }),
  ).not.toBeChecked();
  await owner.getByRole("link", { name: "Organization info" }).click();
  await expect(owner).toHaveURL(/\/settings\/account$/);
  await expect(owner.getByTestId("org-install")).toHaveCount(0);

  // A custom role that manages policies: Settings, but not this page, which
  // the server wouldn't answer for them; its address sends them away.
  const policiesRefused = refusedCalls(policies);
  await reloadVault(policies);
  await policies.goto(`${org}/settings/policies`);
  await expect(policies.getByRole("link", { name: "Policies" })).toBeVisible();
  await expect(policies.getByRole("link", { name: "Joining and security" })).toHaveCount(0);
  await policies.goto(`${org}/settings/joining`);
  await expect(policies).not.toHaveURL(/\/settings\/joining/);
  await expect(policies.getByTestId("joining-security")).toHaveCount(0);
  expect(policiesRefused).toEqual([]);
});
