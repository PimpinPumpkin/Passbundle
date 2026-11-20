// A tab closed, or sent to another page, in the middle of a fill from the
// menu inside a field: the next sign-in page still gets the menu in its
// field, and picking the login there fills it. A fill tells the extension's
// background it has started, and a moment after the last field is filled,
// that it has ended; while it's filling, no field opens its menu. A tab gone
// in between never said it ended, and no field in any tab opened its menu
// again (passbundle-clients, OverlayBackground.removePageDetails).
//
// Each case picks the login, then closes the tab, sends it to another page,
// or sends it to the next sign-in page, right away and about 100, 300 and
// 500 ms later, and once after the fill. All of it happens in one browser,
// one page after another, as the autofill corpus runs.
import type { BrowserContext, Page } from "@playwright/test";

import {
  createAccount,
  expect,
  logInPopup,
  openPopup,
  test,
  userFor,
} from "./support/extension";
import { addLogin, hasElementDeep } from "./support/autofill";

const SITE = "https://closing.example.test";
const ITEM = "Closing login";
const USERNAME = "closing-user";
const PASSWORD = "not-a-real-password-closing";

/** Whether the menu inside the page's field lists the login, within `timeout`. */
async function menuOffersLogin(context: BrowserContext, page: Page, timeout: number) {
  try {
    await expect
      .poll(
        async () => {
          const list = page.frames().find((f) => f.url().endsWith("menu-list.html"));
          if (!list) return false;
          try {
            return await hasElementDeep(context, list, (n) => n.nodeType === 3 && (n.nodeValue ?? "").includes(ITEM));
          } catch {
            return false;
          }
        },
        { timeout },
      )
      .toBe(true);
    return true;
  } catch {
    return false;
  }
}

/** Moves the keyboard into the menu and picks the login, as a person would. */
async function pickLogin(page: Page) {
  const field = page.locator("#username");
  const focusLeftTheField = () => field.evaluate((el) => document.activeElement !== el || !document.hasFocus());
  await expect(async () => {
    if (!(await focusLeftTheField())) {
      await page.keyboard.press("ArrowDown");
    }
    await expect.poll(focusLeftTheField, { timeout: 1000 }).toBe(true);
  }).toPass({ timeout: 10_000 });
  await page.keyboard.press("Enter");
}

/**
 * What the extension's background holds about the menu (through upstream's
 * `self.bitwardenMain` debugging handle), for a failure's message.
 */
async function menuState(context: BrowserContext) {
  return context.serviceWorkers()[0].evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const o = (self as any).bitwardenMain?.overlayBackground;
    if (!o) return "no overlay background";
    return JSON.stringify({
      filling: o.isFieldCurrentlyFilling,
      fieldFocused: o.isFieldCurrentlyFocused,
      focusedTab: o.focusedFieldData?.tabId ?? null,
      buttonPort: o.inlineMenuButtonPort?.sender?.tab?.id ?? null,
      listPort: o.inlineMenuListPort?.sender?.tab?.id ?? null,
    });
  });
}

/**
 * Fills a sign-in page from the menu in its field: in a new tab, or in the
 * one given once it shows the page. Says what went wrong, or null.
 */
async function fillSignIn(context: BrowserContext, here?: Page): Promise<string | null> {
  const page = here ?? (await context.newPage());
  try {
    if (!here) await page.goto(`${SITE}/simple-login.html`);
    await page.locator("#username").click();
    if (!(await menuOffersLogin(context, page, 10_000))) {
      return `no menu in the field (${await menuState(context)})`;
    }
    await pickLogin(page);
    try {
      await expect(page.locator("#username")).toHaveValue(USERNAME, { timeout: 5000 });
      await expect(page.locator("#password")).toHaveValue(PASSWORD, { timeout: 5000 });
    } catch {
      return `picked the login, but it didn't fill (${await menuState(context)})`;
    }
    // This page's own fill has ended before its tab closes, so a miss on the
    // next one belongs to the case before it.
    await page.waitForTimeout(1000);
    return null;
  } finally {
    await page.close();
  }
}

type How = "closes" | "goes to another page" | "goes to the next sign-in";
const hows: How[] = ["closes", "goes to another page", "goes to the next sign-in"];
const whens = [0, 100, 300, 500, "after the fill"] as const;

test("a tab closed or sent elsewhere mid-fill leaves the menu working on the next sign-in", async (
  { context, extensionId },
  testInfo,
) => {
  test.setTimeout(hows.length * whens.length * 30_000 + 60_000);
  const user = userFor("tab-close", testInfo.repeatEachIndex);
  const web = await createAccount(context, user);
  await addLogin(web, { name: ITEM, username: USERNAME, password: PASSWORD, uri: SITE });
  await web.close();
  await logInPopup(await openPopup(context, extensionId), user);
  expect(await fillSignIn(context), "a fill before any case").toBeNull();

  for (const how of hows) {
    for (const when of whens) {
      const name = `the tab ${how} ${typeof when === "number" ? `${when} ms after the login is picked` : when}`;
      await test.step(name, async () => {
        const page = await context.newPage();
        await page.goto(`${SITE}/simple-login.html`);
        await page.locator("#username").click();
        const menu = await menuOffersLogin(context, page, 15_000);
        expect(menu, `the menu on the first page (${await menuState(context)})`).toBe(true);
        await pickLogin(page);
        if (when === "after the fill") {
          await expect(page.locator("#username")).toHaveValue(USERNAME, { timeout: 5000 });
          await page.waitForTimeout(500);
        } else if (when > 0) {
          await page.waitForTimeout(when);
        }
        let next: string | null;
        if (how === "closes") {
          await page.close();
          next = await fillSignIn(context);
        } else if (how === "goes to another page") {
          await page.goto(`${SITE}/signed-in.html`);
          next = await fillSignIn(context);
          await page.close();
        } else {
          await page.goto(`${SITE}/simple-login.html`);
          next = await fillSignIn(context, page);
        }
        expect(next, `the next sign-in, after ${name}`).toBeNull();
      });
    }
  }
});
