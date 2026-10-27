// Screenshots of the real apps for the website, in light and dark, written as
// WebP images to site/static/shots. Run with playwright.site.config.ts. Each
// one is named in a page's <x-shot>; until it's made, the page shows a
// placeholder the size of its frame.
//
//   Home       web-vault           a person's vault, a login open beside the list
//              popup-vault         the extension's vault, also its light and dark pair
//              popup-item          a login in the extension
//              popup-generator     the extension's generator
//              popup-signin        signing in: "Where's your vault?", on one's own server
//              msp-console         an MSP's console with five clients (also For MSPs)
//   For MSPs   msp-health          one client's passwords to fix, by name
//              msp-policies        the default policies (a panel)
//              msp-install         a client's install command (a panel)
//              admin-provisioning  a client's Provisioning page, after Entra's first sync (also Business)
//              item-history        a version of a client's firewall login beside the login now
//   Business   business-members    a company's members
//              business-policies   its policies
//              business-install    its install command (a panel)
//              folder-permissions  a shared folder's access, with a Custom grid (also For MSPs)
import { generateKeyPairSync, createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  chromium,
  expect,
  test,
  type Browser,
  type APIRequestContext,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";

import { brand, paths, siteHost, siteHostRules } from "../paths.mjs";
import { Api, encString } from "../tests/api/support";
import { verifyEmail } from "../tests/mail/mailbox";
import { confirmMember, confirmWithPassword, signUp, type WebUser } from "../tests/support/web";

import { breached, clientVault, clients, emailOf, personalVault } from "./data";

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

/** A part of a page, with a margin of the page around it, so it reads as a panel. */
async function shootPanel(target: Locator, name: string, margin = 16) {
  const page = target.page();
  await target.scrollIntoViewIfNeeded();
  await settle(page);
  const box = (await target.boundingBox())!;
  const viewport = page.viewportSize()!;
  const x = Math.max(0, box.x - margin);
  const y = Math.max(0, box.y - margin);
  const clip = {
    x,
    y,
    width: Math.min(viewport.width, box.x + box.width + margin) - x,
    height: Math.min(viewport.height, box.y + box.height + margin) - y,
  };
  await save(await page.screenshot({ animations: "disabled", clip }), name);
}

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex").toUpperCase();

/**
 * A stand-in for Have I Been Pwned's range API, which the browser can't reach
 * here: it knows the passwords in data.ts's `breached`, padded with decoys the
 * way the real one pads.
 */
async function pwnedPasswords(context: BrowserContext) {
  const known = Object.entries(breached).map(([p, times]) => [sha1(p), times] as const);
  await context.route("https://api.pwnedpasswords.com/**", async (route) => {
    const prefix = new URL(route.request().url()).pathname.slice("/range/".length);
    const lines = Array.from({ length: 400 }, (_, i) => `${sha1(`decoy ${prefix} ${i}`).slice(5)}:0`);
    for (const [hash, times] of known) {
      if (hash.startsWith(prefix)) lines.push(`${hash.slice(5)}:${times}`);
    }
    await route.fulfill({
      status: 200,
      contentType: "text/plain",
      headers: { "access-control-allow-origin": "*" },
      body: lines.sort().join("\r\n"),
    });
  });
}

/** Imports an unencrypted Bitwarden JSON export, into an organization when given its admin console URL. */
async function importJson(page: Page, contents: string, orgUrl?: string) {
  await page.goto(orgUrl ? `${orgUrl}/settings/tools/import` : "/#/tools/import");
  await page.getByRole("combobox", { name: /File format/ }).click();
  await page.getByRole("option", { name: "Bitwarden (json)" }).click();
  // Into an organization, everything goes in its Everyone folder, where its
  // people (and an edit) can reach it.
  if (orgUrl) {
    await page.getByRole("combobox", { name: /^(Collection|Shared folder|Folder)/ }).click();
    await page.getByRole("option", { name: "Everyone", exact: true }).click();
  }
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
  await pwnedPasswords(context);
  return context.newPage();
}

/**
 * Signs up in the web vault and verifies the email address from the link the
 * server emails, as a person would, so the vault doesn't ask them to. The web
 * vault learns it at its next unlock.
 */
async function signUpVerified(page: Page, request: APIRequestContext, user: WebUser) {
  let token = "";
  page.on("request", (r) => {
    const header = r.headers()["authorization"];
    if (header?.startsWith("Bearer ") && r.url().includes("/api/")) token = header.slice("Bearer ".length);
  });
  await signUp(page, user);
  await expect.poll(() => token).not.toBe("");
  await verifyEmail(new Api(request), { email: user.email, password: user.password, token, userId: "" });
  await page.reload();
  await page.getByRole("textbox", { name: /^Master password/ }).fill(user.password);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.waitForURL(/#\/vault/);
}

/**
 * Waits for a one-time code's new 30-second period, if this one is half over,
 * so the code on screen has most of its time left rather than a red countdown.
 */
async function freshCode(page: Page) {
  const left = 30 - ((Date.now() / 1000) % 30);
  if (left < 26) await page.waitForTimeout(left * 1000 + 250);
}

/** Opens an item from the vault's list, in the panel beside it. */
async function openItem(page: Page, name: string) {
  await page.getByRole("row").filter({ hasText: name }).getByText(name, { exact: true }).first().click();
  const view = page.getByRole("dialog", { name: /^View / });
  await expect(view).toContainText(name);
  return view;
}

test.beforeAll(async ({ browser }) => {
  fs.mkdirSync(out, { recursive: true });
  encoder = await (await browser.newContext()).newPage();
});

test("a person's vault, in the web vault and the extension, light and dark", async ({ browser, request }) => {
  test.setTimeout(300_000);
  const web = await webPage(browser);
  await signUpVerified(web, request, sam);
  await importJson(web, personalVault());
  await web.goto("/#/vault");
  await web.getByRole("button", { name: "Dismiss this checklist" }).click();
  for (const scheme of schemes) {
    await web.emulateMedia({ colorScheme: scheme });
    await web.goto("/#/vault");
    await expect(web.getByText("Hometown Credit Union").first()).toBeVisible();
    await openItem(web, "Hometown Credit Union");
    await freshCode(web);
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
    await pwnedPasswords(context);
    await expect.poll(() => context.serviceWorkers().length, { timeout: 15_000 }).toBeGreaterThan(0);
    const id = new URL(context.serviceWorkers()[0].url()).host;
    const popup = await context.newPage();
    const go = (route: string) => popup.goto(`chrome-extension://${id}/popup/index.html#${route}`);
    await go("/");

    // Signing in asks where the vault is: shown on one's own server, then
    // signed in to the hosted service's name (the test server here).
    await expect(async () => {
      await popup.getByRole("button", { name: "Log in" }).click();
      await expect(popup).toHaveURL(/#\/login/, { timeout: 1000 });
    }).toPass();
    const where = popup.getByRole("group", { name: "Where's your vault?" });
    await where.getByRole("button", { name: "My own server" }).click();
    await popup.getByRole("textbox", { name: "Server address" }).fill("vault.harborit.example");
    await popup.getByLabel(/Email address/).fill(sam.email);
    for (const scheme of schemes) {
      await popup.emulateMedia({ colorScheme: scheme });
      await shoot(popup, `popup-signin-${scheme}`);
    }
    await where.getByRole("button", { name: brand.name, exact: true }).click();
    await popup.getByRole("button", { name: "Continue" }).click();
    await popup.getByRole("textbox", { name: /Master password/ }).fill(sam.password);
    await popup.getByRole("button", { name: "Log in", exact: true }).click();
    await expect(popup.getByRole("heading", { name: /Items/ }).first()).toBeVisible({ timeout: 30_000 });

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
    // The Settings badge goes once each tip for a new account is seen: the
    // autofill settings' (closed there), the apps' download page, and the
    // vault options (opened from Settings).
    await go("/autofill");
    await popup
      .getByRole("button", { name: /^(Close|Dismiss)/ })
      .first()
      .click({ timeout: 5_000 })
      .catch(() => {});
    await go("/download-bitwarden");
    await popup.waitForTimeout(1_000);
    await go("/tabs/settings");
    await popup.locator('a[href$="/vault-settings"]').click();
    await popup.waitForURL(/vault-settings/);
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
      await freshCode(popup);
      await shoot(popup, `popup-item-${scheme}`);
    }
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test("an MSP's console with five clients, a client's passwords to fix, Entra, and an item's history", async ({
  browser,
  request,
}) => {
  test.setTimeout(1_200_000);
  const started = Date.now();
  const log = (what: string) => console.log(`${((Date.now() - started) / 1000).toFixed(0)}s ${what}`);
  const web = await webPage(browser);
  await signUpVerified(web, request, jordan);
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
      // Clients enroll people in account recovery as they join; the key
      // is a stand-in, as these people never sign in.
      const joined = await api.call(account, "POST", "/api/keykeeper/enrollment/join", {
        token,
        resetPasswordKey: encString(`${person} recovery key`),
      });
      expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    }
    await row.getByRole("link", { name: "Open" }).click();
    await expect(web).toHaveURL(/#\/organizations\/[^/]+\/members/);
    urls.set(client.name, web.url().replace(/\/members.*$/, ""));
    log(`importing ${client.name}`);
    await importJson(web, clientVault(client), urls.get(client.name));
  }
  // Joins through an install command without email domains wait for an
  // admin's approval (limiting a command to domains needs a server that sends
  // email): approve everyone, as an MSP does after a rollout.
  for (const client of clients) {
    log(`confirming ${client.name}`);
    await web.goto("/#/vault");
    await web.goto(`${urls.get(client.name)}/members`);
    for (const person of client.people) {
      await confirmMember(web, emailOf(person, client));
    }
  }

  // The console checks the passwords against known breaches.
  await web.goto("/#/vault");
  await web.goto("/#/msp");
  for (const client of clients) {
    const row = web.getByTestId(`msp-client-${client.name}`);
    await expect(row.getByTestId("msp-client-members")).toHaveText(String(client.people.length), {
      timeout: 60_000,
    });
    await expect(row.getByTestId("msp-client-weak")).toHaveText(String(client.weak));
  }
  await expect(web.getByTestId("msp-exposed-progress")).toHaveCount(0, { timeout: 60_000 });

  const acme = urls.get("Acme Dental")!;
  const acmeId = acme.slice(acme.lastIndexOf("/") + 1);

  // Entra's first sync for Acme Dental: a token, and a new hire it adds.
  log("provisioning");
  await web.goto(`${acme}/settings/provisioning`);
  const provisioning = web.getByTestId("provisioning");
  await provisioning.getByRole("button", { name: "Create token" }).click();
  await confirmWithPassword(web, jordan.password);
  const scimToken = (await provisioning.getByTestId("provisioning-token").textContent())!.trim();
  await provisioning.getByRole("button", { name: "Done" }).click();
  const hire = { name: "Jamal Reed", email: emailOf("Jamal Reed", clients[0]) };
  const created = await request.fetch(`/scim/v2/${acmeId}/Users`, {
    method: "POST",
    // Entra calls from Microsoft's network; a documentation address stands
    // in for it (the server reads the client's address from X-Real-IP).
    headers: {
      Authorization: `Bearer ${scimToken}`,
      "Content-Type": "application/scim+json",
      "X-Real-IP": "203.0.113.24",
    },
    data: JSON.stringify({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      externalId: "acme-jamal-reed",
      userName: hire.email,
      active: true,
      emails: [{ primary: true, type: "work", value: hire.email }],
      name: { givenName: "Jamal", familyName: "Reed" },
    }),
  });
  expect(created.status(), await created.text()).toBe(201);

  // A technician changed the firewall's password twice.
  log("history");
  await web.goto("/#/vault");
  await web
    .getByRole("button", { name: "Dismiss this checklist" })
    .click({ timeout: 5_000 })
    .catch(() => {});
  await web.goto(`/#/vault?organizationId=${acmeId}`);
  const firewall = await openItem(web, "Firewall");
  for (const next of ["Kp3#mW8z!Qr3Lt4v-2026", "Vt8!cN4q#Hs6Jw2e"]) {
    await firewall.getByRole("button", { name: "Edit" }).click();
    const edit = web.getByRole("dialog", { name: /Edit Login/ });
    await edit.getByRole("textbox", { name: "Password", exact: true }).fill(next);
    await edit.getByRole("button", { name: "Save" }).click();
    await expect(edit).toBeHidden();
  }

  for (const scheme of schemes) {
    await web.emulateMedia({ colorScheme: scheme });
    await web.goto("/#/vault");
    await web.goto("/#/msp");
    const acmeRow = web.getByTestId("msp-client-Acme Dental");
    await expect(acmeRow.getByTestId("msp-client-members")).toHaveText("9");
    await expect(web.getByTestId("msp-exposed-progress")).toHaveCount(0, { timeout: 60_000 });
    await shoot(web, `msp-console-${scheme}`);
    // The whole list of default policies, in a window tall enough for it.
    await web.setViewportSize({ width: desktop.width, height: 2400 });
    await shootPanel(web.locator("app-keykeeper-default-policies"), `msp-policies-${scheme}`);
    await web.setViewportSize(desktop);

    await acmeRow
      .getByTestId("msp-client-exposed")
      .getByRole("button", { name: /^Show the exposed passwords in Acme Dental/ })
      .click();
    const details = web.getByTestId("msp-health-details");
    await expect(details).toContainText("Passwords to fix in Acme Dental");
    await details.scrollIntoViewIfNeeded();
    await shoot(web, `msp-health-${scheme}`);

    await web.goto("/#/vault");
    await web.goto("/#/msp");
    await web.getByTestId("msp-client-Acme Dental").getByRole("button", { name: "Install command" }).click();
    await shootPanel(web.getByTestId("msp-install"), `msp-install-${scheme}`);

    await web.goto("/#/vault");
    await web.goto(`${acme}/settings/provisioning`);
    await expect(web.getByTestId("provisioning-token-info")).toContainText("Last sync");
    await shoot(web, `admin-provisioning-${scheme}`);

    await web.goto(`/#/vault?organizationId=${acmeId}`);
    const view = await openItem(web, "Firewall");
    const versions = view.getByTestId("keykeeper-item-versions").getByTestId("keykeeper-item-version");
    await expect(versions).toHaveCount(2);
    await versions.last().getByRole("button", { name: /^View/ }).click();
    await expect(web.getByRole("dialog", { name: /^Version from/ })).toBeVisible();
    await shoot(web, `item-history-${scheme}`);
    await web.keyboard.press("Escape");
  }
});

test("a company with its own IT: its members, policies, install command, and a shared folder's access", async ({
  browser,
  request,
}) => {
  test.setTimeout(600_000);
  const company = {
    name: "Northpoint Logistics",
    domain: "northpoint.example",
    people: ["Alicia Grant", "Brian Okoye", "Carmen Ruiz", "Daniel Meyer", "Fatima Noor", "George Lin", "Ivy Walsh", "Kenji Sato"],
  };
  const pat: WebUser = { email: "pat.morgan@northpoint.example", name: "Pat Morgan", password };

  // New organization, for a business: the Business preset and an install command.
  const web = await webPage(browser);
  await signUpVerified(web, request, pat);
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
    const joined = await api.call(account, "POST", "/api/keykeeper/enrollment/join", {
      token,
      resetPasswordKey: encString(`${person} recovery key`),
    });
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
    await shootPanel(web.getByTestId("org-install"), `business-install-${scheme}`);

    // Everyone's access: everyone who joined can edit there. Show one who
    // sees items without their passwords, and one with a Custom grid (see
    // items and passwords, and add new ones, without changing anyone
    // else's). Shown, not saved.
    await web.goto(`${org}/vault`);
    await web.getByRole("button", { name: "Everyone", exact: true }).first().click();
    await expect(web).toHaveURL(/collectionId=[0-9a-f-]{36}/);
    await web.getByRole("button", { name: "Edit shared folder" }).click();
    await web.getByRole("menuitem", { name: "Access" }).click();
    const access = web.getByRole("dialog", { name: /Edit shared folder/ });
    for (const [who, level] of [
      [emails[1], "Can view but not see passwords"],
      [emails[2], "Custom"],
    ] as const) {
      const row = access.getByRole("row").filter({ hasText: who });
      await row.getByRole("combobox").click();
      await web.getByRole("option", { name: level, exact: true }).click();
    }
    const grid = access.getByTestId("keykeeper-folder-grid");
    await expect(grid).toBeVisible();
    await grid.getByRole("checkbox", { name: "Create items", exact: true }).check();
    await grid.getByRole("checkbox", { name: "Print", exact: true }).uncheck();
    await access.getByRole("row").filter({ hasText: emails[1] }).scrollIntoViewIfNeeded();
    await shoot(web, `folder-permissions-${scheme}`);
    await access.getByRole("button", { name: "Cancel" }).click();
  }
});
