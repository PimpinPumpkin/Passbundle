// Script access in the web vault (docs/script-access.md): an owner makes a
// token on the organization's Settings page, granting chosen fields of a
// login. The token string shows once, with how to use it; a script with it
// reads a copy of just those fields, encrypted with a key the server never
// had; an edit to the login reaches the script; the owner sees the reads, and
// revokes the token. Real keys throughout.
import { createDecipheriv, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { newItem, signUp, webUserFor } from "./support/web";

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

/** What a script holding the token string reads, opened as the module opens it. */
function scriptSide(tokenString: string) {
  const [, hex, seedText] = /^pbs1_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/.exec(tokenString)!;
  const id = hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
  const seed = Buffer.from(seedText, "base64url");
  const derive = (info: string, length: number) =>
    Buffer.from(hkdfSync("sha256", seed, Buffer.alloc(0), info, length));
  const authorization = `PassBundleScript ${id}.${derive("passbundle script auth v1", 32).toString("base64url")}`;
  const key = derive("passbundle script key v1", 64);
  const open = (encString: string) => {
    const [iv, data, mac] = encString.slice(2).split("|").map((p) => Buffer.from(p, "base64"));
    const expected = createHmac("sha256", key.subarray(32)).update(Buffer.concat([iv, data])).digest();
    expect(timingSafeEqual(mac, expected)).toBe(true);
    const decipher = createDecipheriv("aes-256-cbc", key.subarray(0, 32), iv);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8"));
  };
  return { id, authorization, open };
}

test("an owner makes a script token for chosen fields, sees it once, an edit reaches the script, and revoking stops it", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  await signUp(page, webUserFor("script-owner", testInfo.repeatEachIndex));
  const orgId = await createOrganization(page, "Contoso");

  // A login in the organization, with a note the token isn't granted.
  await page.goto(`/#/organizations/${orgId}/vault`);
  await newItem(page, "Login");
  const item = page.getByRole("dialog", { name: "New Login" });
  await item.getByRole("textbox", { name: /Item name/ }).fill("Domain admin");
  await item.getByRole("textbox", { name: /Username/ }).fill("admin@contoso.example");
  await item.getByLabel("Password", { exact: true }).fill("not-a-real-password-1");
  await item.getByRole("textbox", { name: /Notes/ }).fill("Not for scripts");
  await item.getByRole("button", { name: "Save" }).click();
  await expect(item).toBeHidden();
  // Saving a new item opens its view.
  const view = page.getByRole("dialog", { name: "View Login" });
  await view.getByRole("button", { name: "Close" }).first().click();
  await expect(view).toBeHidden();

  await page.goto(`/#/organizations/${orgId}/settings/account`);
  const section = page.getByTestId("script-access");
  await expect(section.getByText("No tokens yet.")).toBeVisible();
  await section.getByRole("button", { name: "New token" }).click();
  const dialog = page.getByRole("dialog", { name: "New script token" });
  await dialog.getByRole("textbox", { name: "Name" }).fill("Join domain");
  await dialog.getByRole("checkbox", { name: "Domain admin" }).check();
  // A login's username and password, to start.
  const fields = dialog.getByLabel("Fields of Domain admin");
  await expect(fields.getByRole("checkbox", { name: "Username" })).toBeChecked();
  await expect(fields.getByRole("checkbox", { name: "Password" })).toBeChecked();
  await dialog.getByRole("button", { name: "Make token" }).click();
  await expect(dialog).toBeHidden();

  // Shown once, with how to use it.
  const made = section.getByTestId("script-token-made");
  const tokenString = (await made.getByTestId("script-token-string").textContent())!.trim();
  expect(tokenString).toMatch(/^pbs1_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/);
  const usage = made.getByTestId("script-token-usage");
  await expect(usage).toContainText(`/api/keykeeper/script/PassBundle.psm1" -OutFile PassBundle.psm1`);
  await expect(usage).toContainText(`Get-PassBundleCredential -Item "Domain admin"`);
  await expect(made.getByTestId("script-token-signing")).toContainText("-ExecutionPolicy Bypass");

  // A script with the token reads just the granted fields.
  const script = scriptSide(tokenString);
  const items = await request.get("/api/keykeeper/script/items", {
    headers: { Authorization: script.authorization },
  });
  expect(items.status()).toBe(200);
  const [entry] = (await items.json()).data;
  const copy = script.open(entry.copy);
  expect(copy).toMatchObject({
    v: 1,
    token: script.id,
    item: entry.itemId,
    name: "Domain admin",
    username: "admin@contoso.example",
    password: "not-a-real-password-1",
    fields: {},
  });
  expect(JSON.stringify(copy)).not.toContain("Not for scripts");
  expect(copy).not.toHaveProperty("totp");

  // Done, and it's gone for good.
  await made.getByRole("button", { name: "Done" }).click();
  await expect(section.getByTestId("script-token-made")).toHaveCount(0);
  // Away and back (a reload would lock the vault).
  await page.goto("/#/vault");
  await page.goto(`/#/organizations/${orgId}/settings/account`);
  await expect(page.getByTestId("script-token-Join domain")).toBeVisible();
  await expect(page.getByTestId("script-token-string")).toHaveCount(0);

  // An edit in the web vault reaches the script: the vault, which has the
  // token key sealed with the organization key, makes a new copy.
  await page.goto("/#/vault");
  await page.getByText("Domain admin").first().click();
  await view.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: /Edit Login/ });
  await edit.getByLabel("Password", { exact: true }).fill("not-a-real-password-2");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  await view.getByRole("button", { name: "Close" }).first().click();
  await expect
    .poll(
      async () => {
        const read = await request.get(`/api/keykeeper/script/items/${entry.itemId}`, {
          headers: { Authorization: script.authorization },
        });
        return script.open((await read.json()).copy).password;
      },
      { timeout: 30_000 },
    )
    .toBe("not-a-real-password-2");

  // The list shows the token and its use.
  await page.goto("/#/vault");
  await page.goto(`/#/organizations/${orgId}/settings/account`);
  const row = page.getByTestId("script-token-Join domain");
  await expect(row).toContainText("1 item");
  await expect(row).toContainText("from 127.0.0.1");
  await row.getByRole("button", { name: "Reads of Join domain" }).click();
  // Two reads: the first, and the one that saw the edit.
  await expect(page.getByTestId("script-token-reads").getByRole("listitem")).not.toHaveCount(0);
  await expect(page.getByTestId("script-token-reads")).toContainText("127.0.0.1: read Domain admin");

  // Revoked: the script is refused.
  await row.getByRole("button", { name: "Revoke Join domain" }).click();
  await page.getByRole("dialog", { name: "Revoke Join domain?" }).getByRole("button", { name: "Revoke" }).click();
  await expect(toast(page, "Revoked Join domain")).toBeVisible();
  await expect(row).toContainText("Revoked");
  await expect(row.getByRole("button", { name: "Revoke Join domain" })).toHaveCount(0);
  const refused = await request.get("/api/keykeeper/script/items", {
    headers: { Authorization: script.authorization },
  });
  expect(refused.status()).toBe(401);
});
