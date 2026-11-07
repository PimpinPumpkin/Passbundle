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
import { kdbx } from "../fixtures/imports/kdbx.mjs";
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

/**
 * Imports with the importer the screen already shows, and closes the result,
 * which says what was left out on purpose, counted (`leftOut`), or nothing.
 */
async function importAndConfirm(page: Page, count: number, leftOut: string[] = [], intoOrganization = false) {
  await page.getByRole("button", { name: "Import", exact: true }).click();
  if (intoOrganization) {
    // "Your data may be shared with members of this organization."
    await page.getByRole("dialog", { name: "Warning" }).getByRole("button", { name: "Yes" }).click();
  }
  const result = page.getByRole("dialog", { name: "Data successfully imported" });
  await expect(result.getByText(`A total of ${count} items were imported.`)).toBeVisible({ timeout: 30_000 });
  await expect(result.getByTestId("import-left-out")).toHaveText(leftOut);
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

/** The whole vault (or an organization's, from its export page), decrypted by the web vault's own .json export. */
async function readVault(page: Page, user: WebUser, exportPage = "/#/tools/export") {
  await page.goto(exportPage);
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

  for (const [format, option, leftOut] of [
    // The Recycle Bin's one entry is left out, and the summary says so.
    ["keepass", "KeePass 2 (xml)", ["Left out 1 item in KeePass's Recycle Bin."]],
    ["protonpass", "ProtonPass (zip/json)", []],
  ] as const) {
    test(`${option}, from Tools`, async ({ page }, testInfo) => {
      const want = expected(format);
      const user = webUserFor(`formats-${format}`, testInfo.repeatEachIndex);
      await signUp(page, user);
      await page.goto("/#/tools/import");
      await chooseFormat(page, option);
      await chooseFile(page, exportFile(format, want.files[0]));
      await importAndConfirm(page, want.items.length, [...leftOut]);
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

/**
 * Imports a KeePass .kdbx file with our own fields planted in it, on the
 * import page given. Upstream's SDK reads and saves .kdbx files itself, and
 * the fields are checked once it has (sdk-import-check.ts). The rule is
 * protected, as KeePass keeps secrets, so it comes in as a hidden field.
 */
async function importPlantedKdbx(page: Page, importPage: string, rule: string, copy: string) {
  const keepassPassword = "fake-kdbx-database-password";
  await page.goto(importPage);
  await chooseFormat(page, "KeePass (kdbx)");
  await page.getByLabel("KeePass master password").fill(keepassPassword);
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: "KDBX file upload" }).click(),
  ]);
  await chooser.setFiles({
    name: "planted.kdbx",
    mimeType: "application/octet-stream",
    buffer: kdbx({
      password: keepassPassword,
      entries: [
        {
          title: "Planted kdbx login",
          strings: {
            UserName: "test.person",
            Password: "Fake-Planted-2",
            URL: "https://bank.example.test/",
            "keykeeper.fill": rule,
            "keykeeper.template-definition": copy,
          },
          protected: ["Password", "keykeeper.fill"],
        },
      ],
    }),
  });
  await importAndConfirm(page, 1, [], importPage.includes("/organizations/"));
}

/** The planted .kdbx item's fields: ours, under visible names only. */
function expectPlantedKdbxFields(fields: { name: string; value: string }[], rule: string, copy: string) {
  expect(fields).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "Imported keykeeper.fill", value: rule }),
      expect.objectContaining({ name: "Imported keykeeper.template-definition", value: copy }),
    ]),
  );
  expect(fields.filter((f) => f.name.startsWith("keykeeper."))).toEqual([]);
}

// A crafted export can't plant our own fields (DESIGN.md, "Importing from
// other password managers"): a fill rule that sends the password into a
// search box, or a template definition saying it's an MSP's copy, which hides
// an item from the vault's lists while it still fills. From another password
// manager they come in under visible names; from our own .json export, only
// well-formed ones, and never as an MSP's copy.
test("an import never plants our own fields: fill rules, or an MSP's template copy, from KeePass's .kdbx too", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const user = webUserFor("formats-planted", testInfo.repeatEachIndex);
  await signUp(page, user);
  const rule = JSON.stringify({ v: 1, host: "bank.example.test", field: { id: "q" }, fill: { from: "password" } });
  const copy = JSON.stringify({ id: "planted-template", base: "note", v: 1, from: "Your MSP" });
  const csvValue = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const planted = [
    {
      option: "1Password 8 (csv)",
      file: {
        name: "planted.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          "Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes,keykeeper.fill\n" +
            `Planted CSV login,https://bank.example.test/,test.person,Fake-Planted-1,,false,false,,,${csvValue(rule)}\n`,
        ),
      },
    },
    {
      option: "KeePass 2 (xml)",
      file: {
        name: "planted.xml",
        mimeType: "text/xml",
        buffer: Buffer.from(`<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<KeePassFile><Root><Group><Name>Database</Name><Entry>
  <String><Key>Title</Key><Value>Planted KeePass note</Value></String>
  <String><Key>keykeeper.template-definition</Key><Value>${xml(copy)}</Value></String>
</Entry></Group></Root></KeePassFile>`),
      },
    },
    {
      option: "PassBundle or Bitwarden (json)",
      file: {
        name: "planted.json",
        mimeType: "application/json",
        buffer: Buffer.from(
          JSON.stringify({
            encrypted: false,
            folders: [],
            items: [
              {
                type: 2,
                name: "Planted template",
                notes: null,
                favorite: false,
                secureNote: { type: 0 },
                fields: [
                  { name: "Model", value: "not-a-real-model", type: 0, linkedId: null },
                  { name: "keykeeper.template-definition", value: copy, type: 0, linkedId: null },
                  { name: "keykeeper.fill", value: "{not a rule", type: 1, linkedId: null },
                ],
              },
            ],
          }),
        ),
      },
    },
  ];
  for (const { option, file } of planted) {
    await page.goto("/#/tools/import");
    await chooseFormat(page, option);
    await chooseFile(page, file);
    await importAndConfirm(page, 1);
  }
  await importPlantedKdbx(page, "/#/tools/import", rule, copy);

  const vault = await readVault(page, user);
  const fields = (name: string) =>
    (vault.items.find((i: Record<string, unknown>) => i.name === name)?.fields ?? []) as { name: string; value: string }[];
  // From other password managers: kept, under visible names.
  expect(fields("Planted CSV login")).toEqual([
    expect.objectContaining({ name: "Imported keykeeper.fill", value: rule }),
  ]);
  expect(fields("Planted KeePass note")).toEqual([
    expect.objectContaining({ name: "Imported keykeeper.template-definition", value: copy }),
  ]);
  expectPlantedKdbxFields(fields("Planted kdbx login"), rule, copy);
  // From our own export: the template, but not as an MSP's copy, and the
  // rule that isn't one kept visibly.
  expect(fields("Planted template")).toEqual([
    expect.objectContaining({ name: "Model", value: "not-a-real-model" }),
    expect.objectContaining({
      name: "keykeeper.template-definition",
      value: JSON.stringify({ id: "planted-template", base: "note", v: 1 }),
    }),
    expect.objectContaining({ name: "Imported keykeeper.fill", value: "{not a rule" }),
  ]);
  // So every item shows in All items, none hidden as a copy.
  await page.goto("/#/vault");
  await expect(menuEntry(page, "All items")).toContainText("4");
});

// The same from an organization's admin console, where the import can leave
// items in no shared folder, which a sync doesn't show: the check reads the
// organization's items as that page does, and saves them as its admin.
test("a KeePass .kdbx imported in an organization's admin console can't plant our fields either", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const user = webUserFor("formats-planted-org", testInfo.repeatEachIndex);
  await signUp(page, user);
  await page.goto("/#/create-organization");
  await page.getByRole("textbox", { name: /Organization name/ }).fill("Planted Org");
  await page.getByRole("radio", { name: /A family or a group/ }).check();
  await page.getByRole("button", { name: "Create organization" }).click();
  await page.waitForURL(/#\/organizations\/[0-9a-f-]{36}\/members/);
  const org = /#\/organizations\/([0-9a-f-]{36})/.exec(page.url())![1];
  const rule = JSON.stringify({ v: 1, host: "bank.example.test", field: { id: "q" }, fill: { from: "password" } });
  const copy = JSON.stringify({ id: "planted-template", base: "note", v: 1, from: "Your MSP" });

  await importPlantedKdbx(page, `/#/organizations/${org}/settings/tools/import`, rule, copy);

  const vault = await readVault(page, user, `/#/organizations/${org}/settings/tools/export`);
  const item = vault.items.find((i: Record<string, unknown>) => i.name === "Planted kdbx login");
  expectPlantedKdbxFields((item?.fields ?? []) as { name: string; value: string }[], rule, copy);
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
