// The start of the autofill corpus: fixture login pages on made-up
// *.example.test hosts, served by fixture-server.mjs over real local HTTPS,
// filled by the real extension. No live network.
import type { BrowserContext, Page } from "@playwright/test";

import { brand } from "../paths.mjs";

import {
  createAccount,
  expect,
  logInPopup,
  openPopup,
  test,
  userFor,
  type User,
} from "./support/extension";
import {
  addLogin,
  codeFieldId,
  extensionFrame,
  hasElementDeep,
  hasNotificationBar,
  chooseFirstInlineMenuItem,
  waitForExtensionScan,
} from "./support/autofill";

// Each test creates an account, logs the extension in, and calibrates the save
// detector before the actual check, so allow more than the default 30 seconds.
test.describe.configure({ timeout: 120_000 });

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

  const page = await context.newPage();
  await page.goto(`${site}/simple-login.html`);
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
  await chooseFirstInlineMenuItem(context, page, "Example login");

  await expect(page.getByLabel("Username")).toHaveValue("alice-example");
  await expect(page.getByLabel("Password")).toHaveValue("not-a-real-password-1");
});

// Calibration, not the thing under test: a real password change on the login
// page must prompt, which proves the save detector is alive in this browser.
// Upstream's detector itself sometimes misses a prompt (see DESIGN.md), so this
// gets up to three tries, each in a fresh tab that is then closed so its
// pending prompt can't show up later. If all three miss, the run is broken and
// the test fails here instead of passing for the wrong reason.
async function proveSaveDetectorWorks(context: BrowserContext, site: string) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const control = await context.newPage();
    await control.goto(`${site}/simple-login.html`);
    await waitForExtensionScan(context, control, "username");
    await control.getByLabel("Username").fill("alice-example");
    await control.getByLabel("Password").fill(`a-changed-password-${attempt}`);
    await control.getByRole("button", { name: "Sign in" }).click();
    const prompted = await expect
      .poll(() => hasNotificationBar(control), { timeout: 10_000 })
      .toBe(true)
      .then(() => true)
      .catch(() => false);
    await control.close();
    if (prompted) return;
  }
  throw new Error("No save prompt for a real password change in three tries: the detector isn't working.");
}

async function setUpSavedLogin(context: BrowserContext, extensionId: string, user: User, site: string) {
  const web = await createAccount(context, user);
  await addLogin(web, {
    name: "Example login",
    username: "alice-example",
    password: "not-a-real-password-1",
    uri: site,
  });
  await web.close();
  await logInPopup(await openPopup(context, extensionId), user);
}

// Absence can only be checked over a window. The calibration shows the prompt
// appears within about a second of a submit; give it five.
async function expectNoPromptAfterSubmit(page: Page) {
  await page.waitForTimeout(5000);
  expect(hasNotificationBar(page)).toBe(false);
}

// Product invariant: a one-time code is never offered as a password to save or
// update. Covers how sites actually build code fields.
for (const codePage of ["otp-tagged.html", "otp-masked.html", "otp-bare.html"]) {
  test(`never offers a one-time code as a password (${codePage})`, async ({
    context,
    extensionId,
  }, testInfo) => {
    const site = "https://login.example.test";
    await setUpSavedLogin(context, extensionId, userFor(codePage.replace(".html", ""), testInfo.repeatEachIndex), site);
    await proveSaveDetectorWorks(context, site);

    const page = await context.newPage();
    await page.goto(`${site}/${codePage}`);
    await waitForExtensionScan(context, page, codeFieldId[codePage]);
    await page.locator("input").first().fill("123456");
    await page.locator("button[type=submit]").click();
    await page.waitForURL(`${site}/signed-in.html`);
    await expectNoPromptAfterSubmit(page);
  });
}

// The way people actually meet code fields: password first, then the code page
// in the same tab, often with a code pasted right away. Upstream keeps a
// sign-in's form data for five seconds and merges a later username-less
// submission into it, which offers the code as a "changed password".
for (const codePage of ["otp-tagged.html", "otp-masked.html", "otp-bare.html"]) {
  test(`never offers the code from a two-step sign-in as a password (${codePage})`, async ({
    context,
    extensionId,
  }, testInfo) => {
    const site = "https://login.example.test";
    const user = userFor(`two-step-${codePage.replace(".html", "")}`, testInfo.repeatEachIndex);
    await setUpSavedLogin(context, extensionId, user, site);
    await proveSaveDetectorWorks(context, site);

    const page = await context.newPage();
    await page.goto(`${site}/login-then-code.html?next=${codePage}`);
    await waitForExtensionScan(context, page, "username");
    // The saved password, unchanged: nothing to offer at this step.
    await page.getByLabel("Username").fill("alice-example");
    await page.getByLabel("Password").fill("not-a-real-password-1");
    const passwordSubmittedAt = Date.now();
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(`${site}/${codePage}`);
    await waitForExtensionScan(context, page, codeFieldId[codePage]);
    await page.locator("input").first().fill("123456");
    await page.locator("button[type=submit]").click();
    // Only a code submitted inside upstream's five-second window can trigger
    // the merge. Slower than that, this test couldn't catch the bug at all.
    expect(Date.now() - passwordSubmittedAt).toBeLessThan(4500);
    await page.waitForURL(`${site}/signed-in.html`);
    await expectNoPromptAfterSubmit(page);
  });
}
