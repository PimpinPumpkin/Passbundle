// A shared folder's permissions, through the web vault (DESIGN.md, "Folders
// and permissions"). An owner makes a business organization, puts a login in
// its Everyone folder, and gives Dana a Custom grid there: see passwords and
// create items, nothing else. Dana's web vault then shows Everyone under the
// organization in the left menu and offers it in the Folder picker; her new
// login goes in, but the owner's login can't be edited, deleted, printed, or
// shown with its earlier versions, and the server refuses an edit sent
// anyway. The owner's Access page names Dana's grid. Runs on the test server
// with groups turned on.
import { expect, test, type Page } from "@playwright/test";

import { groupsServerPort } from "../paths.mjs";

import { confirmMember, menu, newItem, signUp, webUserFor, type WebUser } from "./support/web";

test.use({ baseURL: `https://127.0.0.1:${groupsServerPort}` });

/** Reloading locks the vault; unlock it again. */
async function unlock(page: Page, user: WebUser) {
  await page.reload();
  await page.getByRole("textbox", { name: /^Master password/ }).fill(user.password);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.waitForURL(/#\/vault/);
}

/** The web vault's own access token, from its latest API request. */
function tokenOf(page: Page) {
  let token = "";
  page.on("request", (request) => {
    const header = request.headers()["authorization"];
    if (header?.startsWith("Bearer ") && request.url().includes("/api/")) {
      token = header.slice("Bearer ".length);
    }
  });
  return () => token;
}

test("an owner gives someone a Custom grid in a shared folder, and the web vault and server hold them to it", async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const danaContext = await browser.newContext();
  const dana = await danaContext.newPage();
  const danaUser = webUserFor("grid-dana", testInfo.repeatEachIndex);
  await signUp(dana, danaUser);
  const danaToken = tokenOf(dana);

  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  await signUp(owner, webUserFor("grid-owner", testInfo.repeatEachIndex));

  // A business organization comes with Everyone and Admins.
  await owner.goto("/#/create-organization");
  await owner.getByRole("textbox", { name: /Organization name/ }).fill("Lakeside Clinic");
  await owner.getByRole("radio", { name: /A business/ }).check();
  await owner.getByRole("button", { name: "Create organization" }).click();
  await owner.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  const org = owner.url().replace(/\/members.*$/, "");

  await owner.getByRole("button", { name: "Invite member" }).click();
  const invite = owner.getByRole("dialog", { name: /Invite member/ });
  await invite.getByRole("textbox", { name: /Email/ }).fill(danaUser.email);
  await invite.getByRole("button", { name: "Save" }).click();
  await expect(invite).toBeHidden();
  await confirmMember(owner, danaUser.email);

  // The owner's login in Everyone, from the admin console's Shared folders.
  await owner.goto(`${org}/vault`);
  await owner.getByRole("button", { name: "Everyone", exact: true }).first().click();
  await expect(owner).toHaveURL(/collectionId=[0-9a-f-]{36}/);
  const everyoneId = /collectionId=([0-9a-f-]{36})/.exec(owner.url())![1];
  await owner.getByRole("button", { name: "New", exact: true }).click();
  await owner.getByRole("menuitem", { name: "Login" }).click();
  const login = owner.getByRole("dialog", { name: "New Login" });
  await login.getByRole("textbox", { name: /Item name/ }).fill("Clinic Wi-Fi");
  await login.getByRole("textbox", { name: "Password", exact: true }).fill("lakeside-guest-2026");
  await login.getByRole("button", { name: "Save" }).click();
  await expect(login).toBeHidden();
  await owner.getByRole("dialog", { name: "View Login" }).getByRole("button", { name: "Close" }).first().click();

  // Everyone's access: Dana, with Custom: see passwords and create items.
  await owner.getByRole("button", { name: "Edit shared folder" }).click();
  await owner.getByRole("menuitem", { name: "Access" }).click();
  const access = owner.getByRole("dialog", { name: /Edit shared folder/ });
  await access.getByRole("combobox", { name: /Select groups and members/ }).click();
  await owner.keyboard.type("grid-dana");
  await owner.getByRole("option", { name: new RegExp(danaUser.email) }).click();
  // Closing the list adds who was picked.
  await access.getByText(/Grant groups or members access/).click();
  const danaRow = access.getByRole("row").filter({ hasText: danaUser.email });
  await expect(danaRow).toBeVisible();
  // The presets, and Custom, which opens the grid under her row.
  await danaRow.getByRole("combobox").click();
  await expect(owner.getByRole("option")).toHaveText([
    "Can view",
    "Can view but not see passwords",
    "Can edit",
    "Can manage",
    "Custom",
  ]);
  await owner.getByRole("option", { name: "Custom" }).click();
  const grid = access.getByTestId("keykeeper-folder-grid");
  await expect(grid).toBeVisible();
  // Custom starts from Can view: see passwords, print, view item history.
  const box = (name: string) => grid.getByRole("checkbox", { name, exact: true });
  await expect(box("See passwords")).toBeChecked();
  await expect(box("Print")).toBeChecked();
  await box("Create items").check();
  await box("Print").uncheck();
  await box("View item history").uncheck();
  // Export needs see passwords, so it can't be on without it.
  await box("See passwords").uncheck();
  await box("Export").check();
  await expect(box("See passwords")).toBeChecked();
  await box("Export").uncheck();
  await access.getByRole("button", { name: "Save" }).click();
  await expect(access).toBeHidden();

  // Dana's web vault: Everyone under Lakeside Clinic, with the owner's login.
  await unlock(dana, danaUser);
  const folders = menu(dana).getByRole("group", { name: "Folders" });
  await expect(folders.getByRole("button", { name: "Lakeside Clinic", exact: true })).toBeVisible();
  await expect(folders.getByRole("button", { name: "Everyone", exact: true })).toBeVisible();
  await expect(folders.getByRole("button", { name: "Admins", exact: true })).toHaveCount(0);
  await folders.getByRole("button", { name: "Everyone", exact: true }).click();
  await dana.getByRole("row").filter({ hasText: "Clinic Wi-Fi" }).getByText("Clinic Wi-Fi", { exact: true }).click();
  const view = dana.getByRole("dialog", { name: "View Login" });
  await expect(view).toBeVisible();
  // No delete, print, or earlier versions for her. (Edit stays, for her own
  // folder and favorite only: upstream's partial edit.)
  await expect(
    view.getByTestId("delete-cipher-btn").and(dana.locator("[aria-disabled=true], [disabled]")),
  ).toHaveCount(1);
  await expect(view.getByTestId("keykeeper-print-item")).toHaveCount(0);
  await expect(view.getByText("Version history")).toHaveCount(0);
  await view.getByRole("button", { name: "Close" }).first().click();

  // A login of her own goes into Everyone, through the Folder picker.
  await newItem(dana, "Login");
  const mine = dana.getByRole("dialog", { name: "New Login" });
  await mine.getByRole("textbox", { name: /Item name/ }).fill("Front desk printer");
  await mine.getByTestId("keykeeper-folder-picker").click();
  // Grouped by owner: Personal and its folders, then Lakeside Clinic with the
  // shared folders she can add to (Everyone, not Admins).
  await expect(dana.getByRole("option")).toHaveText([
    "Personal",
    "No folder",
    "Lakeside Clinic",
    "Everyone",
  ]);
  await expect(dana.getByRole("option", { name: "Lakeside Clinic" })).toHaveClass(
    /ng-option-disabled/,
  );
  await dana.getByRole("option", { name: "Everyone" }).click();
  await mine.getByRole("button", { name: "Save" }).click();
  await expect(mine).toBeHidden();
  await dana.getByRole("dialog", { name: "View Login" }).getByRole("button", { name: "Close" }).first().click();
  await expect(dana.getByRole("row").filter({ hasText: "Front desk printer" })).toBeVisible();

  // The server refuses an edit of the owner's login, whatever the app shows.
  const sync = await dana.request.get("/api/sync?excludeDomains=true", {
    headers: { Authorization: `Bearer ${danaToken()}` },
  });
  const synced = await sync.json();
  const folder = synced.collections.find((c: { id: string }) => c.id === everyoneId);
  expect(folder.keykeeper).toMatchObject({ seePasswords: true, create: true, edit: false, delete: false });
  const wifi = synced.ciphers.find((c: { edit: boolean; collectionIds: string[] }) =>
    c.collectionIds.includes(everyoneId) && !c.edit,
  );
  const edited = await dana.request.put(`/api/ciphers/${wifi.id}`, {
    headers: { Authorization: `Bearer ${danaToken()}` },
    data: { ...wifi, encryptedFor: synced.profile.id },
  });
  expect(edited.status()).toBe(400);

  // The owner's Access page names her grid.
  await owner.goto(`${org}/access`);
  const danaAccess = owner.getByRole("row").filter({ hasText: danaUser.email });
  await expect(danaAccess.getByTestId("access-level")).toHaveText("Custom");
  await expect(danaAccess.getByTestId("access-capabilities")).toHaveText(
    "See passwords, Create items",
  );

  await danaContext.close();
  await ownerContext.close();
});
