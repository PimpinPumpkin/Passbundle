// What the extension shows on each plan (DESIGN.md, "Plans and billing"): the
// attachments page opens for any item that has files, on any plan, so a file
// can be downloaded and removed, with adding off and the plain sentence
// without Premium; an item with no files and no right to add says the
// sentence instead of opening the page. The web vault's side is
// plans-ui.spec.ts. This file starts a server of its own that enforces plans,
// with the admin page on so the operator can set and take away plans.
import { brand, plansUiServerPort } from "../paths.mjs";

import {
  createAccount,
  expect,
  logInPopup,
  openPopup,
  test,
  userFor,
} from "./support/extension";
import { attachFile, type PlansServer, saveLogin, startPlansServer } from "./support/plans";
import { reloadVault } from "./support/web";

test.describe.configure({ mode: "serial" });

let enforced: PlansServer;

test.beforeAll(async ({ playwright }) => {
  enforced = await startPlansServer(playwright, plansUiServerPort, true);
});

test.afterAll(async () => {
  await enforced?.stop();
});

test("a file attached on Premium opens in the extension once the plan is taken away, and adding is off", async ({
  context,
  extensionId,
}, testInfo) => {
  test.setTimeout(180_000);
  const user = {
    ...userFor("plans-ext-files", testInfo.repeatEachIndex),
    email: `plans-ext-files-${testInfo.repeatEachIndex}-${Date.now()}@example.test`,
  };

  // On Premium, in the web vault, a file goes on one login; another has none.
  const web = await createAccount(context, user, enforced.url);
  await enforced.operator.givePremium(user.email);
  await reloadVault(web);
  await saveLogin(web, "Lease");
  await saveLogin(web, "Gym");
  await attachFile(web, "Lease", "lease.txt");
  await enforced.operator.takePlanAway(user.email);
  await web.close();

  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, user, enforced.url);
  // Opened again, as a popup is each time it's clicked.
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html#/tabs/settings`);
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html#/tabs/vault`);

  // The item with a file: its attachments page lists it, with no Upload and
  // the sentence where the file picker was.
  await popup.locator("#allItems bit-item").filter({ hasText: "Lease" }).getByText("Lease", { exact: true }).click();
  await expect(popup.getByRole("heading", { level: 1, name: "Lease" })).toBeVisible();
  await popup.getByTestId("keykeeper-edit").click();
  const opener = popup.locator("app-open-attachments");
  await expect(opener.locator("app-premium-badge")).toHaveCount(1);
  await opener.getByRole("button", { name: /Attachments/ }).click();
  await popup.waitForURL(/#\/attachments\?/);
  await expect(popup.getByTestId("file-name")).toHaveCount(1);
  await expect(popup.getByTestId("file-name")).toContainText("lease.txt");
  await expect(popup.getByTestId("keykeeper-attaching-off")).toContainText("Attaching files is part of Premium.");
  await expect(popup.getByTestId("keykeeper-attaching-off").getByRole("link", { name: "See pricing" })).toHaveAttribute(
    "href",
    `${brand.urls.website}/pricing/`,
  );
  await expect(popup.locator("bit-file-upload")).toHaveCount(0);
  await expect(popup.getByRole("button", { name: "Upload" })).toBeHidden();
  await expect(popup.getByRole("button", { name: "Download" })).toBeVisible();
  await expect(popup.getByRole("button", { name: "Delete attachment" })).toBeVisible();
  await popup.getByRole("button", { name: "Close", exact: true }).click();

  // The item with no files: the sentence, and the page doesn't open.
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html#/tabs/vault`);
  await popup.locator("#allItems bit-item").filter({ hasText: "Gym" }).getByText("Gym", { exact: true }).click();
  await expect(popup.getByRole("heading", { level: 1, name: "Gym" })).toBeVisible();
  await popup.getByTestId("keykeeper-edit").click();
  await popup.locator("app-open-attachments").getByRole("button", { name: /Attachments/ }).click();
  const notice = popup.getByTestId("keykeeper-plan-notice-dialog");
  await expect(notice).toContainText("Attaching files is part of Premium.");
  await expect(notice.getByRole("link", { name: "See pricing" })).toHaveAttribute(
    "href",
    `${brand.urls.website}/pricing/`,
  );
  await notice.getByRole("button", { name: "Close" }).click();
  await expect(notice).toBeHidden();
  await expect(popup).not.toHaveURL(/#\/attachments/);
});
