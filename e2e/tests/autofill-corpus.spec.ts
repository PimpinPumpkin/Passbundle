// The autofill corpus and its scoreboard (DESIGN.md, "Autofill" and "How it
// keeps getting better"). Each fixture is a reduced sign-in page with one hard
// pattern, served on corpus.example.test; the extension fills it from the menu
// inside a field, and each field it should or shouldn't fill is checked. The
// score is printed and attached to the report. A page that fills today must
// keep filling: if one breaks, the test fails. One that's known to fail says
// why; when it starts filling, the test fails too, so the list gets updated.
//
// Upstream's own extension (KK_UPSTREAM_EXTENSION: built by
// upstream-extension.sh from the release tag our clients are based on) fills
// the same pages the same way in the second test. The two scores are printed
// side by side and written, page by page, to autofill-scoreboard.json in the
// output folder. Upstream's misses never fail anything: they're the
// comparison.
import fs from "node:fs";
import path from "node:path";

import type { BrowserContext, Frame, Page, TestInfo } from "@playwright/test";

import { paths } from "../paths.mjs";
import {
  createAccount,
  expect,
  extensionIdOf,
  launchWithExtension,
  logInPopup,
  openPopup,
  serverUrl,
  test,
  userFor,
  type User,
} from "./support/extension";
import { addLogin, hasElementDeep, waitForInlineMenuItem } from "./support/autofill";

const SITE = "https://corpus.example.test";
const ITEM = "Corpus login";
const USERNAME = "corpus-user";
const PASSWORD = "not-a-real-password-corpus";

/** What a field holds after filling: "unchanged" is what it held when the page loaded. */
type Want = "username" | "password" | "empty" | "unchanged";

type Step = {
  /** Clicked first: a button or a link, as a person would. */
  click?: string;
  /** The field whose menu fills the login. */
  field: string;
  /** The page put the cursor there itself, so it isn't clicked. */
  focused?: boolean;
  /**
   * Nothing of the login belongs in this field, and its menu may not offer
   * it: pick it if it's offered, without expecting the field to fill.
   */
  optional?: boolean;
  /** Fields to check right after this step, before the page moves on. */
  check?: Record<string, Want>;
};

type Fixture = {
  file: string;
  /** The pattern it stands for. */
  what: string;
  /** The frame the fields are in, if not the page itself. */
  frame?: string;
  /** In order: optionally click something, then fill from the menu in a field. */
  steps: Step[];
  /** Each field to check at the end, and what it should hold. */
  want: Record<string, Want>;
  /** Why our extension doesn't fill it right today; leave out when it does. */
  known?: string;
};

const corpus: Fixture[] = [
  {
    file: "simple-login.html",
    what: "a labeled username and password in one form",
    steps: [{ field: "#username" }],
    want: { "#username": "username", "#password": "password" },
  },
  {
    file: "email-then-password.html",
    what: "the email first, then the password in its place",
    steps: [{ field: "#email" }, { click: "#next", field: "#password" }],
    want: { "#email": "username", "#password": "password" },
  },
  {
    file: "email-then-password-focus.html",
    what: "two steps, and Next puts the cursor in the password field",
    steps: [{ field: "#email" }, { click: "#next", field: "#password", focused: true }],
    want: { "#email": "username", "#password": "password" },
  },
  {
    file: "late-login.html",
    what: "a single-page app that draws the form after loading",
    steps: [{ field: "#username" }],
    want: { "#username": "username", "#password": "password" },
  },
  {
    file: "no-form-login.html",
    what: "fields without a form element",
    steps: [{ field: "#user" }],
    want: { "#user": "username", "#pass": "password" },
  },
  {
    file: "shadow-login.html",
    what: "a web component's shadow root",
    steps: [{ field: "#username" }],
    want: { "#username": "username", "#password": "password" },
  },
  {
    file: "iframe-login.html",
    what: "a frame from the same site",
    frame: "#login",
    steps: [{ field: "#username" }],
    want: { "#username": "username", "#password": "password" },
  },
  {
    file: "honeypot-login.html",
    what: "hidden decoy fields beside the real ones",
    steps: [{ field: "#login" }],
    want: { "#login": "username", "#secret": "password", "#trap-user": "empty", "#trap-pass": "empty" },
  },
  {
    file: "search-and-login.html",
    what: "a site search and a newsletter box around the login",
    steps: [{ field: "#username" }],
    want: { "#username": "username", "#password": "password", "#q": "empty", "#news": "empty" },
  },
  {
    file: "label-wrapped-login.html",
    what: "fields wrapped in their labels, with no ids or names",
    steps: [{ field: "label.one input" }],
    want: { "label.one input": "username", "label.two input": "password" },
  },
  {
    file: "placeholder-login.html",
    what: "placeholders only, no labels",
    steps: [{ field: "input[name=f1]" }],
    want: { "input[name=f1]": "username", "input[name=f2]": "password" },
  },
  {
    file: "aria-label-login.html",
    what: "aria-labels only, from the password field",
    steps: [{ field: "#i_18" }],
    want: { "#i_17": "username", "#i_18": "password" },
  },
  {
    file: "aria-label-login.html",
    what: "aria-labels only, from the username field",
    steps: [{ field: "#i_17" }],
    want: { "#i_17": "username", "#i_18": "password" },
  },
  {
    file: "change-password.html",
    what: "a change-password form: only the current password",
    steps: [{ field: "#current" }],
    want: { "#current": "password", "#new": "empty", "#confirm": "empty" },
  },
  {
    file: "swap-step-login.html",
    what: "two steps, and Next draws a new form with the password field",
    steps: [{ field: "#username", check: { "#username": "username" } }, { click: "#next", field: "#password" }],
    want: { "#password": "password" },
  },
  {
    file: "route-login.html",
    what: "a single-page app's route change draws the sign-in later",
    steps: [{ click: "#sign-in-link", field: "#username" }],
    want: { "#username": "username", "#password": "password" },
  },
  {
    file: "modal-login.html",
    what: "a sign-in in a modal dialog a button opens",
    steps: [{ click: "#open", field: "#username" }],
    want: { "#username": "username", "#password": "password" },
  },
  {
    file: "login-and-signup.html",
    what: "sign-in and sign-up forms side by side: only the sign-in",
    steps: [{ field: "#login-email" }],
    want: {
      "#login-email": "username",
      "#login-password": "password",
      "#signup-name": "empty",
      "#signup-email": "empty",
      "#signup-password": "empty",
      "#signup-confirm": "empty",
    },
  },
  {
    file: "account-number-login.html",
    what: "the username is an account number in a phone-style field",
    steps: [{ field: "#account" }],
    want: { "#account": "username", "#password": "password" },
  },
  {
    file: "show-password.html",
    what: "a show-password toggle pressed first: the password field is text",
    steps: [{ click: "#toggle", field: "#username" }],
    want: { "#username": "username", "#password": "password" },
  },
  {
    file: "generated-ids.html",
    what: "ids and names made up on every load, and autocomplete off",
    steps: [{ field: "#f input[type=text]" }],
    want: { "#f input[type=text]": "username", "#f input[type=password]": "password" },
  },
  {
    file: "nested-shadow-login.html",
    what: "each field in a shadow root of its own, inside another",
    steps: [{ field: "#username" }],
    want: { "#username": "username", "#password": "password" },
  },
  {
    file: "table-login.html",
    what: "a sign-in laid out in a table, the words in the next cells",
    steps: [{ field: "input[name=uid]" }],
    want: { "input[name=uid]": "username", "input[name=pwd]": "password" },
  },
  {
    file: "domain-select-login.html",
    what: "a domain list between the fields, and remember me",
    steps: [{ field: "#username" }],
    want: { "#username": "username", "#password": "password", "#domain": "unchanged", "#remember": "unchanged" },
  },
  {
    file: "reordered-login.html",
    what: "the username after the password in the source, above it on screen",
    steps: [{ field: "#username" }],
    want: { "#username": "username", "#password": "password" },
  },
  {
    file: "german-login.html",
    what: "a page in German, with a German site search",
    steps: [{ field: "#benutzer" }],
    want: { "#benutzer": "username", "#kennwort": "password", "input[name=suchbegriff]": "empty" },
  },
  {
    file: "password-then-code.html",
    what: "a code step after the password, in the same form",
    steps: [{ field: "#username" }, { click: "#sign-in", field: "#code", focused: true, optional: true }],
    want: { "#username": "username", "#password": "password", "#code": "empty" },
  },
  {
    file: "heading-only-login.html",
    what: "no form, labels, ids, or names: only a heading",
    steps: [{ field: ".panel input[type=text]" }],
    want: { ".panel input[type=text]": "username", ".panel input[type=password]": "password" },
  },
  {
    file: "other-site-frame.html",
    what: "a sign-in frame from another site: nothing fills",
    frame: "#login",
    steps: [{ field: "#username", optional: true }],
    want: { "#username": "empty", "#password": "empty" },
  },
  {
    file: "pin-beside-password.html",
    what: "a security PIN beside the password, both masked: only the password",
    steps: [{ field: "#customer" }],
    want: { "#customer": "username", "#password": "password", "#pin": "empty" },
    known:
      "two masked fields in one form read as a sign-up form, so no field gets the menu (upstream's rule); a short numeric one should count as a PIN, not a second password",
  },
  {
    file: "controlled-inputs.html",
    what: "a framework draws the fields from its own copy of their values",
    steps: [{ field: "#username" }],
    want: { "#username": "username", "#password": "password" },
  },
  {
    file: "new-password-sign-in.html",
    what: "a sign-in whose password field says new-password",
    steps: [{ field: "#username" }],
    want: { "#username": "username", "#password": "password" },
  },
];

const value = (want: Want) => (want === "username" ? USERNAME : want === "password" ? PASSWORD : "");

/** Where the fields are: the page, or a frame in it. */
async function fieldsIn(page: Page, fixture: Fixture): Promise<Page | Frame> {
  if (!fixture.frame) {
    return page;
  }
  const handle = await page.locator(fixture.frame).elementHandle();
  return (await handle!.contentFrame())!;
}

type FieldState = { value: string; checked: boolean | null };

const stateOf = (where: Page | Frame, field: string): Promise<FieldState> =>
  where.locator(field).evaluate((el) => ({
    value: (el as HTMLInputElement).value,
    checked: el instanceof HTMLInputElement && ["checkbox", "radio"].includes(el.type) ? el.checked : null,
  }));

/** Whether the menu inside a field lists the corpus login, within `timeout`. */
async function menuOffersLogin(context: BrowserContext, page: Page, timeout: number) {
  if (timeout >= 15_000) {
    await waitForInlineMenuItem(context, page, ITEM);
    return true;
  }
  try {
    await expect
      .poll(
        async () => {
          const list = page.frames().find((f) => f.url().endsWith("menu-list.html"));
          if (!list) return false;
          try {
            return await hasElementDeep(context, list, (n) => n.nodeType === 3 && (n.nodeValue ?? "").includes(ITEM));
          } catch {
            return false;
          }
        },
        { timeout },
      )
      .toBe(true);
    return true;
  } catch {
    return false;
  }
}

/**
 * Picks the corpus login from the menu inside a field. Like the shared
 * helper, but the field may be in a frame or a shadow root. Says which part
 * failed: no menu, a menu that didn't take the keyboard, or nothing filled. An
 * optional step that isn't offered the login, or whose menu doesn't take the
 * keyboard, just goes on.
 */
async function fillFromMenu(context: BrowserContext, page: Page, where: Page | Frame, step: Step) {
  const { field, focused, optional } = step;
  if (!focused) {
    await where.locator(field).click();
  }
  try {
    if (!(await menuOffersLogin(context, page, optional ? 6000 : 15_000))) {
      return;
    }
  } catch {
    throw new Error(`no menu in ${field}`);
  }
  // Asked in the field's own document, since a frame from another site can't
  // be looked into from the page.
  const focusLeftTheField = () =>
    where
      .locator(field)
      .evaluate((el) => (el.getRootNode() as Document | ShadowRoot).activeElement !== el || !el.ownerDocument.hasFocus());
  try {
    await expect(async () => {
      if (!(await focusLeftTheField())) {
        await page.keyboard.press("ArrowDown");
      }
      await expect.poll(focusLeftTheField, { timeout: 1000 }).toBe(true);
    }).toPass({ timeout: optional ? 5000 : 10_000 });
  } catch {
    if (optional) return;
    throw new Error(`the menu in ${field} didn't take the keyboard`);
  }
  await page.keyboard.press("Enter");
  if (optional) {
    // Whatever the pick fills ends before the tab closes. Upstream's
    // extension keeps every field's menu closed, on every page after, when a
    // tab closes mid-fill (tab-close-mid-fill.spec.ts), which would score
    // its misses on the pages after this one.
    await page.waitForTimeout(1000);
    return;
  }
  try {
    await expect(where.locator(field)).not.toHaveValue("", { timeout: 5000 });
  } catch {
    throw new Error(`picked in ${field}, but it stayed empty`);
  }
}

/** The fields that don't hold what they should, in words. */
async function wrongFields(where: Page | Frame, want: Record<string, Want>, before: Map<string, FieldState>) {
  const misses: string[] = [];
  for (const [field, wanted] of Object.entries(want)) {
    if (wanted === "unchanged") {
      const now = await stateOf(where, field);
      const then = before.get(field)!;
      if (now.value !== then.value || now.checked !== then.checked) {
        misses.push(`${field} changed to ${JSON.stringify(now)}`);
      }
      continue;
    }
    const got = await where.locator(field).inputValue();
    if (got !== value(wanted)) {
      misses.push(`${field} has "${got}", wanted ${wanted}`);
    }
  }
  return misses;
}

type Result = {
  file: string;
  what: string;
  filled: boolean;
  known?: string;
  detail: string;
  /** What the page asked in a dialog, if anything: the test always says no. */
  asked?: string;
};

async function score(context: BrowserContext, fixture: Fixture): Promise<Result> {
  const page = await context.newPage();
  const misses: string[] = [];
  const asked: string[] = [];
  page.on("dialog", (dialog) => {
    asked.push(dialog.message());
    dialog.dismiss().catch(() => {});
  });
  try {
    await page.goto(`${SITE}/${fixture.file}`);
    const where = await fieldsIn(page, fixture);
    const before = new Map<string, FieldState>();
    for (const [field, wanted] of Object.entries(fixture.want)) {
      if (wanted === "unchanged") {
        before.set(field, await stateOf(where, field));
      }
    }
    for (const [i, step] of fixture.steps.entries()) {
      try {
        if (step.click) {
          // A person takes a moment between things; so does the page.
          await page.waitForTimeout(700);
          await where.locator(step.click).click();
          await page.waitForTimeout(700);
        }
        await fillFromMenu(context, page, where, step);
        if (step.check) {
          misses.push(...(await wrongFields(where, step.check, before)).map((m) => `after step ${i + 1}: ${m}`));
        }
      } catch (e) {
        throw new Error(`step ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Anything else the fill would do has happened by now.
    await page.waitForTimeout(500);
    misses.push(...(await wrongFields(where, fixture.want, before)));
  } catch (e) {
    misses.push(e instanceof Error ? e.message : String(e));
  } finally {
    await page.close();
  }
  return {
    file: fixture.file,
    what: fixture.what,
    filled: misses.length === 0,
    known: fixture.known,
    detail: misses.join("; "),
    asked: asked.length ? asked.join(" / ").replace(/\s+/g, " ").trim() : undefined,
  };
}

const asked = (r: Result) => (r.asked ? ` [the page asked "${r.asked}"; the test said no]` : "");

/** The corpus pages to run: CORPUS_ONLY=<file>[,<file>...] runs only those, while working on them. */
const pages = () => corpus.filter((f) => !process.env.CORPUS_ONLY || process.env.CORPUS_ONLY.split(",").includes(f.file));

const oursFile = (testInfo: TestInfo) =>
  path.join(testInfo.project.outputDir, `autofill-corpus-ours-${testInfo.repeatEachIndex}.json`);
const summaryFile = (testInfo: TestInfo) => path.join(testInfo.project.outputDir, "autofill-scoreboard.json");

type Upstream = { version: string; tag: string | null; results: Result[] };

/**
 * The scoreboard's small summary, ours and upstream's page by page, written
 * where CI uploads it from, and attached to the report.
 */
async function writeSummary(testInfo: TestInfo, ours: Result[] | null, upstream: Upstream | null) {
  const count = (results: Result[] | null) => (results ? results.filter((r) => r.filled).length : null);
  const list = ours ?? upstream?.results ?? [];
  const summary = {
    pages: list.length,
    ours: count(ours),
    upstream: upstream ? { version: upstream.version, tag: upstream.tag, filled: count(upstream.results) } : null,
    results: list.map((r, i) => ({
      file: r.file,
      what: r.what,
      ours: ours
        ? {
            result: ours[i].filled ? "fills" : ours[i].known ? "known miss" : "broke",
            detail: ours[i].detail || undefined,
            asked: ours[i].asked,
          }
        : undefined,
      upstream: upstream
        ? {
            result: upstream.results[i].filled ? "fills" : "misses",
            detail: upstream.results[i].detail || undefined,
            asked: upstream.results[i].asked,
          }
        : undefined,
    })),
  };
  const body = JSON.stringify(summary, null, 2);
  fs.mkdirSync(testInfo.project.outputDir, { recursive: true });
  fs.writeFileSync(summaryFile(testInfo), body);
  await testInfo.attach("autofill-scoreboard.json", { body, contentType: "application/json" });
}

test("the autofill corpus: what fills, and what doesn't yet", async ({ context, extensionId }, testInfo) => {
  test.setTimeout(corpus.length * 45_000 + 60_000);
  const user = userFor("corpus", testInfo.repeatEachIndex);
  const web = await createAccount(context, user);
  await addLogin(web, { name: ITEM, username: USERNAME, password: PASSWORD, uri: SITE });
  await web.close();
  await logInPopup(await openPopup(context, extensionId), user);

  const results: Result[] = [];
  for (const fixture of pages()) {
    results.push(await score(context, fixture));
  }

  const filled = results.filter((r) => r.filled).length;
  const table = [
    `Autofill corpus: ${filled} of ${results.length} pages fill right`,
    ...results.map(
      (r) =>
        `${r.filled ? "fills " : r.known ? "known " : "BROKE "} ${r.file.padEnd(32)} ${r.what}${r.detail ? ` (${r.detail})` : ""}${asked(r)}`,
    ),
  ].join("\n");
  console.log(table);
  fs.mkdirSync(testInfo.project.outputDir, { recursive: true });
  fs.writeFileSync(oursFile(testInfo), JSON.stringify(results));
  await writeSummary(testInfo, results, null);

  const broke = results.filter((r) => !r.filled && !r.known);
  const nowFill = results.filter((r) => r.filled && r.known);
  expect(broke.map((r) => `${r.file}: ${r.detail}`), "pages that filled before and don't now").toEqual([]);
  expect(nowFill.map((r) => r.file), "pages that fill now: drop their `known`").toEqual([]);
});

/**
 * Signs in to upstream's popup on our test server, the way a person picks a
 * self-hosted server there.
 */
async function logInUpstreamPopup(popup: Page, user: User) {
  // Its welcome screens draw their buttons before they work; an early click
  // is dropped.
  await expect(async () => {
    await popup.getByRole("button", { name: "Log in" }).click();
    await expect(popup).toHaveURL(/#\/login/, { timeout: 1000 });
  }).toPass();
  await popup.getByRole("button", { name: "bitwarden.com" }).click();
  await popup.getByRole("menuitem", { name: "self-hosted" }).click();
  const server = popup.getByRole("dialog", { name: "Self-hosted environment" });
  await server.getByRole("textbox", { name: "Server URL" }).fill(serverUrl);
  await server.getByRole("button", { name: "Save" }).click();
  await expect(server).toBeHidden();
  await popup.getByRole("textbox", { name: /Email address/ }).fill(user.email);
  await popup.getByRole("button", { name: "Continue" }).click();
  await popup.getByRole("textbox", { name: /Master password/ }).fill(user.password);
  await popup.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(popup.getByRole("heading", { name: "Vault" })).toBeVisible({ timeout: 30_000 });
}

test("upstream's extension on the same corpus, for the scoreboard", async ({}, testInfo) => {
  const upstreamBuild = paths.upstreamExtension;
  test.skip(!upstreamBuild, "no upstream build to compare with (KK_UPSTREAM_EXTENSION)");
  test.setTimeout(corpus.length * 45_000 + 90_000);
  const version: string = JSON.parse(fs.readFileSync(path.join(upstreamBuild!, "manifest.json"), "utf8")).version;
  const tag = process.env.KK_UPSTREAM_TAG ?? null;

  const { context, profile } = await launchWithExtension(undefined, upstreamBuild);
  const results: Result[] = [];
  try {
    const extensionId = await extensionIdOf(context);
    const user = userFor("corpus-upstream", testInfo.repeatEachIndex);
    const web = await createAccount(context, user);
    await addLogin(web, { name: ITEM, username: USERNAME, password: PASSWORD, uri: SITE });
    await web.close();
    await logInUpstreamPopup(await openPopup(context, extensionId), user);
    for (const fixture of pages()) {
      results.push({ ...(await score(context, fixture)), known: undefined });
    }
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }

  // Ours, from the test before, when it ran.
  let ours: Result[] | null = null;
  try {
    ours = JSON.parse(fs.readFileSync(oursFile(testInfo), "utf8"));
  } catch {
    ours = null;
  }
  if (ours && ours.map((r) => r.file).join() !== results.map((r) => r.file).join()) {
    ours = null;
  }
  const count = (list: Result[]) => list.filter((r) => r.filled).length;
  const name = `upstream's ${version}${tag ? ` (${tag})` : ""}`;
  const table = [
    `Autofill scoreboard: ${ours ? `ours ${count(ours)}, ` : ""}${name} ${count(results)}, of ${results.length} pages`,
    `${ours ? "ours   " : ""}upstream  page`,
    ...results.map(
      (r, i) =>
        `${ours ? (ours[i].filled ? "fills  " : ours[i].known ? "known  " : "BROKE  ") : ""}${r.filled ? "fills   " : "misses  "}  ${r.file.padEnd(32)} ${r.what}${r.detail ? ` (upstream: ${r.detail})` : ""}${asked(r)}`,
    ),
  ].join("\n");
  console.log(table);
  await writeSummary(testInfo, ours, { version, tag, results });
});
