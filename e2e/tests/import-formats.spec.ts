// Moving from another password manager, format by format: one fake vault
// (fixtures/imports/), exported the way each app exports it, imported into a
// new account through the screens people use, then read back with the web
// vault's own export and compared item by item with what should be there
// (fixtures/imports/expected/). What an importer leaves out is in the
// expected files and README.md, not hidden. import.spec.ts covers moving
// between PassBundle accounts with a password-protected export.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { generate, sameFile } from "../fixtures/imports/generate.mjs";
import { fromExport } from "../fixtures/imports/vault.mjs";

import { menu, menuEntry, pick, signUp, startSignUp, webUserFor, type WebUser } from "./support/web";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "imports");

type Expected = {
  format: string;
  files: string[];
  folders: string[];
  items: Record<string, unknown>[];
  /** What the guided browser import says it did. */
  summary?: string;
  perFile?: Record<string, number>;
};

const expected = (format: string): Expected =>
  JSON.parse(fs.readFileSync(path.join(fixtures, "expected", `${format}.json`), "utf8"));

/** One of a format's export files, ready to pick in a file chooser. */
function exportFile(format: string, name: string) {
  return {
    name,
    mimeType: name.endsWith(".json")
      ? "application/json"
      : name.endsWith(".xml")
        ? "text/xml"
        : /\.(zip|1pux)$/.test(name)
          ? "application/zip"
          : "text/csv",
    buffer: fs.readFileSync(path.join(fixtures, "files", format, name)),
  };
}

/** Picks a file with the importer's file button, as a person would. */
async function chooseFile(page: Page, file: ReturnType<typeof exportFile>) {
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: "Select the import file" }).click(),
  ]);
  await chooser.setFiles(file);
}

/** Sets the importer's File format, typing to find it in the long list. */
async function chooseFormat(page: Page, name: string) {
  const format = page.getByRole("combobox", { name: /File format/ });
  await format.click();
  await format.pressSequentially(name);
  await page.getByRole("option", { name, exact: true }).click();
}

/** Imports with the importer the screen already shows, and closes the result. */
async function importAndConfirm(page: Page, count: number) {
  await page.getByRole("button", { name: "Import", exact: true }).click();
  const result = page.getByRole("dialog", { name: "Data successfully imported" });
  await expect(result.getByText(`A total of ${count} items were imported.`)).toBeVisible({ timeout: 30_000 });
  await result.getByRole("button", { name: "Ok" }).click();
  await expect(result).toBeHidden();
}

/** At sign-up: picks a source's tile; it then shows that source's steps and importer. */
async function setupTile(page: Page, tile: string) {
  await page.getByRole("button", { name: new RegExp(`^${tile}`) }).click();
  await expect(page.getByRole("heading", { name: `From ${tile}`, exact: true })).toBeVisible();
}

/** After importing at sign-up: the reminder about the export, then the vault. */
async function finishSetup(page: Page) {
  await expect(page.getByText("Delete the export now")).toBeVisible();
  await page.getByRole("button", { name: "Go to your items" }).click();
  await page.waitForURL(/#\/vault/);
}

/** The guided browser import (at sign-up, or Tools): picks the browser and the file. */
async function guidedImport(page: Page, browser: string, file: ReturnType<typeof exportFile>, summary: string) {
  const guided = page.getByTestId("browser-import");
  await guided.getByRole("radio", { name: browser }).click();
  await guided.getByTestId("browser-import-file").setInputFiles(file);
  await guided.getByRole("button", { name: "Import", exact: true }).click();
  await expect(guided.getByTestId("browser-import-summary")).toHaveText(summary, { timeout: 30_000 });
  await guided.getByRole("button", { name: "Done" }).click();
  await page.waitForURL(/#\/vault/);
}

/** The whole vault, decrypted by the web vault's own .json export. */
async function readVault(page: Page, user: WebUser) {
  await page.goto("/#/tools/export");
  await page.getByRole("combobox", { name: /File format/ }).selectOption({ label: ".json" });
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Confirm export" });
  await confirm.getByRole("textbox", { name: /Master password/ }).fill(user.password);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    confirm.getByRole("button", { name: "Continue" }).click(),
  ]);
  const exported = JSON.parse(fs.readFileSync((await download.path())!, "utf8"));
  expect(exported.encrypted).toBe(false);
  return fromExport(exported);
}

/** The vault holds exactly what the expected file says: every item, field, and folder. */
async function expectVault(page: Page, user: WebUser, want: Expected) {
  const vault = await readVault(page, user);
  // What came in, next to the test's other results, to compare with expected/ when it fails.
  const saved = test.info().outputPath("vault.json");
  fs.writeFileSync(saved, JSON.stringify(vault, null, 2));
  await test.info().attach("vault.json", { path: saved, contentType: "application/json" });
  expect(vault.folders).toEqual(want.folders);
  // Item by item first, so a failure names the item that differs.
  const byName = (items: Record<string, unknown>[], name: unknown) => items.filter((i) => i.name === name);
  for (const item of want.items) {
    expect(byName(vault.items, item.name), `the item "${item.name}"`).toContainEqual(item);
  }
  expect(vault.items).toEqual(want.items);
  // The vault's own menu agrees; an archived item is in Archive, not All items.
  await page.goto("/#/vault");
  const archived = want.items.filter((i) => i.archived).length;
  await expect(menuEntry(page, "All items")).toContainText(String(want.items.length - archived));
}

test("the committed fake exports are what the generator makes", () => {
  for (const [relative, contents] of generate()) {
    const committed = fs.readFileSync(path.join(fixtures, relative));
    expect(
      sameFile(relative, committed, contents),
      `${relative} is out of date: run node fixtures/imports/generate.mjs`,
    ).toBe(true);
  }
});

test.describe("importing from a browser, with the guided import", () => {
  test.setTimeout(120_000);

  test("Chrome's export, at sign-up", async ({ page }, testInfo) => {
    const want = expected("chrome");
    const user = webUserFor("formats-chrome", testInfo.repeatEachIndex);
    await startSignUp(page, user);
    await setupTile(page, "Your browser");
    await guidedImport(page, "Google Chrome", exportFile("chrome", want.files[0]), want.summary!);
    await expectVault(page, user, want);
  });

  test("Firefox's export, at sign-up: its own account's sign-in is left out", async ({ page }, testInfo) => {
    const want = expected("firefox");
    const user = webUserFor("formats-firefox", testInfo.repeatEachIndex);
    await startSignUp(page, user);
    await setupTile(page, "Your browser");
    await guidedImport(page, "Firefox", exportFile("firefox", want.files[0]), want.summary!);
    await expectVault(page, user, want);
  });

  for (const [format, browser] of [
    ["edge", "Microsoft Edge"],
    ["brave", "Brave"],
    ["chrome-excel", "Google Chrome"],
  ] as const) {
    test(`${format === "chrome-excel" ? "Chrome's export saved again in Excel" : `${browser}'s export`}, from Tools`, async ({
      page,
    }, testInfo) => {
      const want = expected(format);
      const user = webUserFor(`formats-${format}`, testInfo.repeatEachIndex);
      await signUp(page, user);
      await page.goto("/#/tools/import-from-browser");
      await guidedImport(page, browser, exportFile(format, want.files[0]), want.summary!);
      await expectVault(page, user, want);
    });
  }
});

test.describe("importing from a password manager", () => {
  test.setTimeout(120_000);

  for (const [format, tile] of [
    ["apple", "Apple Passwords"],
    ["1password-1pux", "1Password"],
    ["bitwarden", "Bitwarden"],
    ["lastpass", "LastPass"],
  ] as const) {
    test(`${tile}, at sign-up`, async ({ page }, testInfo) => {
      const want = expected(format);
      const user = webUserFor(`formats-${format}`, testInfo.repeatEachIndex);
      await startSignUp(page, user);
      await setupTile(page, tile);
      await chooseFile(page, exportFile(format, want.files[0]));
      await importAndConfirm(page, want.items.length);
      await finishSetup(page);
      await expectVault(page, user, want);
    });
  }

  test("1Password 8's CSV, at sign-up with the 1Password step's CSV steps", async ({ page }, testInfo) => {
    const want = expected("1password-csv");
    const user = webUserFor("formats-1password-csv", testInfo.repeatEachIndex);
    await startSignUp(page, user);
    await setupTile(page, "1Password");
    // 1PUX is the recommended export; the CSV is a link away, with its own importer.
    await page.getByRole("button", { name: "Have a CSV from 1Password instead?" }).click();
    await expect(page.getByRole("listitem").filter({ hasText: "Choose CSV as the format" })).toBeVisible();
    await expect(page.getByText("1Password 8 (csv) Instructions")).toBeVisible();
    await chooseFile(page, exportFile("1password-csv", want.files[0]));
    await importAndConfirm(page, want.items.length);
    await finishSetup(page);
    await expectVault(page, user, want);
  });

  for (const [format, option] of [
    ["keepass", "KeePass 2 (xml)"],
    ["protonpass", "ProtonPass (zip/json)"],
  ] as const) {
    test(`${option}, from Tools`, async ({ page }, testInfo) => {
      const want = expected(format);
      const user = webUserFor(`formats-${format}`, testInfo.repeatEachIndex);
      await signUp(page, user);
      await page.goto("/#/tools/import");
      await chooseFormat(page, option);
      await chooseFile(page, exportFile(format, want.files[0]));
      await importAndConfirm(page, want.items.length);
      await expectVault(page, user, want);
    });
  }

  test("Dashlane's CSVs, one file at a time from Tools", async ({ page }, testInfo) => {
    const want = expected("dashlane");
    const user = webUserFor("formats-dashlane", testInfo.repeatEachIndex);
    await signUp(page, user);
    for (const name of want.files) {
      await page.goto("/#/tools/import");
      await chooseFormat(page, "Dashlane (csv)");
      await chooseFile(page, exportFile("dashlane", name));
      await importAndConfirm(page, want.perFile![name]);
    }
    await expectVault(page, user, want);
  });
});

test("an import keeps nested folders, favorites, TOTP, and awkward characters, as the vault shows them", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const want = expected("bitwarden");
  await startSignUp(page, webUserFor("formats-look", testInfo.repeatEachIndex));
  await setupTile(page, "Bitwarden");
  await chooseFile(page, exportFile("bitwarden", want.files[0]));
  await importAndConfirm(page, want.items.length);
  await finishSetup(page);

  // Work/Servers is Servers, inside Work.
  await expect(menuEntry(page, "Work")).toBeVisible();
  await pick(page, "Servers");
  await expect(page.getByRole("row").filter({ hasText: "Test NAS" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Example Mail" })).toHaveCount(0);
  await pick(page, "Favorites");
  await expect(page.getByRole("row").filter({ hasText: "Example Bank" })).toBeVisible();

  // Unicode, TOTP, and a password with spaces at both ends, as they were.
  await pick(page, "All items");
  const view = page.getByRole("dialog", { name: "View Login" });
  const open = async (name: string) => {
    await menu(page).getByPlaceholder("Search all items").fill(name);
    await page.getByRole("row").filter({ hasText: name }).getByRole("button", { name }).first().click();
    await expect(view).toBeVisible();
  };
  const close = async () => {
    await view.getByRole("button", { name: "Close" }).first().click();
    await expect(view).toBeHidden();
  };
  // Shown, the password is colored text rather than an input, a character at a time.
  const password = async () => {
    await view.getByRole("button", { name: "Toggle visibility" }).first().click();
    return view
      .getByTestId("login-password-color")
      .locator("[data-password-character]")
      .evaluateAll((chars) => chars.map((c) => c.firstElementChild?.textContent ?? "").join(""));
  };
  await open("Café Ünïcode 日本語 🔑");
  await expect(view.getByRole("textbox", { name: "Username" })).toHaveValue("tëst.pérson");
  expect(await password()).toBe("pässwörd-日本語-🔑-Ωμέγα");
  await expect(view.getByRole("textbox", { name: "Note" })).toHaveValue("Ünïcode notes: 你好, привет, مرحبا, 🎉");
  await close();
  await open("Staging database");
  expect(await password()).toBe("  spaced out password  ");
  await close();
  await open("Example Mail");
  await expect(view.getByRole("textbox", { name: "Verification code (TOTP)" })).toHaveValue(/^\d{3} \d{3}$/);
});
