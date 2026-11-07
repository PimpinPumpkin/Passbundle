// First steps in the web vault that used to trip people (DESIGN.md, "UX we
// commit to"): the import step names the menu it's in; making an MSP or a
// business organization without two-step login explains first and offers to
// set it up, with a way back that keeps what was typed, instead of signing
// out at once; New organization leads to Set up your MSP; and an MSP
// console that can't load says so, with Try again, never Create MSP.
import { expect, test, type Page } from "@playwright/test";

import { giveAuthenticator } from "./support/two-step";
import { signUp, signUpWithAuthenticator, skipImport, startSignUp, webUserFor } from "./support/web";

/** A toast message. Toasts here have no ARIA role, so find them by text. */
const toast = (page: Page, text: string) => page.getByText(text, { exact: true });

test("an MSP made without two-step login asks to set it up first, comes back with its name, and stays signed in", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const user = webUserFor("first-msp", testInfo.repeatEachIndex);
  // The import step at sign-up names the menu it's in.
  await startSignUp(page, user);
  await expect(page.getByText(/do it later from Import and export, Import, in the menu/)).toBeVisible();
  await skipImport(page);

  await page.goto("/#/msp");
  await expect(page.getByTestId("msp-setup-two-step")).toContainText(
    "Set it up before you make your MSP, so you stay signed in.",
  );
  await page.getByRole("textbox", { name: "Your MSP's name" }).fill("Harbor IT");
  await page.getByRole("button", { name: "Create MSP" }).click();
  const first = page.getByRole("dialog", { name: "Set up two-step login first" });
  await expect(first).toContainText("Without it, making Harbor IT would sign you out right away.");
  // Not now: nothing is made, and nothing signs them out.
  await first.getByRole("button", { name: "Not now" }).click();
  await expect(first).toBeHidden();
  await expect(page).toHaveURL(/#\/msp$/);
  await expect(page.getByRole("textbox", { name: "Your MSP's name" })).toHaveValue("Harbor IT");

  // Set it up: the Two-step login page has the way back.
  await page.getByRole("button", { name: "Create MSP" }).click();
  await first.getByRole("button", { name: "Set up two-step login" }).click();
  await page.waitForURL(/#\/settings\/security\/two-factor/);
  const detour = page.getByTestId("two-step-detour");
  await expect(detour).toContainText("Harbor IT is still filled in.");
  // They turn on an authenticator app (here over the API, as a person would
  // on this page), then go back.
  await giveAuthenticator(request, user);
  await detour.getByRole("button", { name: "Back to Set up your MSP" }).click();
  await page.waitForURL(/#\/msp$/);
  await expect(page.getByRole("textbox", { name: "Your MSP's name" })).toHaveValue("Harbor IT");
  await expect(page.getByTestId("msp-setup-two-step")).toHaveCount(0);
  await page.getByRole("button", { name: "Create MSP" }).click();
  await expect(page.getByTestId("msp-name")).toContainText("Harbor IT");
  // Still signed in: the console works.
  await page.getByRole("textbox", { name: "New client's name" }).fill("Fourth Coffee");
  await page.getByRole("button", { name: "Add client" }).click();
  await expect(toast(page, "Added Fourth Coffee")).toBeVisible();
  await expect(page).toHaveURL(/#\/msp$/);
});

test("a business made without two-step login asks to set it up first, and New organization leads to Set up your MSP", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const user = webUserFor("first-business", testInfo.repeatEachIndex);
  await signUp(page, user);
  await page.goto("/#/create-organization");
  await page.getByRole("textbox", { name: /Organization name/ }).fill("Tailspin Toys");
  await page.getByRole("radio", { name: /A business/ }).check();
  await expect(page.getByTestId("create-org-two-step")).toContainText(
    "Set it up before you make the organization, so you stay signed in.",
  );
  await page.getByRole("button", { name: "Create organization" }).click();
  const first = page.getByRole("dialog", { name: "Set up two-step login first" });
  await expect(first).toContainText("Without it, making Tailspin Toys would sign you out right away.");
  await first.getByRole("button", { name: "Set up two-step login" }).click();
  await page.waitForURL(/#\/settings\/security\/two-factor/);
  await giveAuthenticator(request, user);
  await page.getByTestId("two-step-detour").getByRole("button", { name: "Back to New organization" }).click();
  await page.waitForURL(/#\/create-organization$/);
  await expect(page.getByRole("textbox", { name: /Organization name/ })).toHaveValue("Tailspin Toys");
  await expect(page.getByRole("radio", { name: /A business/ })).toBeChecked();
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(toast(page, "Created Tailspin Toys")).toBeVisible();
  await page.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  await expect(page.getByRole("button", { name: "Invite member" })).toBeVisible();

  // Someone who runs IT for several companies finds the MSP console from here.
  await page.goto("/#/create-organization");
  await page.getByTestId("create-org-msp").getByRole("link", { name: "Set up your MSP" }).click();
  await page.waitForURL(/#\/msp$/);
  await expect(page.getByRole("textbox", { name: "Your MSP's name" })).toBeVisible();
});

test("an MSP console that can't load says why, with Try again, and never offers Create MSP", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await signUpWithAuthenticator(page, webUserFor("first-offline", testInfo.repeatEachIndex));
  await page.goto("/#/msp");
  await page.getByRole("textbox", { name: "Your MSP's name" }).fill("Northwind IT");
  await page.getByRole("button", { name: "Create MSP" }).click();
  await expect(page.getByTestId("msp-name")).toContainText("Northwind IT");
  await expect(page.getByTestId("msp-no-clients")).toContainText(
    "No clients yet. Add your first one below",
  );

  // Offline: the list of the person's MSPs doesn't arrive.
  const list = /\/api\/keykeeper\/msp$/;
  await page.route(list, (route) => route.abort("internetdisconnected"));
  await page.goto("/#/vault");
  await page.goto("/#/msp");
  const error = page.getByTestId("msp-load-error");
  await expect(error).toContainText("Couldn't open the MSP console");
  await expect(error).toContainText("This browser couldn't reach the server.");
  await expect(page.getByRole("button", { name: "Create MSP" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Your MSP's name" })).toHaveCount(0);

  // A server error says so too.
  await page.unroute(list);
  await page.route(list, (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: "{}" }),
  );
  await error.getByRole("button", { name: "Try again" }).click();
  await expect(error).toContainText("The server had a problem (error 500).");
  await expect(page.getByRole("button", { name: "Create MSP" })).toHaveCount(0);

  // Back online, Try again opens it.
  await page.unroute(list);
  await error.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("msp-name")).toContainText("Northwind IT");
  await expect(error).toHaveCount(0);
});
