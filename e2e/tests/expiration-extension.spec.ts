// The extension's item list flags items that expire soon.
import { createAccount, expect, logInPopup, openPopup, test, userFor } from "./support/extension";
import { newItem } from "./support/web";

test("the popup's item list flags an item that expires soon", async ({ context, extensionId }, testInfo) => {
  const user = userFor("expires-ext", testInfo.repeatEachIndex);
  const web = await createAccount(context, user);
  await newItem(web, "Login");
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

test("the extension reminds once, on the device, when an item is about to expire", async ({
  context,
  extensionId,
}, testInfo) => {
  const user = userFor("expires-remind", testInfo.repeatEachIndex);
  const web = await createAccount(context, user);
  await newItem(web, "Login");
  const dialog = web.getByRole("dialog", { name: "New Login" });
  await dialog.getByRole("textbox", { name: /Item name/ }).fill("Example certificate");
  const inFiveDays = new Date();
  inFiveDays.setUTCDate(inFiveDays.getUTCDate() + 5);
  await dialog.getByTestId("keykeeper-expires").fill(inFiveDays.toISOString().slice(0, 10));
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await web.close();
  await logInPopup(await openPopup(context, extensionId), user);

  const result = await context.serviceWorkers()[0].evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reminders = (self as any).bitwardenMain.keykeeperExpirationReminders;
    const alarm = await chrome.alarms.get("keykeeper-expiration-reminders");
    const first: string[] = await reminders.check();
    const second: string[] = await reminders.check();
    const shown = Object.keys(await chrome.notifications.getAll());
    return { periodInMinutes: alarm?.periodInMinutes, first, second, shown };
  });

  // A check every six hours, one notification, and no repeat for the same step.
  expect(result.periodInMinutes).toBe(360);
  expect(result.first).toEqual(["Example certificate: expires in 5 days"]);
  expect(result.second).toEqual([]);
  expect(result.shown.filter((id) => id.startsWith("keykeeper-expiration-reminders-"))).toHaveLength(1);
});
