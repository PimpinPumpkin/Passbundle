// Two-step login for admins in the browser extension (DESIGN.md, "Two-step
// login for admins"): the extension doesn't set it up. Someone whose role
// requires it and who hasn't set it up signs in, and the extension says who
// requires it and that it's set up in the web vault, which it offers to open.
import { createAccount, expect, openPopup, serverUrl, test, userFor } from "./support/extension";

test("the extension sends an owner who hasn't set up two-step login to the web vault", async ({
  context,
  extensionId,
}, testInfo) => {
  test.setTimeout(150_000);
  const user = userFor("ext-two-step-owner", testInfo.repeatEachIndex);
  // Someone without two-step login makes a business organization, which
  // requires it of its owners and admins. The web vault says what happens
  // first; once it's made, their session ends, at its next refresh.
  const web = await createAccount(context, user);
  await web.goto(`${serverUrl}/#/create-organization`);
  await web.getByRole("textbox", { name: /Organization name/ }).fill("Contoso Clinic");
  await web.getByRole("radio", { name: /A business/ }).check();
  await expect(web.getByTestId("create-org-two-step")).toContainText("you'll be signed out");
  await web.getByRole("button", { name: "Create organization" }).click();
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
