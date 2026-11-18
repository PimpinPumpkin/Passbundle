// PassBundle's look (DESIGN.md, "The look"): the web vault has the design
// language in every theme, light or dark like the device for System, never
// Glass; a calm ground with the menu as a card on it, graphite glass in dark
// mode; jewel tiles in the menu and the list; the open item in a side panel
// beside the list; and Google Sans Flex and our artwork everywhere. The admin
// console's menu opens on a phone as the vault's does, and closed, its icons
// line up; on a phone a page's title shows beside its buttons or over them;
// and its Two-step login page says it in our words, with no Duo of its own.
import { expect, test, type Page } from "@playwright/test";

import { brand } from "../paths.mjs";

import { menu, newItem, signUp, webUserFor } from "./support/web";

/** The page's look and theme classes: pb-web, and never pb-glass. */
const look = (page: Page) =>
  page.evaluate(() =>
    [...document.documentElement.classList]
      .filter((c) => c.startsWith("pb-") || c.startsWith("theme_"))
      .sort(),
  );

/** Illustrations that aren't ours: every drawing upstream draws is replaced. */
const upstreamArt = (page: Page) =>
  page.locator("bit-svg svg:not([data-art]):not([data-brand])").count();

/** The ground (the page's background) and the menu's card. */
const ground = (page: Page) => page.locator("body");
const menuCard = (page: Page) => page.locator("#bit-side-nav");

test("the web vault's page, before the app starts, has the brand's color and our drawings", async ({
  request,
}) => {
  const html = await (await request.get("/")).text();
  expect(html).toContain(`<meta name="theme-color" content="${brand.color}"`);
  expect(html.match(/data-art="passbundle"/g)).toHaveLength(2);
  expect(html).not.toContain("#175DDC");
  // The look is the web vault's from the first paint, with no flash of another.
  expect(html).toMatch(/<html class="theme_light pb-web">/);
});

test("the look follows the device for System, Light and Dark hold, and the type and artwork are ours", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await page.goto("/#/signup");
  await expect(page.locator("bit-svg svg[data-art]").first()).toBeVisible();
  expect(await upstreamArt(page)).toBe(0);

  const user = webUserFor("look", testInfo.repeatEachIndex);
  await signUp(page, user);
  await expect(page.getByText("No items yet")).toBeVisible();
  expect(await upstreamArt(page)).toBe(0);
  expect(await look(page)).toEqual(["pb-web", "theme_light"]);
  const font = await page.evaluate(async () => {
    await document.fonts.ready;
    return {
      family: getComputedStyle(document.body).fontFamily,
      loaded: document.fonts.check('16px "Google Sans Flex"'),
    };
  });
  expect(font.family).toMatch(/^"?Google Sans Flex/);
  expect(font.loaded).toBe(true);
  // Light: the calm ground, and the menu a white card on it.
  await expect(ground(page)).toHaveCSS("background-color", "rgb(238, 242, 240)");
  await expect(menuCard(page)).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(menuCard(page)).toHaveCSS("border-radius", "16px");

  // System follows the device. Dark is graphite glass: a neutral ground with
  // faint washes, and the menu translucent white over it, not green.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => look(page)).toEqual(["pb-web", "theme_dark"]);
  await expect(ground(page)).toHaveCSS("background-color", "rgb(17, 19, 24)");
  await expect(ground(page)).toHaveCSS("background-image", /radial-gradient/);
  await expect(menuCard(page)).toHaveCSS("background-color", "rgba(255, 255, 255, 0.055)");
  await page.emulateMedia({ colorScheme: "light" });

  // The setting: System first, then Light and Dark, the same look in each.
  await page.goto("/#/settings/appearance");
  const theme = page.getByRole("combobox", { name: "Theme" });
  // The picker shows its value beside the search box.
  await expect(page.getByText("System default", { exact: true })).toBeVisible();
  await theme.click();
  await expect(page.getByRole("option")).toHaveText(["System default", "Light", "Dark"]);
  await page.getByRole("option", { name: "Dark", exact: true }).click();
  await expect.poll(() => look(page)).toEqual(["pb-web", "theme_dark"]);
  await expect(ground(page)).toHaveCSS("background-color", "rgb(17, 19, 24)");

  // The choice holds across a reload, before the app has started.
  await page.reload();
  expect(await look(page)).toEqual(["pb-web", "theme_dark"]);
  // Within the vault timeout the reload stays unlocked, on the same page.
  await expect(theme).toBeVisible({ timeout: 30_000 });

  await page.goto("/#/settings/appearance");
  await theme.click();
  await page.getByRole("option", { name: "Light", exact: true }).click();
  await expect.poll(() => look(page)).toEqual(["pb-web", "theme_light"]);
  await theme.click();
  await page.getByRole("option", { name: "System default" }).click();
  await expect.poll(() => look(page)).toEqual(["pb-web", "theme_light"]);
});

/** Scrolls the menu's list (whichever part of it scrolls) to its top, its middle, or its end. */
const scrollMenu = (page: Page, where: "top" | "middle" | "end") =>
  menuCard(page).evaluate((card, where) => {
    let scrolls = false;
    for (const el of card.querySelectorAll<HTMLElement>("*")) {
      const max = el.scrollHeight - el.clientHeight;
      if (max > 0 && ["auto", "scroll"].includes(getComputedStyle(el).overflowY)) {
        el.scrollTop = where === "top" ? 0 : where === "end" ? max : max / 2;
        scrolls = true;
      }
    }
    return scrolls;
  }, where);

/**
 * The menu's entries that show under the logo or the product switcher's
 * entries: where the parts of their boxes in view (less what a scrolling
 * part of the menu cuts off) overlap. The card is see-through, so an entry
 * that scrolls under either shows through it.
 */
const entriesUnderneath = (page: Page) =>
  menuCard(page).evaluate((card) => {
    const inView = (el: Element) => {
      const box = el.getBoundingClientRect();
      let top = box.top;
      let bottom = box.bottom;
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (getComputedStyle(p).overflowY !== "visible") {
          const clip = p.getBoundingClientRect();
          top = Math.max(top, clip.top);
          bottom = Math.min(bottom, clip.bottom);
        }
      }
      return { top, bottom, left: box.left, right: box.right };
    };
    type Box = ReturnType<typeof inView>;
    const overlap = (a: Box, b: Box) =>
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1 &&
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1;
    const name = (el: Element) => el.textContent!.trim().replace(/\s+/g, " ");
    const switcher = card.querySelector("navigation-product-switcher")!;
    const all = [...card.querySelectorAll("[data-testid='nav-item-container']")].filter(
      (el) => inView(el).bottom - inView(el).top > 1,
    );
    const above = [card.querySelector("bit-nav-logo a")!, ...all.filter((el) => switcher.contains(el))];
    return all
      .filter((el) => !switcher.contains(el))
      .flatMap((el) =>
        above
          .filter((top) => overlap(inView(el), inView(top)))
          .map((top) => `${name(el)} under ${top.matches("a") ? "the logo" : name(top)}`),
      );
  });

/**
 * Signs up and makes an organization (a family, which needs no two-step
 * login), so there's an admin console, and the product switcher in the menu
 * to go between it and the vault. Lands on its Members page; gives its ID.
 */
async function adminConsole(page: Page, name: string, repeatIndex: number) {
  await signUp(page, webUserFor(name, repeatIndex));
  await page.goto("/#/create-organization");
  await page.getByRole("textbox", { name: /Organization name/ }).fill("Test Dental");
  await page.getByRole("radio", { name: /A family or a group/ }).check();
  await page.getByRole("button", { name: "Create organization" }).click();
  await page.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  return /#\/organizations\/([0-9a-f-]{36})/.exec(page.url())![1];
}

test("the menu's entries scroll clear of the logo and the product switcher, in the admin console and the vault", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const org = await adminConsole(page, "look-menu-scroll", testInfo.repeatEachIndex);

  // The admin console with Settings open: a menu longer than a short window.
  // Upstream keeps its logo at the top and, 600px tall or more, the switcher
  // at the foot, and on our see-through card the entries showed through both.
  await page.goto(`/#/organizations/${org}/settings/policies`);
  const products = menu(page).locator("navigation-product-switcher");
  await expect(products.getByRole("link", { name: "Admin Console" })).toBeAttached();
  await expect(menu(page).getByRole("link", { name: "Policies", exact: true })).toBeVisible();
  for (const height of [720, 560]) {
    await page.setViewportSize({ width: 1280, height });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expect.poll(() => look(page)).toEqual(["pb-web", `theme_${scheme}`]);
      for (const where of ["top", "middle", "end"] as const) {
        expect(await scrollMenu(page, where), `the menu scrolls at ${height}px`).toBe(true);
        expect(await entriesUnderneath(page), `${height}px, ${scheme}, the list at its ${where}`).toEqual([]);
      }
    }
  }

  // The vault's menu, one list with the switcher at its end, the same.
  await page.goto("/#/vault");
  await expect(products.getByRole("link", { name: "Admin Console" })).toBeAttached();
  for (const height of [720, 560]) {
    await page.setViewportSize({ width: 1280, height });
    for (const where of ["top", "middle", "end"] as const) {
      await scrollMenu(page, where);
      expect(await entriesUnderneath(page), `the vault, ${height}px, the list at its ${where}`).toEqual([]);
    }
  }
});

/** Whether all of a page's title shows: it has width, and isn't cut short. */
const wholeTitle = (page: Page, name: string) =>
  page.getByRole("heading", { level: 1, name }).evaluate((h1) => {
    const text = h1.querySelector(".tw-truncate") ?? h1;
    return text.clientWidth > 0 && text.scrollWidth <= text.clientWidth;
  });

test("on a phone, the admin console's Menu button opens its menu, and a pick closes it", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  // Its pages are only in its menu, which has no room beside them here.
  const org = await adminConsole(page, "look-admin-phone", testInfo.repeatEachIndex);
  await page.goto(`/#/organizations/${org}/members`);
  // Members' search and Invite member squeezed its title to nothing; they go
  // under it, all of them on the screen.
  expect(await wholeTitle(page, "Members")).toBe(true);
  await expect(page.getByRole("button", { name: "Invite member" })).toBeInViewport({ ratio: 1 });
  const menuButton = page.getByRole("button", { name: "Menu", exact: true });
  const members = menu(page).getByRole("link", { name: "Members", exact: true });
  await expect(menuButton).toHaveAttribute("aria-expanded", "false");
  await expect(members).toBeHidden();

  await menuButton.click();
  await expect(menuButton).toHaveAttribute("aria-expanded", "true");
  await expect(members).toBeVisible();
  await expect(members).toBeInViewport({ ratio: 1 });

  await menu(page).getByRole("link", { name: "Groups", exact: true }).click();
  await expect(page).toHaveURL(/\/organizations\/[0-9a-f-]{36}\/groups$/);
  await expect(menuButton).toHaveAttribute("aria-expanded", "false");
  await expect(members).toBeHidden();
  // Groups' title shows too.
  expect(await wholeTitle(page, "Groups")).toBe(true);
});

/** The closed menu's (the icon rail's) entries, with where each one's icon starts. */
const railIcons = (page: Page) =>
  menuCard(page).evaluate((card) =>
    [...card.querySelectorAll("[data-testid='nav-item-interactive']")].flatMap((entry) => {
      const icon = entry.querySelector("bit-icon")?.getBoundingClientRect();
      return icon && icon.width > 0
        ? [{ name: entry.getAttribute("aria-label")!, left: Math.round(icon.left) }]
        : [];
    }),
  );

test("with the menu closed, its icons share one left edge, in the admin console and the vault", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  const org = await adminConsole(page, "look-rail", testInfo.repeatEachIndex);
  await page.goto(`/#/organizations/${org}/members`);
  const toggle = page.getByRole("button", { name: "Toggle side navigation" });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  // Groups (the organization, Reporting, Settings, and the vault's Import
  // and export) kept room for an arrow the rail doesn't have, and their icons
  // sat left of the others.
  for (const where of [`/#/organizations/${org}/members`, "/#/vault"]) {
    await page.goto(where);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const icons = await railIcons(page);
    expect(icons.map((icon) => icon.name)).toContain("Settings");
    expect(icons.length, where).toBeGreaterThan(5);
    // The edge most of them share, so the ones off it are the ones named.
    const sharing = (left: number) => icons.filter((icon) => icon.left === left).length;
    const edge = icons.map((icon) => icon.left).sort((a, b) => sharing(b) - sharing(a))[0];
    expect(
      icons.map((icon) => `${icon.name} at ${icon.left}px`),
      where,
    ).toEqual(icons.map((icon) => `${icon.name} at ${edge}px`));
  }
});

test("the admin console's Two-step login page says it in our words, names the policy as Policies does, and offers no Duo", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const org = await adminConsole(page, "look-admin-two-step", testInfo.repeatEachIndex);
  // The server has no two-step login of an organization's own (upstream's
  // organization Duo), and no API for it: the page asked anyway, got a 404,
  // and its Providers spinner never stopped.
  const asked: string[] = [];
  const missing: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/organizations\/[^/]+\/two-factor/.test(request.url())) asked.push(request.url());
  });
  page.on("response", (response) => {
    if (response.status() === 404 && response.url().includes("/api/")) missing.push(response.url());
  });
  await page.goto(`/#/organizations/${org}/settings/two-factor`);
  const words = page.locator("bit-container");
  await expect(words).toContainText(
    "To require members to set up two-step login, turn on the Require two-step login policy.",
  );
  await expect(words).toContainText(
    "If your organization uses single sign-on, your identity provider may already require two-step login.",
  );
  // Not upstream's capitals, "enforce", or "SSO", and nothing about Duo.
  await expect(words).not.toContainText(/Two-step Login|enforce|SSO|Identity Provider|Duo/);
  // No Providers heading, spinner, or Duo (Organization) card.
  await expect(page.getByRole("heading", { name: "Providers" })).toHaveCount(0);
  await expect(page.getByText("Duo (Organization)")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Manage" })).toHaveCount(0);

  await page.getByRole("link", { name: "Require two-step login policy." }).click();
  await expect(page).toHaveURL(/\/settings\/policies$/);
  await expect(
    page.getByRole("button", { name: /^Require two-step login Require members/ }),
  ).toBeVisible();
  // By now the old page had long asked for its providers.
  expect(asked).toEqual([]);
  expect(missing).toEqual([]);
});

/** Saves a new item of a kind with a name; saving opens its view, which this closes. */
async function save(page: Page, kind: string, name: string) {
  await newItem(page, kind);
  const dialog = page.getByRole("dialog", { name: `Add ${kind}` });
  await dialog.getByRole("textbox", { name: /Item name/ }).fill(name);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  const view = page.getByRole("dialog", { name: /^View/ });
  await view.getByRole("button", { name: "Close" }).first().click();
  await expect(view).toBeHidden();
}

const row = (page: Page, name: string) => page.getByRole("row").filter({ hasText: name });

/**
 * Where a row's tile sits: its cell's display, how far the tile is from the
 * row's middle, and whether its cell reaches into the name's cell. A flex
 * cell (upstream's) leaves the table's layout: the tile sat at the row's top,
 * and the open row's raised fill drew a second block over the name's cell.
 */
const tilePlacement = (page: Page, name: string, tile: string) =>
  row(page, name).evaluate((tr, tileSelector) => {
    const cell = tr.querySelector("td:has(> vault-keykeeper-item-tile)")!;
    const nameCell = tr.querySelector('td:has([id^="cipher-btn-"])')!;
    const r = tr.getBoundingClientRect();
    const t = cell.querySelector(tileSelector)!.getBoundingClientRect();
    return {
      display: getComputedStyle(cell).display,
      offCenter: Math.round(Math.abs(t.top - r.top - (r.bottom - t.bottom))),
      spills: cell.getBoundingClientRect().right > nameCell.getBoundingClientRect().left + 0.5,
    };
  }, tile);
const placed = { display: "table-cell", offCenter: 0, spills: false };

test("the vault: jewel tiles in the menu and the list, and the item open in a side panel beside it", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await signUp(page, webUserFor("look-vault", testInfo.repeatEachIndex));
  await save(page, "Login", "Contoso Mail");
  await save(page, "Card", "Visa ending 4242");

  // The menu: All items and the categories have their jewel tiles.
  const nav = menu(page);
  const tileIn = (name: string) =>
    nav
      .locator("bit-nav-item")
      .filter({ has: page.getByRole("button", { name, exact: true }) })
      .locator("vault-keykeeper-category-tile [data-jewel]");
  await expect(tileIn("All items")).toHaveAttribute("data-category", "all");
  await expect(tileIn("Login")).toHaveAttribute("data-category", "login");
  await expect(tileIn("Card")).toHaveAttribute("data-category", "card");
  await expect(
    nav.locator("bit-nav-item").filter({ hasText: "Health" }).locator("[data-jewel]"),
  ).toHaveAttribute("data-category", "health");

  // The list: the login's letter (its site has no icon), the card's tile.
  const loginTile = row(page, "Contoso Mail").locator("vault-keykeeper-item-tile [data-tile]");
  await expect(loginTile).toHaveAttribute("data-tile", "letter");
  await expect(loginTile).toHaveText("C");
  await expect(
    row(page, "Visa ending 4242").locator('vault-keykeeper-item-tile [data-category="card"]'),
  ).toBeVisible();

  // An item opens in the side panel, beside the list rather than over it:
  // its tile, its name, what it is and where it lives, and Edit up top.
  await row(page, "Contoso Mail").getByText("Contoso Mail", { exact: true }).click();
  const panel = page.getByRole("dialog", { name: "View Login" });
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-keykeeper", "item-panel");
  expect(await panel.evaluate((el) => !!el.closest("bit-layout"))).toBe(true);
  await expect(panel.getByRole("heading", { name: "Contoso Mail" })).toBeVisible();
  await expect(panel.getByTestId("keykeeper-item-where")).toHaveText("Login in Personal");
  await expect(panel.locator('[data-keykeeper="panel-edit"]')).toHaveText("Edit");
  // The list stays usable, with the open item's row marked, and the page's
  // title is still the list's.
  await expect(row(page, "Contoso Mail")).toHaveAttribute("data-keykeeper-open", "");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("All items");
  // Each tile sits in the middle of its row, the open one's and the others',
  // in a cell of the row's table.
  await expect.poll(() => tilePlacement(page, "Contoso Mail", "[data-tile]")).toEqual(placed);
  await expect
    .poll(() => tilePlacement(page, "Visa ending 4242", '[data-category="card"]'))
    .toEqual(placed);

  // Another row shows its item in the panel instead; the whole row opens it,
  // not only its name (here, a click on its tile).
  // (In view first: the mouse clicks where it's told, and notices above the
  // list, such as the nudge to set up two-step login, can push it down.)
  await row(page, "Visa ending 4242").scrollIntoViewIfNeeded();
  const tile = await row(page, "Visa ending 4242").locator("vault-keykeeper-item-tile").boundingBox();
  await page.mouse.click(tile!.x + tile!.width / 2, tile!.y + tile!.height / 2);
  const card = page.getByRole("dialog", { name: "View Card" });
  await expect(card).toBeVisible();
  await expect(panel).toBeHidden();
  await expect(card.getByRole("heading", { name: "Visa ending 4242" })).toBeVisible();
  await expect(row(page, "Visa ending 4242")).toHaveAttribute("data-keykeeper-open", "");
  await expect(row(page, "Contoso Mail")).not.toHaveAttribute("data-keykeeper-open", "");
  await expect(page).toHaveURL(/itemId=/);

  // Edit works in place, and Close puts the list back as it was.
  await card.locator('[data-keykeeper="panel-edit"]').click();
  await expect(page.getByRole("dialog", { name: "Edit Card" })).toBeVisible();
  await page.getByRole("dialog", { name: "Edit Card" }).getByRole("button", { name: "Cancel" }).click();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Close" }).first().click();
  await expect(card).toBeHidden();
  await expect(page).not.toHaveURL(/itemId=/);
  await expect(row(page, "Visa ending 4242")).not.toHaveAttribute("data-keykeeper-open", "");

  // Opening another page closes the panel and stays there.
  await row(page, "Contoso Mail").getByText("Contoso Mail", { exact: true }).click();
  await expect(panel).toBeVisible();
  await nav.getByRole("link", { name: "Send", exact: true }).click();
  await expect(page).toHaveURL(/#\/sends/);
  await expect(panel).toBeHidden();
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/#\/sends/);
});

test("an item being edited in the panel keeps its edits beside a dialog, and asks before they go", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await signUp(page, webUserFor("look-panel-edits", testInfo.repeatEachIndex));
  await save(page, "Login", "Contoso Mail");
  await save(page, "Card", "Visa ending 4242");

  // Contoso Mail open to edit in the panel, its name half changed.
  await row(page, "Contoso Mail").getByText("Contoso Mail", { exact: true }).click();
  await page.locator('[data-keykeeper="panel-edit"]').click();
  const editing = page.getByRole("dialog", { name: "Edit Login" });
  await expect(editing).toHaveAttribute("data-keykeeper", "item-panel");
  await editing.getByRole("textbox", { name: /Item name/ }).fill("Contoso Mail (work)");

  // A new item in a dialog over it, at the same time: its Save saves the new
  // item, not the panel's (each form has an id of its own).
  await newItem(page, "Login");
  const added = page.getByRole("dialog", { name: "Add login" });
  await added.getByRole("textbox", { name: /Item name/ }).fill("Fabrikam VPN");
  await added.getByRole("button", { name: "Save" }).click();
  const addedView = page.getByRole("dialog", { name: "View Login" });
  await addedView.getByRole("button", { name: "Close" }).first().click();
  await expect(addedView).toBeHidden();
  await expect(row(page, "Fabrikam VPN")).toBeVisible();
  await expect(row(page, "Contoso Mail (work)")).toHaveCount(0);
  // The panel still has its edit, and the address names its item again.
  await expect(editing.getByRole("textbox", { name: /Item name/ })).toHaveValue("Contoso Mail (work)");
  await expect(page).toHaveURL(/action=edit/);

  // Another row asks before the edits go; going back to editing keeps them.
  await row(page, "Visa ending 4242").getByText("Visa ending 4242", { exact: true }).click();
  const discard = page.getByRole("dialog", { name: "Discard edits" });
  await discard.getByRole("button", { name: "Back to editing" }).click();
  await expect(discard).toBeHidden();
  await expect(editing.getByRole("textbox", { name: /Item name/ })).toHaveValue("Contoso Mail (work)");
  await expect(page.getByRole("dialog", { name: "View Card" })).toHaveCount(0);

  // Close asks too; discarding closes it, and nothing was saved.
  await editing.getByRole("button", { name: "Close" }).first().click();
  await discard.getByRole("button", { name: "Discard edits" }).click();
  await expect(editing).toBeHidden();
  await expect(row(page, "Contoso Mail")).toBeVisible();
  await expect(page).not.toHaveURL(/itemId=/);

  // A link to an item (Back from another page, or the MSP console's) opens it
  // in the panel, once, with the list loaded beside it.
  const button = row(page, "Visa ending 4242").locator('[id^="cipher-btn-"]');
  const id = (await button.getAttribute("id"))!.replace("cipher-btn-", "");
  await page.goto("/#/sends");
  await page.goto(`/#/vault?itemId=${id}&action=view`);
  await expect(page.getByRole("dialog", { name: "View Card" })).toBeVisible();
  await expect(row(page, "Contoso Mail")).toBeVisible();
  await expect(row(page, "Visa ending 4242")).toHaveAttribute("data-keykeeper-open", "");
});

test("on a phone, the open item's panel lies over the list: solid, and no wider than the screen", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await signUp(page, webUserFor("look-phone-panel", testInfo.repeatEachIndex));
  await save(page, "Login", "Contoso Mail");

  await page.setViewportSize({ width: 390, height: 844 });
  await row(page, "Contoso Mail").getByText("Contoso Mail", { exact: true }).click();
  const panel = page.getByRole("dialog", { name: "View Login" });
  await expect(panel).toBeVisible();
  const card = panel.locator(":scope > section");
  const alpha = () =>
    card.evaluate((el) => {
      const parts = getComputedStyle(el).backgroundColor.match(/[\d.]+/g)!.map(Number);
      return parts[3] ?? 1;
    });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect.poll(() => look(page)).toEqual(["pb-web", `theme_${scheme}`]);
    // Solid, so the list under it doesn't show through (in dark mode the
    // panel beside the list is translucent).
    await expect.poll(alpha).toBe(1);
    // Within the screen, with Close in view.
    const box = (await card.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await expect(panel.getByRole("button", { name: "Close" }).first()).toBeInViewport({ ratio: 1 });
  }
});
