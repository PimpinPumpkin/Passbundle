// Two-step login for admins in the browser extension (DESIGN.md, "Two-step
// login for admins"): the extension doesn't set it up. Someone whose role
// requires it and who hasn't set it up signs in, and the extension says who
// requires it and that it's set up in the web vault, which it offers to open.
import { createAccount, expect, openPopup, serverUrl, test, userFor } from "./support/extension";
import { confirmWithPassword } from "./support/web";

test("the extension sends an owner who hasn't set up two-step login to the web vault", async ({
  context,
  extensionId,
}, testInfo) => {
  test.setTimeout(150_000);
  const user = userFor("ext-two-step-owner", testInfo.repeatEachIndex);
  // Someone without two-step login: a business, which requires it of its
  // owners and admins, asks them to set it up first (first-run.spec.ts), so
  // they make a group and require it of its admins themselves. That ends
  // their session, at its next refresh.
  const web = await createAccount(context, user);
  await web.goto(`${serverUrl}/#/create-organization`);
  await web.getByRole("textbox", { name: /Organization name/ }).fill("Contoso Clinic");
  await web.getByRole("radio", { name: /A family or a group/ }).check();
  await web.getByRole("button", { name: "Create organization" }).click();
  await web.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  const org = web.url().replace(/\/members.*$/, "");
  await web.goto(`${org}/settings/joining`);
  const card = web.getByTestId("admin-two-step");
  await card.getByRole("checkbox", { name: "Require two-step login for admins" }).check();
  await card.getByRole("button", { name: "Save" }).click();
  await confirmWithPassword(web, user.password);
  // The session can end before this page opens, which sends the web vault
  // to sign in first and interrupts the navigation: either way, it signs in.
  await web.goto(`${org}/members`).catch(() => {});
  await web.waitForURL(/#\/login/);
  await web.close();

  // Signing in as logInPopup does, up to the answer.
  const popup = await openPopup(context, extensionId);
  await expect(async () => {
    await popup.getByRole("button", { name: "Log in" }).click();
    await expect(popup).toHaveURL(/#\/login/, { timeout: 1000 });
  }).toPass();
  await popup.getByRole("button", { name: "My own server" }).click();
  await popup.getByRole("textbox", { name: "Server address" }).fill(serverUrl);
  await popup.getByLabel(/Email address/).fill(user.email);
  await popup.getByRole("button", { name: "Continue" }).click();
  await popup.getByRole("textbox", { name: /Master password/ }).fill(user.password);
  await popup.getByRole("button", { name: "Log in", exact: true }).click();
  const dialog = popup.getByRole("dialog", { name: /Set up two-step login/ });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toContainText("Two-step login is required for your role by Contoso Clinic");
  await expect(dialog).toContainText(serverUrl);
  // Nothing signed in.
  await expect(popup.getByRole("heading", { name: /Items/ })).toHaveCount(0);
  const opened = context.waitForEvent("page");
  await dialog.getByRole("button", { name: "Open the web vault" }).click();
  expect((await opened).url()).toContain("127.0.0.1");
});
