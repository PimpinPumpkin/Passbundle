// MSPs signing up by themselves (DESIGN.md, "MSP console", "Getting there"):
// the website's MSP page links to the web vault's /#/set-up-msp. Someone new
// signs up there and lands on the MSP console's own "Set up your MSP", sets
// it up, and sees the console; someone with an account signs in from the
// sign-up page and lands in the same place; someone signed in goes straight
// there. On a server that doesn't allow setting up an MSP, the console says
// so in the server's words where the form would be, and nobody is signed out.
import { expect, type Page, test } from "@playwright/test";

import { MspSignupsOffServer, mspSignupsOffServer, SET_UP_REFUSED } from "./support/msp-signups-off";
import { answerTwoStep, giveAuthenticator } from "./support/two-step";
import { signUpWithAuthenticator, webUserFor, type WebUser } from "./support/web";

/** The sign-up form, from its first step to Create account, on the page's server. */
async function fillSignUp(page: Page, user: WebUser) {
  await page.getByLabel(/Email address/).fill(user.email);
  await page.getByLabel("Name").fill(user.name);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("textbox", { name: /^Master password/ }).first().fill(user.password);
  await page.getByRole("textbox", { name: /Confirm master password/ }).fill(user.password);
  await page.getByRole("button", { name: "Create account" }).click();
}

/** The console's step for someone on no MSP's staff. */
const setUpStep = (page: Page) => page.getByRole("textbox", { name: "Your MSP's name" });

test("someone new follows the website's link, signs up, lands on Set up your MSP, sets it up, and sees the console", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const user = webUserFor("msp-signup-new", testInfo.repeatEachIndex);

  await page.goto("/#/set-up-msp");
  await page.waitForURL(/#\/signup/);
  await fillSignUp(page, user);

  // Straight to setting up the MSP, not the vault or the offer to import.
  await page.waitForURL(/#\/msp$/);
  await expect(page.getByText("Run all of your clients from one place.")).toBeVisible();
  await expect(setUpStep(page)).toBeVisible();
  // The console's own step, with its own warning: MSP staff need two-step login.
  await expect(page.getByTestId("msp-setup-two-step")).toContainText(
    "Set it up before you make your MSP, so you stay signed in.",
  );
  // They turn on an authenticator app (over the API here, as a person would
  // in Settings), then make their MSP.
  await giveAuthenticator(request, user);
  await setUpStep(page).fill("Harbor Signup IT");
  await page.getByRole("button", { name: "Create MSP" }).click();
  await expect(page.getByTestId("msp-name")).toContainText("Harbor Signup IT");
  await expect(page.getByTestId("msp-no-clients")).toContainText("No clients yet. Add your first one below");
  await expect(page).toHaveURL(/#\/msp$/);

  // Once: the vault opens as usual from now on.
  await page.goto("/#/vault");
  await page.waitForURL(/#\/(setup-import|vault)/);
  await expect(page).not.toHaveURL(/#\/msp/);
});

test("someone with an account follows the link, signs in from the sign-up page, and lands on Set up your MSP; signed in, the link goes straight to the console", async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const user = webUserFor("msp-signup-existing", testInfo.repeatEachIndex);
  // Their account, made earlier in another browser, with an authenticator app.
  const earlier = await browser.newContext();
  try {
    await signUpWithAuthenticator(await earlier.newPage(), user, earlier.request);
  } finally {
    await earlier.close();
  }

  await page.goto("/#/set-up-msp");
  await page.waitForURL(/#\/signup/);
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/#\/login/);
  await page.getByLabel(/Email address/).fill(user.email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("textbox", { name: /Master password/ }).fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await answerTwoStep(page, user.email);

  await page.waitForURL(/#\/msp$/, { timeout: 60_000 });
  await expect(setUpStep(page)).toBeVisible();
  // They have two-step login, so the console doesn't ask for it.
  await expect(page.getByTestId("msp-setup-two-step")).toHaveCount(0);
  await setUpStep(page).fill("Lakeside Signup IT");
  await page.getByRole("button", { name: "Create MSP" }).click();
  await expect(page.getByTestId("msp-name")).toContainText("Lakeside Signup IT");

  // Signed in, the same link goes straight to the console, which shows their MSP.
  await page.goto("/#/vault");
  await page.waitForURL(/#\/(setup-import|vault)/);
  await page.goto("/#/set-up-msp");
  await page.waitForURL(/#\/msp$/);
  await expect(page.getByTestId("msp-name")).toContainText("Lakeside Signup IT");
});

test.describe("on a server that doesn't allow setting up an MSP", () => {
  const server = new MspSignupsOffServer();

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    await server.start();
  });

  test.afterAll(async () => {
    await server.remove();
  });

  test("the link still leads to the console, which says so in plain words where Create MSP would be, and nobody is signed out", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const user = webUserFor("msp-signup-off", testInfo.repeatEachIndex);

    await page.goto(`${mspSignupsOffServer}/#/set-up-msp`);
    await page.waitForURL(/#\/signup/);
    await fillSignUp(page, user);

    await page.waitForURL(/#\/msp$/);
    await expect(page.getByTestId("msp-setup-refused")).toContainText(SET_UP_REFUSED);
    await expect(setUpStep(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Create MSP" })).toHaveCount(0);
    // No warning about two-step login for an MSP they can't make.
    await expect(page.getByTestId("msp-setup-two-step")).toHaveCount(0);

    // Still signed in: the vault opens.
    await page.goto(`${mspSignupsOffServer}/#/vault`);
    await page.waitForURL(/#\/(setup-import|vault)/);
    await expect(page.getByRole("textbox", { name: /^Master password/ })).toHaveCount(0);
  });
});
