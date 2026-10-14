import { brand } from "../paths.mjs";

import { createAccount, expect, logInPopup, openPopup, test, userFor } from "./support/extension";

test("extension is named after our brand", async ({ context, extensionId }) => {
  const worker = context.serviceWorkers().find((w) => w.url().includes(extensionId))!;
  const name = await worker.evaluate(() => chrome.i18n.getMessage("extName"));
  expect(name).toBe(brand.nameFull);
});

test("popup shows our brand and no Bitwarden branding", async ({ context, extensionId }) => {
  const popup = await openPopup(context, extensionId);
  await expect(popup.getByRole("region", { name: `Welcome to ${brand.name}` })).toBeVisible();
  await expect(popup).toHaveTitle(brand.name);
  const text = (await popup.locator("body").innerText()).replaceAll(
    `Bitwarden Inc. and ${brand.name} contributors`,
    "",
  );
  expect(text).not.toContain("Bitwarden");
});

test("popup logs in to our server", async ({ context, extensionId }, testInfo) => {
  // Each run gets a fresh browser profile, so create this run's own account.
  // The repeat index keeps the address unique and still deterministic.
  const user = userFor("ext", testInfo.repeatEachIndex);
  await (await createAccount(context, user)).close();
  await logInPopup(await openPopup(context, extensionId), user);
});
