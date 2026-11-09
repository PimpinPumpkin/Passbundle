// The new-device check in the web vault and the browser extension (DESIGN.md,
// "New-device check"), on a test server of its own with the check on, email,
// and a tiny location database of made-up places: a browser new to the
// account shows the number and waits; the web vault signed in elsewhere
// prompts, with where it comes from, takes the number, and the new browser
// signs in; a wrong number shows denied on both; with no device that can
// approve, a code by email; and the extension as the new device and as the
// approver.
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";

import { newDeviceServerPort } from "../paths.mjs";

import { extensionIdOf, launchWithExtension, openPopup } from "./support/extension";
import { waitForMessage } from "./mail/mailbox";
import { signUp } from "./support/web";

const e2eDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = `https://127.0.0.1:${newDeviceServerPort}`;
// A desktop browser's, as the other browser tests use.
const chromeUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
// One of the made-up places (fixtures/location/make.mjs).
const BERLIN = "203.0.113.7";

test.describe.configure({ mode: "serial" });

let child: ChildProcess;
let dataDir: string;

test.beforeAll(async ({ request }) => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-e2e-new-device-web-"));
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: e2eDir,
    env: { ...process.env, KK_PORT: newDeviceServerPort, KK_DATA_DIR: dataDir, KK_MAIL: "1", KK_NEW_DEVICE: "1" },
    stdio: "ignore",
  });
  await expect
    .poll(async () => (await request.get(`${server}/alive`).catch(() => null))?.status() ?? 0, {
      timeout: 60_000,
    })
    .toBe(200);
});

test.afterAll(async () => {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const user = (name: string) => ({
  email: `${name}-${Date.now()}@example.test`,
  name,
  password: "correct horse battery staple 42",
});

/** A browser of its own, as a computer the account may never have used. */
async function browserAt(browser: Browser, ip?: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: server,
    ignoreHTTPSErrors: true,
    userAgent: chromeUserAgent,
    ...(ip ? { extraHTTPHeaders: { "X-Real-IP": ip } } : {}),
  });
  return { context, page: await context.newPage() };
}

/** Signs in on the web vault up to the point the server answers. */
async function startSignIn(page: Page, who: { email: string; password: string }) {
  await page.goto("/#/login");
  await page.getByLabel(/Email address/).fill(who.email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("textbox", { name: /Master password/ }).fill(who.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/** The new browser holds: the number it shows. */
async function heldNumber(page: Page): Promise<string> {
  await page.waitForURL(/#\/device-verification/);
  await expect(page.getByRole("heading", { name: "Approve this sign-in" })).toBeVisible();
  const number = page.getByTestId("keykeeper-new-device-number");
  await expect(number).toHaveText(/^\s*[1-9][0-9]\s*$/);
  return (await number.innerText()).trim();
}

/** The prompt on a signed-in vault, once it asks the server (every 10 seconds). */
function prompt(page: Page) {
  return page.getByTestId("keykeeper-new-device-approval");
}

async function answer(page: Page, number: string) {
  const dialog = prompt(page);
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await dialog.getByTestId("keykeeper-new-device-approval-number").fill(number);
  await dialog.getByTestId("keykeeper-new-device-approval-approve").click();
}

const ana = user("ana");
let laptop: { context: BrowserContext; page: Page };

test("a new browser waits for its number, and the web vault signed in elsewhere approves it", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  // The account's first sign-in (right after making it) isn't asked.
  laptop = await browserAt(browser);
  await signUp(laptop.page, ana);

  const desk = await browserAt(browser, BERLIN);
  await startSignIn(desk.page, ana);
  const number = await heldNumber(desk.page);
  await expect(desk.page.getByTestId("keykeeper-new-device-wait")).toContainText("Waiting for approval");
  // Devices can approve, so email comes only after a wait.
  await expect(desk.page.getByTestId("keykeeper-new-device-cant-reach")).toBeVisible();

  const dialog = prompt(laptop.page);
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toContainText(`Someone is signing in to ${ana.email} on a new device`);
  await expect(dialog.getByTestId("keykeeper-new-device-approval-device")).toHaveText(/^\s*Web vault in /);
  await expect(dialog.getByTestId("keykeeper-new-device-approval-where")).toContainText("Fixture City, Germany");
  await expect(dialog.getByTestId("keykeeper-new-device-approval-where")).toContainText(BERLIN);
  await expect(dialog.getByRole("link", { name: "IP Geolocation by DB-IP" })).toHaveAttribute(
    "href",
    "https://db-ip.com",
  );
  // The number isn't anywhere on the approving side.
  expect(await dialog.innerText()).not.toContain(number);
  // Approve alone, without the number, approves nothing.
  await dialog.getByTestId("keykeeper-new-device-approval-approve").click();
  await expect(dialog).toContainText("Type the two-digit number shown on the new device.");
  await expect(desk.page).toHaveURL(/#\/device-verification/);

  await answer(laptop.page, number);
  await expect(laptop.page.getByText("Sign-in approved")).toBeVisible();
  await desk.page.waitForURL(/#\/vault/, { timeout: 30_000 });
  await expect(desk.page).toHaveTitle(/^Items/);
  await desk.context.close();
});

test("a wrong number denies it on both sides", async ({ browser }) => {
  test.setTimeout(120_000);
  const other = await browserAt(browser, BERLIN);
  await startSignIn(other.page, ana);
  const number = await heldNumber(other.page);
  const wrong = String(((Number(number) - 10 + 1) % 90) + 10);
  await answer(laptop.page, wrong);
  await expect(laptop.page.getByText("That number didn't match, so the sign-in was denied.")).toBeVisible();
  await expect(other.page.getByTestId("keykeeper-new-device-denied")).toContainText(
    "The number typed on your other device didn't match",
    { timeout: 15_000 },
  );
  await waitForMessage(ana.email, /A sign-in on a new device was denied/);
  await other.context.close();
});

test("with no device that can approve, a code by email signs the new browser in", async ({ browser }) => {
  test.setTimeout(120_000);
  const bo = user("bo");
  const first = await browserAt(browser);
  await signUp(first.page, bo);
  await first.context.close();
  // As if that browser hadn't been used for a month: its session has ended.
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(dataDir, "db.sqlite3"));
  db.exec("PRAGMA busy_timeout = 5000");
  db.prepare(
    `UPDATE devices SET created_at = strftime('%Y-%m-%d %H:%M:%f', created_at, '-31 days'),
       updated_at = strftime('%Y-%m-%d %H:%M:%f', updated_at, '-31 days')
     WHERE user_uuid = (SELECT uuid FROM users WHERE email = ?)`,
  ).run(bo.email);
  db.close();

  const next = await browserAt(browser, BERLIN);
  await startSignIn(next.page, bo);
  await next.page.waitForURL(/#\/device-verification/);
  await expect(next.page.getByTestId("keykeeper-new-device-no-approvers")).toBeVisible();
  await expect(next.page.getByText(/A code by email is less safe than approving/)).toBeVisible();
  await next.page.getByTestId("keykeeper-new-device-send-code").click();
  const mail = await waitForMessage(bo.email, /Your code to sign in on a new device/);
  expect(mail.text).toContain("Fixture City, Germany");
  const code = /\b(\d{8})\b/.exec(mail.text)![1];
  await next.page.getByTestId("keykeeper-new-device-code").fill(code);
  await next.page.getByRole("button", { name: "Continue signing in" }).click();
  await next.page.waitForURL(/#\/vault/, { timeout: 30_000 });
  await next.context.close();
});

test("the extension waits as a new device, then approves another one itself", async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, profile } = await launchWithExtension();
  try {
    const extensionId = await extensionIdOf(context);
    const popup = await openPopup(context, extensionId);
    await expect(async () => {
      await popup.getByRole("button", { name: "Sign in" }).click();
      await expect(popup).toHaveURL(/#\/login/, { timeout: 1000 });
    }).toPass();
    await popup.getByRole("button", { name: "Self-hosted" }).click();
    await popup.getByRole("textbox", { name: "Server address" }).fill(server);
    await popup.getByLabel(/Email address/).fill(ana.email);
    await popup.getByRole("button", { name: "Continue" }).click();
    await popup.getByRole("textbox", { name: /Master password/ }).fill(ana.password);
    await popup.getByRole("button", { name: "Sign in", exact: true }).click();
    const number = await heldNumber(popup);

    // The web vault approves the extension; its requests come from this
    // computer, so where it is is unknown.
    const dialog = prompt(laptop.page);
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByTestId("keykeeper-new-device-approval-device")).toHaveText(/^\s*Extension in /);
    await expect(dialog.getByTestId("keykeeper-new-device-approval-where")).toContainText("Unknown location");
    await answer(laptop.page, number);
    await expect(popup.getByRole("heading", { name: /Items/ }).first()).toBeVisible({ timeout: 30_000 });

    // Now the extension, open and unlocked, approves a new browser.
    const cafe = await browserAt(browser, BERLIN);
    await startSignIn(cafe.page, ana);
    const cafeNumber = await heldNumber(cafe.page);
    // The web vault would prompt too; this one is the extension's to answer.
    await answer(popup, cafeNumber);
    await cafe.page.waitForURL(/#\/vault/, { timeout: 30_000 });
    await cafe.context.close();
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
    await laptop?.context.close();
  }
});
