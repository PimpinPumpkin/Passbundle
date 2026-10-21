// Our own apps' core (passbundle-apps, docs/core.md) and the web vault read
// each other's items, with real keys on both sides: the web vault makes an
// account, an organization, and an item in each; the core opens them, then
// saves its own item in each, and the web vault shows them. Tier 1 builds the
// core's interop tool (KK_CORE_INTEROP); without it, this test is skipped.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

import { expect, test, type Page } from "@playwright/test";

import { port } from "../paths.mjs";

import { signUp, webUserFor, type WebUser } from "./support/web";

const tool = process.env.KK_CORE_INTEROP;
test.skip(!tool && !process.env.CI, "KK_CORE_INTEROP isn't set; tier 1 builds the core's interop tool");

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
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Login" }).click();
  const dialog = page.getByRole("dialog", { name: "New Login" });
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

/** The test server's certificate, for the core to trust (its usual trust is the OS's). */
async function serverCertificate(dir: string): Promise<string> {
  const der = await new Promise<Buffer>((resolve, reject) => {
    const socket = tls.connect({ host: "127.0.0.1", port: Number(port), rejectUnauthorized: false }, () => {
      resolve(socket.getPeerCertificate(true).raw);
      socket.end();
    });
    socket.on("error", reject);
  });
  const file = path.join(dir, "server.pem");
  fs.writeFileSync(
    file,
    `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`,
  );
  return file;
}

type Read = {
  items: {
    name: string;
    username: string | null;
    password: string | null;
    notes: string | null;
    uris: string[];
    organizationId: string | null;
    fields: { name: string; value: string; hidden: boolean }[];
  }[];
  saved: boolean;
};

/** Runs the core: signs in, reads every item, and saves the draft, if any. */
function core(dir: string, cert: string, user: WebUser, draft?: object): Read {
  const args = [`https://127.0.0.1:${port}`, cert, user.email, user.password];
  if (draft) {
    const file = path.join(dir, `draft-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(draft));
    args.push(file);
  }
  return JSON.parse(execFileSync(tool!, args, { encoding: "utf8", timeout: 60_000 }));
}

/** Reloading locks the web vault; unlocking it again syncs. */
async function unlock(page: Page, user: WebUser) {
  await page.goto("/#/vault");
  await page.reload();
  await page.getByRole("textbox", { name: /^Master password/ }).fill(user.password);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.waitForURL(/#\/vault/);
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
  await unlock(page, user);
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
