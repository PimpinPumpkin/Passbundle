// Screenshots of the real apps for the website, in light and dark: a person's
// vault in the web vault and the extension, the three themes, and an MSP's
// console with five clients and their admin console. Writes WebP images to
// site/static/shots. Run with playwright.site.config.ts.
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, expect, test, type Browser, type Locator, type Page } from "@playwright/test";

import { paths, siteHost, siteHostRules } from "../paths.mjs";
import { Api } from "../tests/api/support";
import { logInPopup } from "../tests/support/extension";
import { confirmMember, signUp, type WebUser } from "../tests/support/web";

import { clientVault, clients, emailOf, personalVault } from "./data";

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../site/static/shots");
const password = "correct horse battery staple 42";
const sam: WebUser = { email: "sam@example.com", name: "Sam Rivera", password };
const jordan: WebUser = { email: "jordan@harborit.example", name: "Jordan Lee", password };
const schemes = ["light", "dark"] as const;
const desktop = { width: 1440, height: 900 };
/** The test server, under the hosted service's name (see siteHostRules). */
const server = `https://${siteHost}`;

let encoder: Page;

/** Saves a PNG screenshot as WebP, encoded by the browser itself. */
async function save(png: Buffer, name: string) {
  const dataUrl = await encoder.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d")!.drawImage(img, 0, 0);
    return canvas.toDataURL("image/webp", 0.86);
  }, png.toString("base64"));
  fs.writeFileSync(path.join(out, `${name}.webp`), Buffer.from(dataUrl.split(",")[1], "base64"));
}

/** A still page: fonts loaded, no pointer hover, no toasts. */
async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  await expect(page.locator("bit-toast")).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(600);
}

async function shoot(target: Page | Locator, name: string) {
  const page = "page" in target ? target.page() : target;
  await settle(page);
  await save(await target.screenshot({ animations: "disabled" }), name);
}

/** Imports an unencrypted Bitwarden JSON export, into an organization when given its admin console URL. */
async function importJson(page: Page, contents: string, orgUrl?: string) {
  await page.goto(orgUrl ? `${orgUrl}/settings/tools/import` : "/#/tools/import");
  await page.getByRole("combobox", { name: /File format/ }).click();
  await page.getByRole("option", { name: "Bitwarden (json)" }).click();
  await page.getByRole("textbox", { name: /copy\/paste the import file contents/ }).fill(contents);
  await page.getByRole("button", { name: "Import", exact: true }).click();
  // Importing into an organization asks first.
  if (orgUrl) await page.getByRole("dialog").getByRole("button", { name: "Yes" }).click();
  const done = page.getByRole("dialog", { name: "Data successfully imported" });
  await done.getByRole("button", { name: "Ok" }).click();
}

async function webPage(browser: Browser) {
  const context = await browser.newContext({
    baseURL: server,
    ignoreHTTPSErrors: true,
    viewport: desktop,
    deviceScaleFactor: 2,
  });
  return context.newPage();
}

test.beforeAll(async ({ browser }) => {
  fs.mkdirSync(out, { recursive: true });
  encoder = await (await browser.newContext()).newPage();
});

test("a person's vault, in the web vault and the extension, in every theme", async ({ browser }) => {
  test.setTimeout(300_000);
  const web = await webPage(browser);
  await signUp(web, sam);
  await importJson(web, personalVault());
  await web.goto("/#/vault");
  await web.getByRole("button", { name: "Dismiss this checklist" }).click();
  for (const scheme of schemes) {
    await web.emulateMedia({ colorScheme: scheme });
    await web.goto("/#/vault");
    await expect(web.getByText("Hometown Credit Union").first()).toBeVisible();
    await shoot(web, `web-vault-${scheme}`);
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-shots-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    locale: "en-US",
    timezoneId: "UTC",
    viewport: { width: 380, height: 600 },
    deviceScaleFactor: 2,
    args: [
      `--disable-extensions-except=${paths.extension}`,
      `--load-extension=${paths.extension}`,
      "--ignore-certificate-errors",
      "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
      siteHostRules,
    ],
  });
  try {
    await expect.poll(() => context.serviceWorkers().length, { timeout: 15_000 }).toBeGreaterThan(0);
    const id = new URL(context.serviceWorkers()[0].url()).host;
    const popup = await context.newPage();
    const go = (route: string) => popup.goto(`chrome-extension://${id}/popup/index.html#${route}`);
    await go("/");
    await logInPopup(popup, sam, server);
    // The first-run welcome card, once.
    await popup
      .getByRole("button", { name: /^(Close|Dismiss)/ })
      .first()
      .click({ timeout: 5_000 })
      .catch(() => {});

    // The first-visit tips: the generator's, and the Settings badge, which
    // goes once the autofill settings have been opened.
    await go("/tabs/generator");
    await popup
      .getByRole("button", { name: /^(Close|Dismiss)/ })
      .first()
      .click({ timeout: 5_000 })
      .catch(() => {});
    await go("/autofill");
    await popup.waitForTimeout(1_000);

    const vault = async () => {
      await go("/tabs/vault");
      await expect(popup.getByText("Hometown Credit Union").first()).toBeVisible();
    };
    for (const scheme of schemes) {
      await popup.emulateMedia({ colorScheme: scheme });
      await vault();
      await shoot(popup, `popup-vault-${scheme}`);
      await go("/tabs/generator");
      await expect(popup.getByRole("heading", { name: "Generator" }).first()).toBeVisible();
      await shoot(popup, `popup-generator-${scheme}`);
      await vault();
      await popup.getByText("Hometown Credit Union").first().click();
      await expect(popup.getByText("sam.rivera").first()).toBeVisible();
      await shoot(popup, `popup-item-${scheme}`);
    }

    // The solid themes, chosen the way a person does. The appearance page
    // shows the choice in the device's light mode.
    await popup.emulateMedia({ colorScheme: "light" });
    await go("/appearance");
    await expect(popup.getByText("Glass (default)").first()).toBeVisible();
    await shoot(popup, "popup-appearance-light");
    for (const theme of ["Light", "Dark"]) {
      await go("/appearance");
      await popup.getByRole("combobox", { name: "Theme" }).click();
      await popup.getByRole("option", { name: theme, exact: true }).click();
      await vault();
      await shoot(popup, `popup-solid-${theme.toLowerCase()}`);
    }
    await go("/appearance");
    await popup.getByRole("combobox", { name: "Theme" }).click();
    await popup.getByRole("option", { name: /Glass/ }).click();
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test("an MSP's console with five clients, and a client's admin console", async ({ browser, request }) => {
  test.setTimeout(1_200_000);
  const started = Date.now();
  const log = (what: string) => console.log(`${((Date.now() - started) / 1000).toFixed(0)}s ${what}`);
  const web = await webPage(browser);
  await signUp(web, jordan);
  await web.goto("/#/msp");
  await web.getByRole("textbox", { name: "Your MSP's name" }).fill("Harbor IT");
  await web.getByRole("button", { name: "Create MSP" }).click();
  await expect(web.getByTestId("msp-name")).toContainText("Harbor IT");

  // The clients, with their keys made in the browser.
  const urls = new Map<string, string>();
  for (const client of clients) {
    await web.goto("/#/msp");
    await web.getByRole("textbox", { name: "New client's name" }).fill(client.name);
    await web.getByRole("button", { name: "Add client" }).click();
    await expect(web.getByTestId(`msp-client-${client.name}`)).toBeVisible();
  }

  // Their people join with each client's install command, as after a rollout.
  // Their public key is real, since the console encrypts the org key to it.
  const api = new Api(request);
  const { publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  for (const client of clients) {
    await web.goto("/#/msp");
    const row = web.getByTestId(`msp-client-${client.name}`);
    await row.getByRole("button", { name: "Install command" }).click();
    const command = await web.getByTestId("msp-install-command").textContent();
    const token = command!.match(/[A-Za-z0-9_-]{43}/)![0];
    log(`joining ${client.name}`);
    for (const person of client.people) {
      const account = await api.account(person, emailOf(person, client), publicKey.toString("base64"));
      const joined = await api.call(account, "POST", "/api/keykeeper/enrollment/join", { token });
      expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    }
    await row.getByRole("link", { name: "Open" }).click();
    await expect(web).toHaveURL(/#\/organizations\/[^/]+\/members/);
    urls.set(client.name, web.url().replace(/\/members.*$/, ""));
    log(`importing ${client.name}`);
    await importJson(web, clientVault(client), urls.get(client.name));
  }
  log("confirming");

  // Opening the console confirms everyone who joined.
  await web.goto("/#/msp");
  for (const client of clients) {
    await expect(web.getByTestId(`msp-client-${client.name}`).getByTestId("msp-client-members")).toHaveText(
      String(client.people.length),
      { timeout: 60_000 },
    );
    await expect(web.getByTestId(`msp-client-${client.name}`).getByTestId("msp-client-weak")).toHaveText(
      String(client.weak),
    );
  }

  const acme = urls.get("Acme Dental")!;
  for (const scheme of schemes) {
    await web.emulateMedia({ colorScheme: scheme });
    await web.goto("/#/msp");
    await expect(web.getByTestId("msp-client-Acme Dental").getByTestId("msp-client-members")).toHaveText("9");
    await shoot(web, `msp-console-${scheme}`);
    await shoot(web.locator("app-keykeeper-default-policies"), `msp-policies-${scheme}`);
    await web.getByTestId("msp-client-Acme Dental").getByRole("button", { name: "Install command" }).click();
    await shoot(web.getByTestId("msp-install"), `msp-install-${scheme}`);

    await web.goto(`${acme}/members`);
    await expect(web.getByText("maria.lopez@acmedental.example").first()).toBeVisible();
    await shoot(web, `admin-members-${scheme}`);
    await web.goto(`${acme}/settings/policies`);
    await expect(web.getByText(/Master password requirements/).first()).toBeVisible();
    await shoot(web, `admin-policies-${scheme}`);
  }
});

test("a company with its own IT: its members, policies, and install command", async ({ browser, request }) => {
  test.setTimeout(600_000);
  const company = {
    name: "Northpoint Logistics",
    domain: "northpoint.example",
    people: ["Alicia Grant", "Brian Okoye", "Carmen Ruiz", "Daniel Meyer", "Fatima Noor", "George Lin", "Ivy Walsh", "Kenji Sato"],
  };
  const pat: WebUser = { email: "pat.morgan@northpoint.example", name: "Pat Morgan", password };

  // New organization, for a business: the Business preset and an install command.
  const web = await webPage(browser);
  await signUp(web, pat);
  await web.goto("/#/create-organization");
  await web.getByRole("textbox", { name: /Organization name/ }).fill(company.name);
  await web.getByRole("radio", { name: /A business/ }).check();
  await web.getByRole("button", { name: "Create organization" }).click();
  await web.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  const org = web.url().replace(/\/members.*$/, "");
  await web.goto("/#/vault");
  await web.goto(`${org}/settings`);
  const command = await web.getByTestId("org-install-command").textContent();
  const token = /-EnrollmentToken '([A-Za-z0-9_-]{43})'/.exec(command!)![1];

  // The people join with it, as after a rollout. Their public key is real for the confirm.
  const api = new Api(request);
  const { publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  const emails: string[] = [];
  for (const person of company.people) {
    const email = emailOf(person, { ...company, weak: 0, reused: 0, expiring: 0 });
    const account = await api.account(person, email, publicKey.toString("base64"));
    const joined = await api.call(account, "POST", "/api/keykeeper/enrollment/join", { token });
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    emails.push(email);
  }

  // The owner approves everyone who joined: limiting the command to email
  // domains, which lets people in without that, needs a server that sends email.
  await web.goto("/#/vault");
  await web.goto(`${org}/members`);
  for (const email of emails) {
    await confirmMember(web, email);
  }

  for (const scheme of schemes) {
    await web.emulateMedia({ colorScheme: scheme });
    await web.goto("/#/vault");
    await web.goto(`${org}/members`);
    await expect(web.getByText(emails[0]).first()).toBeVisible();
    await shoot(web, `business-members-${scheme}`);
    await web.goto(`${org}/settings/policies`);
    await expect(web.getByText(/Master password requirements/).first()).toBeVisible();
    await shoot(web, `business-policies-${scheme}`);
    await web.goto("/#/vault");
    await web.goto(`${org}/settings`);
    await expect(web.getByTestId("org-install-joins")).toContainText("8 people have joined");
    await shoot(web.getByTestId("org-install"), `business-install-${scheme}`);
  }
});
