// The extension's item list flags items that expire soon.
import {
  createAccount,
  expect,
  logInPopup,
  openPopup,
  serverUrl,
  test,
  userFor,
} from "./support/extension";
import { newItem } from "./support/web";

test("the popup's item list flags an item that expires soon", async ({ context, extensionId }, testInfo) => {
  const user = userFor("expires-ext", testInfo.repeatEachIndex);
  const web = await createAccount(context, user);
  await newItem(web, "Login");
  const dialog = web.getByRole("dialog", { name: "Add login" });
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
  const dialog = web.getByRole("dialog", { name: "Add login" });
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
  // It says how many items, never which: the system shows it outside the vault.
  expect(result.periodInMinutes).toBe(360);
  expect(result.first).toEqual(["1 item expires soon"]);
  expect(result.second).toEqual([]);
  expect(result.shown.filter((id) => id.startsWith("keykeeper-expiration-reminders-"))).toHaveLength(1);
});

/** "YYYY-MM-DD" for today plus some days, in UTC like the test browser. */
function isoInDays(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Imports items into the web vault as Bitwarden (json). */
async function importItems(web: Awaited<ReturnType<typeof createAccount>>, items: object[]) {
  await web.goto(`${serverUrl}/#/tools/import`);
  await web.getByRole("combobox", { name: /File format/ }).click();
  await web.getByRole("option", { name: "Bitwarden (json)" }).click();
  await web
    .getByRole("textbox", { name: /copy\/paste the import file contents/ })
    .fill(JSON.stringify({ encrypted: false, folders: [], items }));
  await web.getByRole("button", { name: "Import", exact: true }).click();
  await web.getByRole("dialog", { name: "Data successfully imported" }).getByRole("button", { name: "Ok" }).click();
}

const note = (name: string, expires?: string, remind?: string) => ({
  type: 2,
  name,
  secureNote: { type: 0 },
  fields: [
    ...(expires ? [{ name: "keykeeper.expires", value: expires, type: 0, linkedId: null }] : []),
    ...(remind ? [{ name: "keykeeper.remind", value: remind, type: 0, linkedId: null }] : []),
  ],
});

test("the popup's Expiring soon chip lists what has expired or expires soon, and a card's badge from its month", async ({
  context,
  extensionId,
}, testInfo) => {
  const user = userFor("expires-chip", testInfo.repeatEachIndex);
  const web = await createAccount(context, user);
  const now = new Date();
  await importItems(web, [
    note("Payments API", isoInDays(5)),
    note("Domain renewal", isoInDays(90)),
    {
      type: 1,
      name: "Plain login",
      login: { username: "ana@example.test", password: "kq9#Vz!m2P@xL7&r-Wt4", uris: [] },
    },
    {
      type: 3,
      name: "Expiring card",
      card: {
        cardholderName: "Alice Example",
        number: "4111111111111111",
        expMonth: String(now.getUTCMonth() + 1),
        expYear: String(now.getUTCFullYear()),
        code: "123",
      },
    },
  ]);
  await web.close();

  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, user);
  const chips = popup.getByTestId("category-chip");
  await expect(chips.last()).toHaveText("Expiring soon");
  await expect(chips.last()).toHaveAttribute("data-category", "expiring");

  // The card's badge, from its expiry month, in the list.
  // The vault's own list, under any suggestions for the page in front.
  const list = popup.locator("#allItems");
  const card = list.getByRole("button", { name: /Expiring card/ });
  await expect(card.getByTestId("keykeeper-expiration-badge")).toHaveText(/^Expires (today|tomorrow|in \d+ days)$/);

  await chips.last().click();
  await expect(chips.last()).toHaveAttribute("aria-pressed", "true");
  await expect(list.getByTestId("item-name")).toHaveText(["Expiring card", "Payments API"], {
    useInnerText: true,
  });
  await chips.first().click();
  await expect(list.getByRole("button", { name: /Domain renewal/ })).toBeVisible();
});

test("an item's own reminder days decide when the extension reminds, and Don't remind me never does", async ({
  context,
  extensionId,
}, testInfo) => {
  const user = userFor("expires-days", testInfo.repeatEachIndex);
  const web = await createAccount(context, user);
  // In 20 days: the default would remind now (its 30-day step); 7 and 1 don't yet.
  // Expired, but not to be reminded about.
  await importItems(web, [note("Late renewal", isoInDays(20), "7,1"), note("Old badge", isoInDays(-3), "none")]);
  await web.close();
  await logInPopup(await openPopup(context, extensionId), user);

  const quiet = await context.serviceWorkers()[0].evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (self as any).bitwardenMain.keykeeperExpirationReminders.check();
  });
  expect(quiet).toEqual([]);

  // Thirteen days on, Late renewal reaches its 7-day step.
  const later = await context.serviceWorkers()[0].evaluate(async () => {
    const at = new Date(Date.now() + 13 * 24 * 60 * 60 * 1000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (self as any).bitwardenMain.keykeeperExpirationReminders.check(at);
  });
  expect(later).toEqual(["1 item expires soon"]);
});
