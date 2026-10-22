// The autofill corpus and its scoreboard (DESIGN.md, "Autofill" and "How it
// keeps getting better"). Each fixture is a reduced sign-in page with one hard
// pattern, served on corpus.example.test; the extension fills it from the menu
// inside a field, and each field it should or shouldn't fill is checked. The
// score is printed and attached to the report. A page that fills today must
// keep filling: if one breaks, the test fails. One that's known to fail says
// why; when it starts filling, the test fails too, so the list gets updated.
import type { BrowserContext, Frame, Page } from "@playwright/test";

import { createAccount, expect, logInPopup, openPopup, test, userFor } from "./support/extension";
import { addLogin, waitForInlineMenuItem } from "./support/autofill";

const SITE = "https://corpus.example.test";
const ITEM = "Corpus login";
const USERNAME = "corpus-user";
const PASSWORD = "not-a-real-password-corpus";

type Want = "username" | "password" | "empty";

type Fixture = {
  file: string;
  /** The pattern it stands for. */
  what: string;
  /** The frame the fields are in, if not the page itself. */
  frame?: string;
  /**
   * In order: optionally click something, then fill from the menu in a field,
   * clicking it first unless the page put the cursor there (`focused`).
   */
  steps: { click?: string; field: string; focused?: boolean }[];
  /** Each field to check, and what it should hold after filling. */
  want: Record<string, Want>;
  /** Why it doesn't fill right today; leave out when it does. */
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

/**
 * Picks the corpus login from the menu inside a field. Like the shared
 * helper, but focus may be in a frame or a shadow root, so it asks whether an
 * input deep down still has it. Says which part failed: no menu, a menu that
 * didn't take the keyboard, or nothing filled.
 */
async function fillFromMenu(
  context: BrowserContext,
  page: Page,
  where: Page | Frame,
  field: string,
  focused = false,
) {
  if (!focused) {
    await where.locator(field).click();
  }
  try {
    await waitForInlineMenuItem(context, page, ITEM);
  } catch {
    throw new Error(`no menu in ${field}`);
  }
  const focusLeftThePage = () =>
    page.evaluate(() => {
      let el: Element | null = document.activeElement;
      for (;;) {
        if (el?.shadowRoot?.activeElement) {
          el = el.shadowRoot.activeElement;
        } else if (el instanceof HTMLIFrameElement && el.contentDocument?.activeElement) {
          el = el.contentDocument.activeElement;
        } else {
          break;
        }
      }
      return el?.tagName !== "INPUT";
    });
  try {
    await expect(async () => {
      if (!(await focusLeftThePage())) {
        await page.keyboard.press("ArrowDown");
      }
      await expect.poll(focusLeftThePage, { timeout: 1000 }).toBe(true);
    }).toPass({ timeout: 10_000 });
  } catch {
    throw new Error(`the menu in ${field} didn't take the keyboard`);
  }
  await page.keyboard.press("Enter");
  try {
    await expect(where.locator(field)).not.toHaveValue("", { timeout: 5000 });
  } catch {
    throw new Error(`picked in ${field}, but it stayed empty`);
  }
}

type Result = { file: string; what: string; filled: boolean; known?: string; detail: string };

async function score(context: BrowserContext, fixture: Fixture): Promise<Result> {
  const page = await context.newPage();
  const misses: string[] = [];
  try {
    await page.goto(`${SITE}/${fixture.file}`);
    const where = await fieldsIn(page, fixture);
    for (const [i, step] of fixture.steps.entries()) {
      try {
        if (step.click) {
          // A person takes a moment between things; so does the page.
          await page.waitForTimeout(700);
          await where.locator(step.click).click();
          await page.waitForTimeout(700);
        }
        await fillFromMenu(context, page, where, step.field, step.focused);
      } catch (e) {
        throw new Error(`step ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Anything else the fill would do has happened by now.
    await page.waitForTimeout(500);
    for (const [field, want] of Object.entries(fixture.want)) {
      const got = await where.locator(field).inputValue();
      if (got !== value(want)) {
        misses.push(`${field} has "${got}", wanted ${want}`);
      }
    }
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
  };
}

test("the autofill corpus: what fills, and what doesn't yet", async ({ context, extensionId }, testInfo) => {
  test.setTimeout(corpus.length * 45_000 + 60_000);
  const user = userFor("corpus", testInfo.repeatEachIndex);
  const web = await createAccount(context, user);
  await addLogin(web, { name: ITEM, username: USERNAME, password: PASSWORD, uri: SITE });
  await web.close();
  await logInPopup(await openPopup(context, extensionId), user);

  // CORPUS_ONLY=<file> runs one page, while working on it.
  const only = process.env.CORPUS_ONLY;
  const results: Result[] = [];
  for (const fixture of corpus.filter((f) => !only || f.file === only)) {
    results.push(await score(context, fixture));
  }

  const filled = results.filter((r) => r.filled).length;
  const table = [
    `Autofill corpus: ${filled} of ${results.length} pages fill right`,
    ...results.map(
      (r) =>
        `${r.filled ? "fills " : r.known ? "known " : "BROKE "} ${r.file.padEnd(32)} ${r.what}${r.detail ? ` (${r.detail})` : ""}`,
    ),
  ].join("\n");
  console.log(table);
  await testInfo.attach("autofill-scoreboard.json", {
    body: JSON.stringify({ filled, total: results.length, results }, null, 2),
    contentType: "application/json",
  });

  const broke = results.filter((r) => !r.filled && !r.known);
  const nowFill = results.filter((r) => r.filled && r.known);
  expect(broke.map((r) => `${r.file}: ${r.detail}`), "pages that filled before and don't now").toEqual([]);
  expect(nowFill.map((r) => r.file), "pages that fill now: drop their `known`").toEqual([]);
});
