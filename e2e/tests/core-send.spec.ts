// Send between our apps' core (passbundle-apps, DESIGN.md "Send in the
// apps") and the web vault, with real keys on both sides: a text Send the
// core makes opens on the web vault's access page, with and without a
// password, as someone without an account opens it; and one the web vault
// makes is listed and opened by the core. Tier 1 builds the core's interop
// tool (KK_CORE_INTEROP); without it, this test is skipped.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test, type Browser } from "@playwright/test";

import { core, coreTool, serverCertificate } from "./support/core";
import { signUp, webUserFor } from "./support/web";

test.skip(!coreTool && !process.env.CI, "KK_CORE_INTEROP isn't set; tier 1 builds the core's interop tool");

/** The access page for a link, in a browser with no account signed in: the text it shows. */
async function openLink(browser: Browser, link: string, password?: string): Promise<string> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto(link);
  if (password) {
    // Its label says it's required ("Password * (required)").
    await page.getByLabel(/^Password/).fill(password);
    await page.getByRole("button", { name: "Continue" }).click();
  }
  const text = page.locator("textarea#text");
  await expect(text).toBeVisible();
  const shown = await text.inputValue();
  await context.close();
  return shown;
}

test("a Send the core makes opens on the web vault's access page, with and without a password, and the core opens one the web vault makes", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  const user = webUserFor("core-send", testInfo.repeatEachIndex);
  await signUp(page, user);

  // The web vault makes a text Send.
  await page.goto("/#/sends");
  // Its name has the plus icon's character before the word.
  await page.getByRole("button", { name: /Create$/ }).click();
  await page.getByRole("menuitem", { name: "Text" }).click();
  // The form opens in a drawer, beside the list.
  await page.getByRole("textbox", { name: /Send name/ }).fill("From the web vault");
  await page.getByRole("textbox", { name: /Text to share/ }).fill("Made by the web vault.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Send created successfully!")).toBeVisible();

  // The core lists and opens it, with the account's user key.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-interop-"));
  const cert = await serverCertificate(dir);
  const listed = core(dir, cert, user, { action: "sends" });
  expect(listed.send).toEqual([
    expect.objectContaining({
      name: "From the web vault",
      kind: "text",
      text: "Made by the web vault.",
      opens: true,
      hasPassword: false,
    }),
  ]);

  // The core makes one, and its link opens on the access page.
  const open = core(dir, cert, user, { action: "makeSend", name: "From the core", text: "Made by the core." });
  const made = open.send as { id: string; link: string };
  expect(made.link).toMatch(/\/#\/send\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]{22}$/);
  expect(await openLink(browser, made.link)).toBe("Made by the core.");

  // And one with a password, which the page asks for first.
  const locked = core(dir, cert, user, {
    action: "makeSend",
    name: "Behind a password",
    text: "Opened with the password.",
    password: "open sesame",
  });
  expect(await openLink(browser, (locked.send as { link: string }).link, "open sesame")).toBe(
    "Opened with the password.",
  );
});
