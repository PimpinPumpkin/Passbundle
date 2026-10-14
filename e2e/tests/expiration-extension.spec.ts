// The extension's item list flags items that expire soon.
import { createAccount, expect, logInPopup, openPopup, test, userFor } from "./support/extension";

test("the popup's item list flags an item that expires soon", async ({ context, extensionId }, testInfo) => {
  const user = userFor("expires-ext", testInfo.repeatEachIndex);
  const web = await createAccount(context, user);
  await web.getByRole("button", { name: "New", exact: true }).click();
  await web.getByRole("menuitem", { name: "Login" }).click();
  const dialog = web.getByRole("dialog", { name: "New Login" });
  await dialog.getByRole("textbox", { name: /Item name/ }).fill("Example API key");
  const inTwoDays = new Date();
  inTwoDays.setUTCDate(inTwoDays.getUTCDate() + 2);
  await dialog.getByTestId("keykeeper-expires").fill(inTwoDays.toISOString().slice(0, 10));
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await web.close();

  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, user);
  const row = popup.getByRole("button", { name: /Example API key/ });
  await expect(row.getByTestId("keykeeper-expiration-badge")).toHaveText("Expires in 2 days");
});
