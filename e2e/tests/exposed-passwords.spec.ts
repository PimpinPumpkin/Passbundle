// Exposed passwords (DESIGN.md, "Exposed passwords"): the MSP console, a
// person's Health, and the count beside Health check passwords against Have
// I Been Pwned's Pwned Passwords with k-anonymity. The test browser resolves
// no outside host, so api.pwnedpasswords.com is a stand-in here (Playwright
// answers for it), and every request it gets is checked: a GET for a
// 5-character prefix of a password's SHA-1 hash, asking for padding, and
// nothing else (no cookies, no referrer, no suffix, no password).
import { createHash } from "node:crypto";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { menu, reloadVault, signUp, signUpWithAuthenticator, webUserFor } from "./support/web";

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex").toUpperCase();

/** In "breaches" in the stand-in; long enough that none of them is weak. */
const BREACHED = "Tr0ub4dor&3-lighthouse-bay-1987";
const BREACHED_TIMES = 4821;
const SHARED = "quiet-lantern-harbor-meadow-58";
const UNIQUE = "kettle-orbit-violet-73-quarry";
/** Weak by upstream's rule (a score of 2 or less out of 4), and not in the stand-in's breaches. */
const WEAK = "password1";

type Asked = {
  method: string;
  path: string;
  search: string;
  body: string | null;
  headers: Record<string, string>;
};

/**
 * A stand-in for the range API that knows the given passwords, padded with
 * decoys the way the real one pads, recording each request it gets.
 */
async function pwnedPasswords(context: BrowserContext, breached: Record<string, number>) {
  const asked: Asked[] = [];
  const known = [...Object.entries(breached)].map(([password, times]) => [sha1(password), times] as const);
  await context.route("https://api.pwnedpasswords.com/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    asked.push({
      method: request.method(),
      path: url.pathname,
      search: url.search,
      body: request.postData(),
      headers: await request.allHeaders(),
    });
    const prefix = url.pathname.slice("/range/".length);
    // The real service pads to hundreds of lines; the apps refuse fewer.
    const lines = Array.from({ length: 400 }, (_, i) => `${sha1(`decoy ${prefix} ${i}`).slice(5)}:0`);
    for (const [hash, times] of known) {
      if (hash.startsWith(prefix)) {
        lines.push(`${hash.slice(5)}:${times}`);
      }
    }
    await route.fulfill({
      status: 200,
      contentType: "text/plain",
      headers: { "access-control-allow-origin": "*" },
      body: lines.sort().join("\r\n"),
    });
  });
  return asked;
}

/** Every request was a padded GET for a 5-character prefix, carrying nothing about the passwords. */
function expectOnlyPrefixes(asked: Asked[], passwords: string[]) {
  expect(asked.length).toBeGreaterThan(0);
  for (const request of asked) {
    expect(request.method).toBe("GET");
    expect(request.path).toMatch(/^\/range\/[0-9A-F]{5}$/);
    expect(request.search).toBe("");
    expect(request.body ?? "").toBe("");
    expect(request.headers["add-padding"]).toBe("true");
    expect(request.headers["cookie"]).toBeUndefined();
    expect(request.headers["referer"]).toBeUndefined();
    expect(request.headers["authorization"]).toBeUndefined();
    const sent = JSON.stringify(request).toUpperCase();
    for (const password of passwords) {
      expect(sent).not.toContain(password.toUpperCase());
      expect(sent).not.toContain(sha1(password).slice(5));
    }
  }
}

const askedFor = (asked: Asked[], password: string) =>
  asked.filter((a) => a.path === `/range/${sha1(password).slice(0, 5)}`).length;

/** The browser can't reach the service at all, as on a firewalled network. */
async function cutOff(context: BrowserContext) {
  await context.unrouteAll({ behavior: "ignoreErrors" });
  await context.route("https://api.pwnedpasswords.com/**", (route) => route.abort("internetdisconnected"));
}


/** Adds a login to a client's Everyone folder from its admin console. */
async function addClientLogin(page: Page, clientUrl: string, name: string, password: string) {
  await page.goto(`${clientUrl}/vault`);
  // The page before can still be showing for a moment, with its own
  // Everyone; pick this client's, so the new item lands in it.
  const organizationId = clientUrl.slice(clientUrl.lastIndexOf("/") + 1);
  await expect(async () => {
    await page.getByRole("button", { name: "Everyone", exact: true }).first().click();
    await expect(page).toHaveURL(new RegExp(`/organizations/${organizationId}/vault\\?.*collectionId=`), {
      timeout: 2_000,
    });
  }).toPass({ timeout: 30_000 });
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Login" }).click();
  const item = page.getByRole("dialog", { name: "New Login" });
  await item.getByRole("textbox", { name: /Item name/ }).fill(name);
  await item.getByRole("textbox", { name: "Username", exact: true }).fill("it@clients.test");
  await item.getByRole("textbox", { name: "Password", exact: true }).fill(password);
  await item.getByRole("button", { name: "Save" }).click();
  await expect(item).toBeHidden();
  // Saving opens the item's view; close it.
  await page.getByRole("dialog", { name: "View Login" }).getByRole("button", { name: "Close" }).first().click();
}

/** A person's logins: one breached, two sharing a password, one weak, one fine. */
const HEALTH_LOGINS: [string, string][] = [
  ["Northwind Bank", BREACHED],
  ["Mail", SHARED],
  ["Forum", SHARED],
  ["Old router", WEAK],
  ["Library", UNIQUE],
];

/** Imports logins into the person's own vault. */
async function importLogins(page: Page, logins: [string, string][]) {
  const items = logins.map(([name, password]) => ({
    type: 1,
    name,
    login: { username: "pat@example.test", password },
  }));
  await page.goto("/#/tools/import");
  await page.getByRole("combobox", { name: /File format/ }).click();
  await page.getByRole("option", { name: "Bitwarden (json)" }).click();
  await page
    .getByRole("textbox", { name: /copy\/paste the import file contents/ })
    .fill(JSON.stringify({ encrypted: false, folders: [], items }));
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByRole("dialog", { name: "Data successfully imported" }).getByRole("button", { name: "Ok" }).click();
}

/** Adds a client from the console and returns its admin console's address. */
async function addClient(page: Page, name: string): Promise<string> {
  await page.goto("/#/msp");
  await page.getByRole("textbox", { name: "New client's name" }).fill(name);
  await page.getByRole("button", { name: "Add client" }).click();
  const open = page.getByTestId(`msp-client-${name}`).getByRole("link", { name: "Open" });
  await open.click();
  await expect(page).toHaveURL(/#\/organizations\/[^/]+\/members/);
  return page.url().replace(/\/members.*$/, "");
}

test("the MSP console counts each client's exposed passwords from hash prefixes, remembers them by item, and lists them by name", async ({
  browser,
}, testInfo) => {
  // Several clients and items through the UI; CI machines are slower.
  test.setTimeout(240_000);
  const context = await browser.newContext();
  const asked = await pwnedPasswords(context, { [BREACHED]: BREACHED_TIMES });
  const page = await context.newPage();
  const user = webUserFor("exposed-msp", testInfo.repeatEachIndex);
  await signUpWithAuthenticator(page, user);

  await page.goto("/#/msp");
  await page.getByRole("textbox", { name: "Your MSP's name" }).fill("Hollow Pine IT");
  await page.getByRole("button", { name: "Create MSP" }).click();
  await expect(page.getByTestId("msp-name")).toContainText("Hollow Pine IT");
  const acme = await addClient(page, "Acme Dental");
  const baker = await addClient(page, "Baker Law");

  // The same breached password in two clients, and one that's fine.
  await addClientLogin(page, acme, "Router admin", BREACHED);
  await addClientLogin(page, acme, "Front desk PC", UNIQUE);
  await addClientLogin(page, baker, "Copier", BREACHED);

  await page.goto("/#/msp");
  const acmeRow = page.getByTestId("msp-client-Acme Dental");
  const bakerRow = page.getByTestId("msp-client-Baker Law");
  await expect(acmeRow.getByTestId("msp-client-exposed")).toHaveText("1");
  await expect(bakerRow.getByTestId("msp-client-exposed")).toHaveText("1");
  await expect(acmeRow.getByTestId("msp-client-weak")).toHaveText("0");
  await expect(acmeRow.getByTestId("msp-client-reused")).toHaveText("0");
  // A password shared between two clients isn't one client's reuse.
  await expect(bakerRow.getByTestId("msp-client-reused")).toHaveText("0");
  await expect(page.getByTestId("msp-exposed-progress")).toHaveCount(0);
  await expect(page.getByTestId("msp-exposed-unchecked")).toHaveCount(0);

  // Only prefixes went out.
  expectOnlyPrefixes(asked, [BREACHED, UNIQUE, user.password]);
  expect(askedFor(asked, BREACHED)).toBeGreaterThan(0);
  // What the console found is remembered by item version, so working it out
  // again (it does after every action) asks nothing more.
  const sentSoFar = asked.length;
  await page.goto("/#/vault");
  await page.goto("/#/msp");
  await expect(acmeRow.getByTestId("msp-client-exposed")).toHaveText("1");
  await expect(bakerRow.getByTestId("msp-client-exposed")).toHaveText("1");
  expect(asked.length).toBe(sentSoFar);

  // A count with something to fix opens the client's list of what to fix,
  // by name; a count of 0 doesn't.
  await expect(acmeRow.getByTestId("msp-client-weak").getByRole("button")).toHaveCount(0);
  await acmeRow
    .getByTestId("msp-client-exposed")
    .getByRole("button", { name: "Show the exposed passwords in Acme Dental: 1" })
    .click();
  const details = page.getByTestId("msp-health-details");
  await expect(details).toContainText("Passwords to fix in Acme Dental");
  const router = details.getByTestId("msp-health-item-Router admin");
  await expect(router).toContainText("Exposed 4,821 times");
  await expect(details.getByTestId("msp-health-item-Front desk PC")).toHaveCount(0);
  await expect(details).not.toContainText(BREACHED);
  await router.getByRole("link", { name: "Open Router admin" }).click();
  await expect(page).toHaveURL(/#\/organizations\/[0-9a-f-]{36}\/vault\?.*itemId=/);
  const opened = page.getByRole("dialog", { name: /^View/ });
  await expect(opened).toContainText("Router admin");
  await opened.getByRole("button", { name: "Close" }).first().click();

  // Firewalled: the console says it couldn't check, and keeps the rest.
  await cutOff(context);
  await reloadVault(page);
  await page.goto("/#/msp");
  const unchecked = page.getByTestId("msp-exposed-unchecked");
  await expect(unchecked).toContainText("Couldn't check for exposed passwords");
  // Counted in items: Router admin, Front desk PC, and Copier.
  await expect(unchecked).toContainText("3 items couldn't be checked");
  await expect(acmeRow.getByTestId("msp-client-exposed")).toHaveText("Couldn't check");
  await expect(acmeRow.getByTestId("msp-client-weak")).toHaveText("0");

  // Reachable again: Try again checks, and the counts come back.
  await context.unrouteAll({ behavior: "ignoreErrors" });
  const askedAgain = await pwnedPasswords(context, { [BREACHED]: BREACHED_TIMES });
  await unchecked.getByRole("button", { name: "Try again" }).click();
  await expect(acmeRow.getByTestId("msp-client-exposed")).toHaveText("1");
  await expect(bakerRow.getByTestId("msp-client-exposed")).toHaveText("1");
  await expect(unchecked).toHaveCount(0);
  expectOnlyPrefixes(askedAgain, [BREACHED, UNIQUE, user.password]);

  await context.close();
});

test("a person's Health counts the items to fix beside it, and its exposed passwords report lists the breached one, checked from hash prefixes", async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  const context = await browser.newContext();
  const asked = await pwnedPasswords(context, { [BREACHED]: BREACHED_TIMES });
  const page = await context.newPage();
  const user = webUserFor("exposed-health", testInfo.repeatEachIndex);
  await signUp(page, user);

  await importLogins(page, HEALTH_LOGINS);

  // Beside Health: the breached one, the two that share a password, and the
  // weak one. Worked out after unlocking, without holding the vault up.
  const count = menu(page).getByTestId("keykeeper-health-count");
  await expect(count).toHaveText("4", { timeout: 30_000 });
  await expect(count).toHaveAttribute("aria-label", "4 items to fix: weak, reused, or exposed passwords");

  // The exposed passwords report says what it sends, and finds the breached one.
  await count.click();
  await expect(page).toHaveURL(/#\/reports$/);
  await page.getByText("Exposed passwords", { exact: true }).click();
  await expect(page).toHaveURL(/exposed-passwords-report/);
  await expect(page.getByTestId("keykeeper-exposed-privacy")).toContainText(
    "only the first 5 characters of its SHA-1 hash leave your browser",
  );
  const rows = page.locator("bit-table-scroll tr:has(td)");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Northwind Bank");
  await expect(rows.first()).toContainText("Exposed 4,821 time(s)");
  expectOnlyPrefixes(asked, [BREACHED, SHARED, WEAK, UNIQUE, user.password]);
  // The count asked about each once; the report, opened by hand, asks again,
  // since nothing about a password is kept.
  for (const password of [BREACHED, SHARED, WEAK, UNIQUE]) {
    expect(askedFor(asked, password)).toBe(2);
  }

  // Firewalled: the count keeps weak and reused and says it couldn't check,
  // and the report says what it couldn't check, never "good news".
  await cutOff(context);
  await reloadVault(page);
  await expect(count).toHaveText("3", { timeout: 30_000 });
  await expect(count.getByTestId("keykeeper-health-unchecked")).toBeVisible({ timeout: 30_000 });
  await expect(count).toHaveAttribute(
    "aria-label",
    "3 items to fix: weak, reused, or exposed passwords. Couldn't check for breaches",
  );
  await page.goto("/#/reports/exposed-passwords-report");
  await expect(page.getByTestId("keykeeper-exposed-unchecked")).toContainText(
    "5 items couldn't be checked for breaches",
  );
  await expect(page.getByText("Good news")).toHaveCount(0);

  await context.close();
});

test("with checking after unlocking turned off, nothing goes to the breach service until the person asks", async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const context = await browser.newContext();
  const asked = await pwnedPasswords(context, { [BREACHED]: BREACHED_TIMES });
  const page = await context.newPage();
  const user = webUserFor("exposed-off", testInfo.repeatEachIndex);
  // They make an MSP later, whose staff sign in with two-step login.
  await signUpWithAuthenticator(page, user);

  // The switch, on by default, per account.
  await page.goto("/#/settings/appearance");
  const setting = page.getByRole("checkbox", {
    name: "Check my passwords against known breaches after unlocking",
  });
  await expect(setting).toBeChecked();
  await setting.uncheck();
  await expect(setting).not.toBeChecked();

  await importLogins(page, HEALTH_LOGINS);
  // A new session: the choice is kept, and after unlocking the count is
  // weak and reused only, without a single request.
  await reloadVault(page);
  const sentBefore = asked.length;
  const count = menu(page).getByTestId("keykeeper-health-count");
  await expect(count).toHaveText("3", { timeout: 30_000 });
  // Well past when the count would have asked.
  await page.waitForTimeout(6_000);
  await expect(count).toHaveText("3");
  // Not a failed check, so no sign that it couldn't check.
  await expect(count.getByTestId("keykeeper-health-unchecked")).toHaveCount(0);
  expect(asked.length).toBe(sentBefore);

  // The MSP console waits for its button, and still counts weak and reused.
  await page.goto("/#/msp");
  await page.getByRole("textbox", { name: "Your MSP's name" }).fill("Quiet Cove IT");
  await page.getByRole("button", { name: "Create MSP" }).click();
  const client = await addClient(page, "Dune Bakery");
  await addClientLogin(page, client, "Oven controller", BREACHED);
  await addClientLogin(page, client, "Point of sale", WEAK);
  await page.goto("/#/msp");
  const row = page.getByTestId("msp-client-Dune Bakery");
  await expect(row.getByTestId("msp-client-weak")).toHaveText("1");
  await expect(row.getByTestId("msp-client-exposed")).toHaveText("Not checked");
  const off = page.getByTestId("msp-exposed-off");
  await expect(off).toContainText("Your settings don't check passwords against known breaches after unlocking");
  await page.waitForTimeout(6_000);
  expect(asked.length).toBe(sentBefore);

  // Asked: the console checks, from prefixes only.
  await off.getByRole("button", { name: "Check exposed passwords" }).click();
  await expect(row.getByTestId("msp-client-exposed")).toHaveText("1");
  await expect(off).toHaveCount(0);
  const sent = asked.slice(sentBefore);
  expect(sent.length).toBeGreaterThan(0);
  expectOnlyPrefixes(sent, [BREACHED, WEAK, user.password]);

  // Opening the exposed passwords report checks too, as asked.
  await page.goto("/#/reports/exposed-passwords-report");
  await expect(page.locator("bit-table-scroll tr:has(td)").filter({ hasText: "Northwind Bank" })).toBeVisible();
  expectOnlyPrefixes(asked.slice(sentBefore), [BREACHED, SHARED, WEAK, UNIQUE, user.password]);

  // Turned back on in another tab: this tab follows without a reload, and
  // the console checks on its own again.
  // Opened from this one, as a person does, so it's the same signed-in session.
  const [other] = await Promise.all([
    context.waitForEvent("page"),
    page.evaluate(() => window.open(`${location.origin}/#/settings/appearance`)),
  ]);
  const masterPassword = other.getByRole("textbox", { name: /^Master password/ });
  const otherSetting = other.getByRole("checkbox", {
    name: "Check my passwords against known breaches after unlocking",
  });
  await expect(masterPassword.or(otherSetting)).toBeVisible();
  if (await masterPassword.isVisible()) {
    await masterPassword.fill(user.password);
    await other.getByRole("button", { name: "Unlock", exact: true }).click();
    await expect(masterPassword).toBeHidden();
    await other.goto("/#/settings/appearance");
  }
  await expect(otherSetting).not.toBeChecked();
  await otherSetting.check();
  await expect(otherSetting).toBeChecked();
  await other.close();
  await page.goto("/#/msp");
  await expect(row.getByTestId("msp-client-exposed")).toHaveText("1");
  await expect(page.getByTestId("msp-exposed-off")).toHaveCount(0);

  await context.close();
});
