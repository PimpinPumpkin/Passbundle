// PassBundle's look (DESIGN.md, "The look"): Glass by default, light or dark
// like the device; Light and Dark are solid, for legibility; Figtree and our
// artwork in every theme.
import { expect, test, type Page } from "@playwright/test";

import { brand } from "../paths.mjs";

import { signUp, webUserFor } from "./support/web";

/** The page's theme classes: pb-glass turns the translucent look on. */
const look = (page: Page) =>
  page.evaluate(() =>
    [...document.documentElement.classList]
      .filter((c) => c === "pb-glass" || c.startsWith("theme_"))
      .sort(),
  );

/** Illustrations that aren't ours: every drawing upstream draws is replaced. */
const upstreamArt = (page: Page) =>
  page.locator("bit-svg svg:not([data-art]):not([data-brand])").count();

test("the web vault's page, before the app starts, has the brand's color and our drawings", async ({
  request,
}) => {
  const html = await (await request.get("/")).text();
  expect(html).toContain(`<meta name="theme-color" content="${brand.color}"`);
  expect(html.match(/data-art="passbundle"/g)).toHaveLength(2);
  expect(html).not.toContain("#175DDC");
});

test("the look is Glass by default, Light and Dark are solid, and the type and artwork are ours", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await page.goto("/#/signup");
  await expect(page.locator("bit-svg svg[data-art]").first()).toBeVisible();
  expect(await upstreamArt(page)).toBe(0);

  const user = webUserFor("look", testInfo.repeatEachIndex);
  await signUp(page, user);
  await expect(page.getByText("No items in the vault")).toBeVisible();
  expect(await upstreamArt(page)).toBe(0);
  expect(await look(page)).toEqual(["pb-glass", "theme_light"]);
  const font = await page.evaluate(async () => {
    await document.fonts.ready;
    return {
      family: getComputedStyle(document.body).fontFamily,
      loaded: document.fonts.check('16px "Figtree"'),
    };
  });
  expect(font.family).toMatch(/^"?Figtree/);
  expect(font.loaded).toBe(true);

  // Glass follows the device.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => look(page)).toEqual(["pb-glass", "theme_dark"]);
  await page.emulateMedia({ colorScheme: "light" });

  // The setting: Glass first, then the solid themes.
  await page.goto("/#/settings/appearance");
  const theme = page.getByRole("combobox", { name: "Theme" });
  // The picker shows its value beside the search box.
  await expect(page.getByText("Glass (default)", { exact: true })).toBeVisible();
  await theme.click();
  await expect(page.getByRole("option")).toHaveText(["Glass (default)", "Light", "Dark"]);
  await page.getByRole("option", { name: "Dark", exact: true }).click();
  await expect.poll(() => look(page)).toEqual(["theme_dark"]);
  await theme.click();
  await page.getByRole("option", { name: "Light", exact: true }).click();
  await expect.poll(() => look(page)).toEqual(["theme_light"]);

  // The choice holds across a reload, before the app has started. (A reload
  // locks the web vault: its keys live in memory.)
  await page.reload();
  expect(await look(page)).toEqual(["theme_light"]);
  await page.getByLabel(/Master password/).fill(user.password);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  // Unlocking goes back to the page it was on.
  await page.waitForURL((url) => !url.hash.includes("lock"));

  await page.goto("/#/settings/appearance");
  await theme.click();
  await page.getByRole("option", { name: "Glass (default)" }).click();
  await expect.poll(() => look(page)).toEqual(["pb-glass", "theme_light"]);
});
