// Helpers for autofill tests: reading the extension's background state,
// finding its frames, and creating items through the web vault.
import type { BrowserContext, Frame, Page } from "@playwright/test";

import { expect } from "./extension";

// The extension scans a page shortly after it loads and only then watches for
// a form submission. People take longer than that to start typing; tests
// don't, and a test that submits before the scan misses the very behavior it
// checks. So tests ask the extension's background (through upstream's own
// `self.bitwardenMain` debugging handle) whether it has scanned this page,
// including the field about to be typed into, and is watching the tab.
export async function waitForExtensionScan(context: BrowserContext, page: Page, fieldId: string) {
  const worker = context.serviceWorkers()[0];
  const url = page.url();
  await expect
    .poll(
      () =>
        worker.evaluate(
          async ({ url, fieldId }) => {
            const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const main = (self as any).bitwardenMain;
            if (!tab?.id || !main) return false;
            const details = main.overlayBackground.pageDetailsForTab[tab.id]?.get(0)?.details;
            const scanned = details?.fields?.some((f: { htmlID?: string }) => f.htmlID === fieldId);
            const watched = main.overlayNotificationsBackground.websiteOriginsWithFields.has(tab.id);
            return Boolean(scanned && watched);
          },
          { url, fieldId },
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
}

// The id of the code field on each code-page fixture.
export const codeFieldId: Record<string, string> = {
  "otp-tagged.html": "code",
  "otp-masked.html": "otp",
  "otp-bare.html": "f1",
};

export const hasNotificationBar = (page: Page) =>
  page.frames().some((f) => f.url().includes("notification/bar.html"));

// Finds elements anywhere in a frame, including inside closed shadow roots,
// through the DevTools protocol. Page scripts can't do this; tests can.
export type DeepNode = {
  nodeName: string;
  nodeType?: number;
  nodeValue?: string;
  attributes?: string[];
};

export async function hasElementDeep(
  context: BrowserContext,
  frame: Frame,
  match: (node: DeepNode) => boolean,
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

/**
 * Waits until the menu inside a field shows the item. Keys pressed before the
 * menu is ready go to the page instead, and Enter then submits the form.
 */
export async function waitForInlineMenuItem(context: BrowserContext, page: Page, itemName: string) {
  const list = await extensionFrame(page, "menu-list.html");
  await expect
    .poll(
      () =>
        hasElementDeep(context, list, (n) => n.nodeType === 3 && (n.nodeValue ?? "").includes(itemName)),
      { timeout: 15_000 },
    )
    .toBe(true);
}

export async function extensionFrame(page: Page, file: string) {
  await expect.poll(() => page.frames().some((f) => f.url().endsWith(file))).toBe(true);
  return page.frames().find((f) => f.url().endsWith(file))!;
}

export async function addLogin(
  web: Page,
  item: {
    name: string;
    username: string;
    password: string;
    uri: string;
    customFields?: Record<string, string>;
  },
) {
  await web.getByRole("button", { name: "New", exact: true }).click();
  await web.getByRole("menuitem", { name: "Login" }).click();
  const dialog = web.getByRole("dialog", { name: "New Login" });
  await dialog.getByRole("textbox", { name: /Item name/ }).fill(item.name);
  await dialog.getByRole("textbox", { name: "Username", exact: true }).fill(item.username);
  await dialog.getByRole("textbox", { name: "Password", exact: true }).fill(item.password);
  await dialog.getByRole("textbox", { name: "Website (URI)" }).fill(item.uri);
  for (const [label, value] of Object.entries(item.customFields ?? {})) {
    await dialog.getByRole("button", { name: "Add field" }).click();
    const addField = web.getByRole("dialog", { name: "Add field" });
    await addField.getByRole("textbox", { name: /Field label/ }).fill(label);
    await addField.getByRole("button", { name: "Add", exact: true }).click();
    await expect(addField).toBeHidden();
    await dialog.getByRole("textbox", { name: label, exact: true }).fill(value);
  }
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
}

