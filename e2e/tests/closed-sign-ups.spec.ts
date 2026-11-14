// What the web vault and the browser extension show on a server that isn't
// taking new accounts (DESIGN.md, "New accounts on a closed server"): one
// plain sentence where "Create account" would be, and at the sign-up address
// itself, with who to ask. On a server that takes new accounts at some email
// domains the form stays, and an address outside them gets its sentence under
// the email field.
//
// The tests start a server of their own (support/closed-server.ts). Reached
// by its own address it's a server someone runs; reached under the hosted
// service's name, which goes to it here and nowhere else, the apps take it
// for the service.
import fs from "node:fs";

import { expect, type Locator, type Page, test } from "@playwright/test";

import { brand, closedServerPort, siteHost } from "../paths.mjs";

import { ClosedServer, closedServer } from "./support/closed-server";
import { extensionIdOf, launchWithExtension, openPopup } from "./support/extension";

const rules = `--host-resolver-rules=MAP ${siteHost} 127.0.0.1:${closedServerPort}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`;
const service = `https://${siteHost}`;
const contactPage = `${brand.urls.website}/contact/`;

const OWN_SERVER = "This server isn't taking new accounts. Ask the person who runs it.";
// The service's sentence, then its link.
const SERVICE = "New accounts aren't open yet. Ask for one";
const OWN_SERVER_ADDRESS =
  "New accounts aren't open for that address. Ask the person who runs this server.";
const SERVICE_ADDRESS = "New accounts aren't open for that address. Ask for one";

test.use({ launchOptions: { args: [rules] } });
test.describe.configure({ mode: "serial" });

const server = new ClosedServer();
test.afterAll(() => server.remove());

const closed = (page: Page) => page.getByTestId("keykeeper-new-accounts-closed");
const createAccountLink = (page: Page) => page.getByTestId("login-create-account-link");

/** For each line of a sentence: whether something else is painted over its middle. */
const linesCovered = (sentence: Locator) =>
  sentence.evaluate((el) =>
    [...el.getClientRects()].map((line) => {
      const top = document.elementFromPoint(
        line.left + line.width / 2,
        line.top + line.height / 2,
      );
      return !(top && el.contains(top));
    }),
  );

/** The link to the website's Contact page, in a new tab. */
async function expectAskForOne(page: Page) {
  const ask = page.getByTestId("keykeeper-ask-for-account");
  await expect(ask).toHaveText("Ask for one");
  await expect(ask).toHaveAttribute("href", contactPage);
  await expect(ask).toHaveAttribute("target", "_blank");
}

test.describe("a server closed to everyone", () => {
  // It sends email: without it, invited people come in by the sign-up form,
  // so the server keeps the form on (tests/mail/closed-sign-ups.spec.ts).
  test.beforeAll(() => server.start("closed", { mail: true }));

  test("the web vault says the server isn't taking new accounts, on the sign-in page and at the sign-up address", async ({
    page,
  }) => {
    await page.goto(`${closedServer}/#/login`);
    await expect(closed(page)).toHaveText(OWN_SERVER);
    await expect(createAccountLink(page)).toHaveCount(0);
    await expect(page.getByTestId("keykeeper-ask-for-account")).toHaveCount(0);
    // Signing in is still there.
    await expect(page.getByLabel(/Email address/)).toBeVisible();

    // The address typed by hand: the same sentence, and no form to fill in.
    await page.goto(`${closedServer}/#/signup`);
    await expect(closed(page)).toHaveText(OWN_SERVER);
    await expect(page.getByLabel(/Email address/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Continue" })).toHaveCount(0);
  });

  test("on the service, the web vault says new accounts aren't open yet and links to the website's Contact page", async ({
    page,
  }) => {
    await page.goto(`${service}/#/login`);
    await expect(closed(page)).toHaveText(SERVICE);
    await expectAskForOne(page);
    await expect(createAccountLink(page)).toHaveCount(0);
    await expect(page.getByLabel(/Email address/)).toBeVisible();

    await page.goto(`${service}/#/signup`);
    await expect(closed(page)).toHaveText(SERVICE);
    await expectAskForOne(page);
    await expect(page.getByLabel(/Email address/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Continue" })).toHaveCount(0);
  });

  test("the extension says so on its first screen, under sign-in and at the sign-up address, for the service and for a server someone runs", async () => {
    const { context, profile } = await launchWithExtension(rules);
    try {
      const extensionId = await extensionIdOf(context);
      const popup = await openPopup(context, extensionId);

      // The first screen, which starts out on the service: the sentence in
      // place of the Create account button, and signing in as the way on.
      await expect(closed(popup)).toHaveText(SERVICE);
      await expectAskForOne(popup);
      await expect(popup.getByTestId("intro-create-account")).toHaveCount(0);
      await expect(popup.getByRole("button", { name: "Create account" })).toHaveCount(0);
      // The carousel renders its buttons before Angular wires them up, and an
      // early click is dropped. Click until the app actually navigates.
      await expect(async () => {
        await popup.getByRole("button", { name: "Sign in", exact: true }).click();
        await expect(popup).toHaveURL(/#\/login/, { timeout: 1000 });
      }).toPass();

      // Under sign-in, on the service.
      await expect(closed(popup)).toHaveText(SERVICE);
      await expectAskForOne(popup);
      await expect(popup.getByTestId("keykeeper-new-here")).toHaveCount(0);
      await expect(createAccountLink(popup)).toHaveCount(0);

      // And on a server someone runs, once its address is in: it's saved
      // when the field is left.
      const where = popup.getByRole("group", { name: "Where's your vault?" });
      await where.getByRole("button", { name: "Self-hosted" }).click();
      const address = popup.getByRole("textbox", { name: "Server address" });
      await address.fill(`127.0.0.1:${closedServerPort}`);
      await address.press("Tab");
      await expect(closed(popup)).toHaveText(OWN_SERVER);
      await expect(popup.getByTestId("keykeeper-ask-for-account")).toHaveCount(0);
      await expect(createAccountLink(popup)).toHaveCount(0);

      // At the popup's own size this form is taller than the window, and the
      // sentence under it takes two lines. Scrolled to, both can be read:
      // nothing lies over either.
      await popup.setViewportSize({ width: 380, height: 600 });
      await closed(popup).scrollIntoViewIfNeeded();
      await expect.poll(() => linesCovered(closed(popup))).toEqual([false, false]);

      // The sign-up address itself, for that server.
      await popup.goto(`chrome-extension://${extensionId}/popup/index.html#/signup`);
      await expect(closed(popup)).toHaveText(OWN_SERVER);
      await expect(popup.getByLabel(/Email address/)).toHaveCount(0);
      await expect(popup.getByRole("button", { name: "Continue" })).toHaveCount(0);
    } finally {
      await context.close();
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });
});

test.describe("a server that takes new accounts at some email domains", () => {
  const ALLOWED = "allowed.example.test";
  const run = Date.now();
  const outside = `outside-${run}@elsewhere.example.test`;

  test.beforeAll(() => server.start({ domains: [ALLOWED] }, { mail: false }));

  /** Fills the sign-up form's first step in and sends it. */
  async function tryAddress(page: Page, email: string) {
    await page.getByLabel(/Email address/).fill(email);
    await page.getByLabel("Name").fill("New Person");
    await page.getByRole("button", { name: "Continue" }).click();
  }

  test("the form stays, and an address outside them gets one sentence under the email field", async ({
    page,
  }) => {
    // The apps aren't told the domains, in any answer the pages get.
    const answers: Promise<string>[] = [];
    page.on("response", (response) => {
      if (/\/(api|identity)\//.test(response.url())) {
        answers.push(response.text().catch(() => ""));
      }
    });

    await page.goto(`${closedServer}/#/login`);
    await expect(createAccountLink(page)).toBeVisible();
    await expect(closed(page)).toHaveCount(0);
    await createAccountLink(page).click();

    await tryAddress(page, outside);
    const refused = page.getByTestId("keykeeper-new-account-refused");
    await expect(refused).toHaveText(OWN_SERVER_ADDRESS);
    await expect(refused).toHaveAttribute("role", "alert");
    // In the form, not in an error toast, and the form is still there to try
    // another address.
    await expect(page.locator("bit-toast")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();

    // Another address clears it, and one at an allowed domain goes on to the
    // password.
    await page.getByLabel(/Email address/).fill(`welcome-${run}@${ALLOWED}`);
    await expect(refused).toHaveCount(0);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("textbox", { name: /^Master password/ }).first()).toBeVisible();

    const said = (await Promise.all(answers)).join("\n");
    expect(said).toContain("keykeeperNewAccounts");
    expect(said).not.toContain("allowed.example");
  });

  test("on the service, that sentence comes with the link to the website's Contact page", async ({ page }) => {
    await page.goto(`${service}/#/signup`);
    await tryAddress(page, outside);
    const refused = page.getByTestId("keykeeper-new-account-refused");
    await expect(refused).toHaveText(SERVICE_ADDRESS);
    await expectAskForOne(page);
    await expect(page.locator("bit-toast")).toHaveCount(0);
  });
});
