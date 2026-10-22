// The generator's settings follow someone to each of their devices (DESIGN.md,
// "Generator settings"). PassBundle's default is 20 characters of every kind,
// without look-alikes; a length chosen in the web vault is the length in the
// extension, which takes it from the server.
import { createAccount, expect, logInPopup, openPopup, serverUrl, test, userFor } from "./support/extension";

test.describe.configure({ timeout: 120_000 });

test("a length chosen in the web vault's generator is the extension's too", async ({
  context,
  extensionId,
}, testInfo) => {
  const user = userFor("generator-settings", testInfo.repeatEachIndex);
  const web = await createAccount(context, user);

  await web.goto(`${serverUrl}/#/tools/generator`);
  const length = web.getByRole("spinbutton", { name: "Length" });
  // PassBundle's default.
  await expect(length).toHaveValue("20");
  await expect(web.getByRole("checkbox", { name: "Include special characters" })).toBeChecked();
  await expect(web.getByRole("checkbox", { name: "Avoid ambiguous characters" })).toBeChecked();

  const saved = web.waitForResponse(
    (r) => r.url().endsWith("/api/keykeeper/settings") && r.request().method() === "PUT" && r.ok(),
  );
  await length.fill("31");
  await length.press("Tab");
  const sent = JSON.parse((await saved).request().postData() ?? "{}");
  // Only encrypted on its way to the server.
  expect(sent.data).toMatch(/^2\./);
  expect(sent.data).not.toContain("31");

  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, user);
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html#/tabs/generator`);
  await expect(popup.getByRole("spinbutton", { name: "Length" })).toHaveValue("31", {
    timeout: 20_000,
  });
});
