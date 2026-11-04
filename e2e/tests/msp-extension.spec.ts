// An MSP's background work in the browser extension: with no vault tab open,
// an MSP admin's extension confirms someone invited to a client by email
// (install command joins wait for approval unless the command is limited to
// email domains, which needs a server that sends email; the mail tests cover
// those), and brings the client's copy of a template (in the MSP's own
// organization) up to date after the admin edits it in the popup. Real keys throughout: the confirm encrypts
// the org key to the person's real public key, and the copy is encrypted for
// the client in the extension. See DESIGN.md, "MSP console" and "MSP templates".
import { generateKeyPairSync } from "node:crypto";

import type { Page } from "@playwright/test";

import { Api } from "./api/support";
import {
  createAccount,
  expect,
  logInPopup,
  openPopup,
  serverUrl,
  test,
  userFor,
} from "./support/extension";
import { giveAuthenticator } from "./support/two-step";
import { newTemplate, pick } from "./support/web";

/** A toast message. Toasts here have no ARIA role, so find them by text. */
const toast = (page: Page, text: string) => page.getByText(text, { exact: true });

test("with no vault tab open, an MSP admin's extension confirms someone invited to a client and updates the client's copy of a template", async ({
  context,
  extensionId,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const adminUser = userFor("msp-ext-admin", testInfo.repeatEachIndex);
  const web = await createAccount(context, adminUser);
  // An MSP's staff sign in with two-step login (DESIGN.md, "Two-step login for admins").
  await giveAuthenticator(request, adminUser);

  // An MSP with one client, and a template that applies to it.
  await web.goto(`${serverUrl}/#/msp`);
  await web.getByRole("textbox", { name: "Your MSP's name" }).fill("Northwind IT");
  await web.getByRole("button", { name: "Create MSP" }).click();
  await web.getByRole("textbox", { name: "New client's name" }).fill("Acme Dental");
  await web.getByRole("button", { name: "Add client" }).click();
  await expect(toast(web, "Added Acme Dental")).toBeVisible();

  // The template is in the MSP's own organization, never someone's own vault.
  await web.goto(`${serverUrl}/#/create-organization`);
  await web.getByRole("textbox", { name: /Organization name/ }).fill("Northwind Team");
  await web.getByRole("radio", { name: /A family or a group/ }).check();
  await web.getByRole("button", { name: "Create organization" }).click();
  await expect(toast(web, "Created Northwind Team")).toBeVisible();
  await web.goto(`${serverUrl}/#/vault`);
  await pick(web, "Northwind Team");
  await pick(web, "Default shared folder");
  await newTemplate(web, "notes");
  const editor = web.getByRole("dialog", { name: /^New/ });
  await editor.getByRole("textbox", { name: /Item name/ }).fill("Firewall");
  await editor.getByRole("button", { name: "Add field" }).click();
  const webAddField = web.getByRole("dialog", { name: "Add field" });
  await webAddField.getByRole("textbox", { name: /Field label/ }).fill("Management URL");
  await webAddField.getByRole("button", { name: "Add", exact: true }).click();
  await expect(webAddField).toBeHidden();
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toBeHidden();
  // Saving opens the item's view; close it.
  const view = web.getByRole("dialog", { name: /^View/ });
  await view.getByRole("button", { name: "Close" }).first().click();
  await expect(view).toBeHidden();

  await web.goto(`${serverUrl}/#/msp`);
  await web.getByRole("form", { name: "Add a template" }).getByRole("button", { name: "Add template" }).click();
  await expect(toast(web, "Firewall now applies to every client.")).toBeVisible();
  const row = web.getByTestId("msp-template-Firewall");
  await expect(row.getByTestId("msp-template-status")).toHaveText("Up to date");
  const editHref = await row.getByRole("link", { name: "Edit Firewall" }).getAttribute("href");
  const sourceId = new URLSearchParams(editHref!.split("?")[1]).get("itemId");
  expect(sourceId).toBeTruthy();

  // Someone with an account is invited to the client by email. This test
  // server sends no email, so the invitation counts as accepted at once, and
  // they wait for the org key.
  const api = new Api(request);
  const { publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  const person = await api.account("FrontDesk", undefined, publicKey.toString("base64"));
  await web.getByTestId("msp-client-Acme Dental").getByRole("link", { name: "Open" }).click();
  await expect(web).toHaveURL(/#\/organizations\/[^/]+\/members/);
  const orgId = /#\/organizations\/([^/]+)\//.exec(web.url())![1];
  await web.getByRole("button", { name: "Invite member" }).click();
  const invite = web.getByRole("dialog", { name: /Invite member/ });
  await invite.getByRole("textbox", { name: /Email/ }).fill(person.email);
  await invite.getByRole("button", { name: "Save" }).click();
  await expect(invite).toBeHidden();

  // From here on, no vault tab: only the extension.
  await web.close();
  expect(await api.orgsOf(person)).toEqual([]);
  const popup = await openPopup(context, extensionId);
  await logInPopup(popup, adminUser);
  const vaultUrl = popup.url();
  const worker = context.serviceWorkers()[0];
  const runWork = () =>
    worker.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (await (self as any).bitwardenMain.keykeeperMspWork.run()) as string[];
    });
  const alarm = await worker.evaluate(() => chrome.alarms.get("keykeeper-msp-work"));
  expect(alarm?.periodInMinutes).toBe(5);

  // The extension confirms them.
  await expect(async () => {
    expect(await runWork()).toEqual([]);
    expect(await api.orgsOf(person)).toEqual([orgId]);
  }).toPass({ timeout: 60_000, intervals: [2_000] });

  // The admin adds a field to the template in the popup.
  await popup.goto(
    `chrome-extension://${extensionId}/popup/index.html#/edit-cipher?cipherId=${sourceId}&type=2&isNew=false`,
  );
  await expect(popup.getByRole("textbox", { name: /Item name/ })).toHaveValue("Firewall");
  await popup.getByRole("button", { name: "Add field" }).click();
  const addField = popup.getByRole("dialog", { name: "Add field" });
  await addField.getByRole("textbox", { name: /Field label/ }).fill("Firmware version");
  await addField.getByRole("button", { name: "Add", exact: true }).click();
  await expect(addField).toBeHidden();
  await popup.getByRole("button", { name: "Save" }).click();
  await expect(toast(popup, "Item saved")).toBeVisible();

  // The extension updates the client's copy: the copy in Acme Dental, as the
  // extension decrypts it, has the new field.
  const copyFields = () =>
    worker.evaluate(async (clientId) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const main = (self as any).bitwardenMain;
      const userId = await new Promise<string>((resolve) =>
        main.accountService.activeAccount$.subscribe((a: { id: string }) => resolve(a.id)),
      );
      const items: { name: string; organizationId: string | null; fields?: { name: string }[] }[] =
        await main.cipherService.getAllDecrypted(userId);
      const copy = items.find((c) => c.name === "Firewall" && c.organizationId === clientId);
      return (copy?.fields ?? []).map((f) => f.name);
    }, orgId);
  await expect(async () => {
    expect(await runWork()).toEqual([]);
    expect(await copyFields()).toContain("Firmware version");
  }).toPass({ timeout: 60_000, intervals: [2_000] });
  // Starting a new item from it in the popup shows the new field too, offered
  // once, where the template is.
  await popup.goto(vaultUrl);
  await popup.getByRole("button", { name: /^\W*New$/ }).click();
  await popup.getByRole("menuitem", { name: "From template" }).click();
  await expect(popup.getByRole("button", { name: "Firewall", exact: true })).toHaveCount(1);
  await popup
    .getByRole("region", { name: "Northwind Team" })
    .getByRole("button", { name: "Firewall", exact: true })
    .click();
  await expect(popup.getByRole("textbox", { name: "Firmware version", exact: true })).toBeVisible();
});
