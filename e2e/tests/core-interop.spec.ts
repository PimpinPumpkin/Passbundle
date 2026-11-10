// Our own apps' core (passbundle-apps, docs/core.md) and the web vault read
// each other's items, with real keys on both sides: the web vault makes an
// account, an organization, and an item in each; the core opens them, then
// saves its own item in each, and the web vault shows them. Tier 1 builds the
// core's interop tool (KK_CORE_INTEROP); without it, this test is skipped.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { core, coreTool, serverCertificate } from "./support/core";
import { newItem, reloadVault, signUp, webUserFor } from "./support/web";

test.skip(!coreTool && !process.env.CI, "KK_CORE_INTEROP isn't set; tier 1 builds the core's interop tool");

const toast = (page: Page, text: string) => page.getByText(text, { exact: true });

async function createOrganization(owner: Page, name: string): Promise<string> {
  await owner.goto("/#/create-organization");
  await owner.getByRole("textbox", { name: /Organization name/ }).fill(name);
  await owner.getByRole("radio", { name: /A family or a group/ }).check();
  await owner.getByRole("button", { name: "Create organization" }).click();
  await expect(toast(owner, `Created ${name}`)).toBeVisible();
  await owner.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  return /organizations\/([0-9a-f-]{36})/.exec(owner.url())![1];
}

/** A login made in the web vault, from the page given (a vault or an organization's). */
async function webLogin(page: Page, at: string, item: { name: string; username: string; password: string; notes: string }) {
  await page.goto(at);
  await newItem(page, "Login");
  const dialog = page.getByRole("dialog", { name: "Add login" });
  await dialog.getByRole("textbox", { name: /Item name/ }).fill(item.name);
  await dialog.getByRole("textbox", { name: /Username/ }).fill(item.username);
  await dialog.getByLabel("Password", { exact: true }).fill(item.password);
  await dialog.getByRole("textbox", { name: /Notes/ }).fill(item.notes);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  // Saving a new item opens its view.
  const view = page.getByRole("dialog", { name: "View Login" });
  await view.getByRole("button", { name: "Close" }).first().click();
  await expect(view).toBeHidden();
}

/** Reloading the web vault syncs it. */
async function resync(page: Page) {
  await page.goto("/#/vault");
  await reloadVault(page);
}

test("the core and the web vault read each other's items, personal and an organization's", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const user = webUserFor("core-interop", testInfo.repeatEachIndex);
  await signUp(page, user);
  await webLogin(page, "/#/vault", {
    name: "From the web vault",
    username: "web@example.test",
    password: "not-a-real-password-web",
    notes: "Made by the web vault.",
  });
  const orgId = await createOrganization(page, "Contoso");
  await webLogin(page, `/#/organizations/${orgId}/vault`, {
    name: "Org item from the web vault",
    username: "web-org@example.test",
    password: "not-a-real-password-web-org",
    notes: "Made by the web vault, for Contoso.",
  });

  // The core opens what the web vault made, the organization's item with the
  // organization key it unwraps with the account's private key.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-interop-"));
  const cert = await serverCertificate(dir);
  const read = core(dir, cert, user, {
    name: "From the core",
    username: "core@example.test",
    password: "not-a-real-password-core",
    notes: "Made by the core.",
    uris: ["https://core.example.test"],
    fields: [{ name: "PIN", value: "2468", hidden: true }],
  });
  expect(read.saved).toBe(true);
  expect(read.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "From the web vault",
        username: "web@example.test",
        password: "not-a-real-password-web",
        notes: "Made by the web vault.",
        organizationId: null,
      }),
      expect.objectContaining({
        name: "Org item from the web vault",
        username: "web-org@example.test",
        password: "not-a-real-password-web-org",
        notes: "Made by the web vault, for Contoso.",
        organizationId: orgId,
      }),
    ]),
  );
  const again = core(dir, cert, user, {
    name: "Org item from the core",
    username: "core-org@example.test",
    password: "not-a-real-password-core-org",
    organizationId: orgId,
  });
  expect(again.saved).toBe(true);
  expect(again.items.map((i) => i.name)).toContain("From the core");

  // The web vault opens what the core made, every field as the core wrote it
  // (the password once shown: until then the field holds dots, and then it's
  // colored text rather than an input).
  await resync(page);
  const view = page.getByRole("dialog", { name: "View Login" });
  await page.getByText("From the core").first().click();
  await expect(view.getByRole("textbox", { name: "Username" })).toHaveValue("core@example.test");
  await view.getByRole("button", { name: "Toggle visibility" }).first().click();
  await expect(view.getByRole("textbox", { name: "Password" })).toContainText("not-a-real-password-core");
  await expect(view.getByRole("textbox", { name: "Website" })).toHaveValue(/core\.example\.test/);
  await expect(view.getByRole("textbox", { name: "Note" })).toHaveValue("Made by the core.");
  await expect(view.getByRole("textbox", { name: "PIN" })).toHaveValue("2468");
  await view.getByRole("button", { name: "Close" }).first().click();
  await expect(view).toBeHidden();

  await page.getByText("Org item from the core").first().click();
  await expect(view.getByRole("textbox", { name: "Username" })).toHaveValue("core-org@example.test");
  await view.getByRole("button", { name: "Toggle visibility" }).first().click();
  await expect(view.getByRole("textbox", { name: "Password" })).toContainText("not-a-real-password-core-org");
});

/** A file attached in the web vault, from the item's editor (Attachments). */
async function webAttach(page: Page, item: string, file: { name: string; contents: string }) {
  await resync(page);
  await page.getByText(item).first().click();
  const view = page.getByRole("dialog", { name: "View Login" });
  await view.getByRole("button", { name: "Edit" }).click();
  const editing = page.getByRole("dialog", { name: "Edit Login" });
  await editing.getByRole("button", { name: /^Attachments/ }).click();
  const attaching = page.getByRole("dialog", { name: "Add attachment" });
  await attaching.locator('input[type="file"]').setInputFiles({
    name: file.name,
    mimeType: "text/plain",
    buffer: Buffer.from(file.contents),
  });
  await attaching.getByRole("button", { name: "Upload" }).click();
  await expect(toast(page, "Attachment saved")).toBeVisible();
  await expect(attaching).toBeHidden();
  await editing.getByRole("button", { name: "Cancel" }).click();
  await expect(editing).toBeHidden();
}

/** What the web vault downloads and opens of an item's attachment. */
async function webDownload(page: Page, item: string, name: string): Promise<string> {
  await resync(page);
  await page.getByText(item).first().click();
  const view = page.getByRole("dialog", { name: "View Login" });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    view.getByRole("button", { name: `Download ${name}` }).click(),
  ]);
  const contents = fs.readFileSync(await download.path(), "utf8");
  await view.getByRole("button", { name: "Close" }).first().click();
  await expect(view).toBeHidden();
  return contents;
}

test("files the core attaches open in the web vault, and files the web vault attaches open in the core, personal and an organization's", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const user = webUserFor("core-attachments", testInfo.repeatEachIndex);
  await signUp(page, user);
  await webLogin(page, "/#/vault", {
    name: "Files from both",
    username: "files@example.test",
    password: "not-a-real-password-files",
    notes: "Holds files.",
  });
  const orgId = await createOrganization(page, "Contoso");
  await webLogin(page, `/#/organizations/${orgId}/vault`, {
    name: "Contoso files",
    username: "files@contoso.example.test",
    password: "not-a-real-password-contoso-files",
    notes: "Holds Contoso's files.",
  });
  await webAttach(page, "Files from both", { name: "from-web.txt", contents: "Attached by the web vault.\n" });
  await webAttach(page, "Contoso files", { name: "contoso-web.txt", contents: "Contoso's, by the web vault.\n" });

  // The core opens what the web vault attached, each under its item's key.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-interop-"));
  const cert = await serverCertificate(dir);
  const fromWeb = core(dir, cert, user, { action: "readAttachment", item: "Files from both", name: "from-web.txt" });
  expect(fromWeb.attachment).toEqual({
    name: "from-web.txt",
    contents: Buffer.from("Attached by the web vault.\n").toString("base64"),
  });
  const contosoWeb = core(dir, cert, user, { action: "readAttachment", item: "Contoso files", name: "contoso-web.txt" });
  expect(Buffer.from(contosoWeb.attachment!.contents!, "base64").toString()).toBe("Contoso's, by the web vault.\n");

  // The core attaches its own, to the person's item and the organization's.
  const file = (name: string, contents: string) => {
    const at = path.join(dir, name);
    fs.writeFileSync(at, contents);
    return at;
  };
  const attached = core(dir, cert, user, {
    action: "attach",
    item: "Files from both",
    path: file("from-core.txt", "Attached by the core.\n"),
    name: "from-core.txt",
  });
  expect(attached.attachment).toEqual({ id: expect.any(String), synced: true });
  const contosoCore = core(dir, cert, user, {
    action: "attach",
    item: "Contoso files",
    path: file("contoso-core.txt", "Contoso's, by the core.\n"),
    name: "contoso-core.txt",
  });
  expect(contosoCore.attachment?.synced).toBe(true);

  // The web vault opens them.
  expect(await webDownload(page, "Files from both", "from-core.txt")).toBe("Attached by the core.\n");
  expect(await webDownload(page, "Contoso files", "contoso-core.txt")).toBe("Contoso's, by the core.\n");

  // Deleted by the core, it's gone from the web vault too; the web vault's stays.
  const deleted = core(dir, cert, user, { action: "deleteAttachment", item: "Files from both", name: "from-core.txt" });
  expect(deleted.attachment).toEqual({ synced: true });
  const after = core(dir, cert, user);
  expect(after.items.find((i) => i.name === "Files from both")!.attachments.map((a) => a.name)).toEqual([
    "from-web.txt",
  ]);
  await resync(page);
  await page.getByText("Files from both").first().click();
  const view = page.getByRole("dialog", { name: "View Login" });
  await expect(view.getByRole("button", { name: "Download from-web.txt" })).toBeVisible();
  await expect(view.getByRole("button", { name: "Download from-core.txt" })).toHaveCount(0);
});

