// The start of the autofill corpus: fixture login pages served by the test
// itself on made-up hosts (no network), filled by the real extension.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BrowserContext, Frame, Page } from "@playwright/test";

import { brand } from "../paths.mjs";

import { createAccount, expect, logInPopup, openPopup, test, userFor } from "./support/extension";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "autofill");

async function serveFixture(context: BrowserContext, origin: string, file: string) {
  const body = fs.readFileSync(path.join(fixtures, file), "utf8");
  await context.route(`${origin}/**`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body }),
  );
}

// Finds elements anywhere in a frame, including inside closed shadow roots,
// through the DevTools protocol. Page scripts can't do this; tests can.
async function hasElementDeep(
  context: BrowserContext,
  frame: Frame,
  match: (node: { nodeName: string; attributes?: string[] }) => boolean,
) {
  const cdp = await context.newCDPSession(frame);
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (match(node)) return true;
    stack.push(...(node.children ?? []), ...(node.shadowRoots ?? []));
    if (node.contentDocument) stack.push(node.contentDocument);
  }
  return false;
}

async function extensionFrame(page: Page, file: string) {
  await expect.poll(() => page.frames().some((f) => f.url().endsWith(file))).toBe(true);
  return page.frames().find((f) => f.url().endsWith(file))!;
}

async function addLogin(
  web: Page,
  item: { name: string; username: string; password: string; uri: string },
) {
  await web.getByRole("button", { name: "New", exact: true }).click();
  await web.getByRole("menuitem", { name: "Login" }).click();
  const dialog = web.getByRole("dialog", { name: "New Login" });
  await dialog.getByRole("textbox", { name: /Item name/ }).fill(item.name);
  await dialog.getByRole("textbox", { name: "Username", exact: true }).fill(item.username);
  await dialog.getByRole("textbox", { name: "Password", exact: true }).fill(item.password);
  await dialog.getByRole("textbox", { name: "Website (URI)" }).fill(item.uri);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
}

test("fills a simple login form from the icon inside the field", async ({
  context,
  extensionId,
}, testInfo) => {
  const user = userFor("fill", testInfo.repeatEachIndex);
  const site = "https://login.example.test";
  const web = await createAccount(context, user);
  await addLogin(web, {
    name: "Example login",
    username: "alice-example",
    password: "not-a-real-password-1",
    uri: site,
  });
  await web.close();
  await logInPopup(await openPopup(context, extensionId), user);

  await serveFixture(context, site, "simple-login.html");
  const page = await context.newPage();
  await page.goto(`${site}/login`);
  await page.getByLabel("Username").click();

  // The extension draws its button inside the field from its own frame, inside
  // a closed shadow root, so find the frame by URL.
  const buttonFrame = await extensionFrame(page, "menu-button.html");
  await expect
    .poll(() =>
      hasElementDeep(context, buttonFrame, (n) => {
        const attrs = n.attributes ?? [];
        const i = attrs.indexOf("data-brand");
        return n.nodeName === "svg" && i >= 0 && attrs[i + 1] === brand.name;
      }),
    )
    .toBe(true);

  // Keyboard path: ArrowDown moves into the menu, Enter fills the first match.
  await extensionFrame(page, "menu-list.html");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  await expect(page.getByLabel("Username")).toHaveValue("alice-example");
  await expect(page.getByLabel("Password")).toHaveValue("not-a-real-password-1");
});
