// Seats in the MSP console (DESIGN.md, "Seats by client"): an MSP admin sees
// each client's seats this month, what counts, the totals, an earlier month
// from the month picker, and downloads either month as CSV.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { port } from "../paths.mjs";

import { type Account, Api } from "./api/support";
import { signUpWithAuthenticator, webUserFor } from "./support/web";

/** A toast message. Toasts here have no ARIA role, so find them by text. */
const toast = (page: Page, text: string) => page.getByText(text, { exact: true });

/** The web vault's own access token, from its latest API request, for setup that needs no keys. */
function tokenOf(page: Page) {
  let token = "";
  page.on("request", (request) => {
    const header = request.headers()["authorization"];
    if (header?.startsWith("Bearer ") && request.url().includes("/api/")) {
      token = header.slice("Bearer ".length);
    }
  });
  return () => token;
}

/** A month this many months from this one (UTC), as the API names months. */
function monthFromNow(months: number): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 7);
}

const monthName = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/**
 * Writes a reading into the test server's SQLite database as if the server
 * had taken it on an earlier day: its clock can't be moved. Tests in the
 * browser run on SQLite only.
 */
async function recordEarlier(mspId: string, orgId: string, day: string, seats: number, name: string) {
  const data = fs.readFileSync(path.join(os.tmpdir(), `keykeeper-e2e-data-${port}`), "utf8");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(data, "db.sqlite3"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare(
      "INSERT INTO msp_client_seats (msp_uuid, org_uuid, day, seats, org_name) VALUES (?, ?, ?, ?, ?)",
    ).run(mspId, orgId, day, seats, name);
  } finally {
    db.close();
  }
}

test("an MSP admin sees each client's seats by month and downloads them as CSV", async ({
  page,
  request,
}, testInfo) => {
  test.skip(!!process.env.KK_DATABASE_URL, "writes an earlier month into the SQLite database");
  test.setTimeout(180_000);
  const token = tokenOf(page);
  const adminUser = webUserFor("msp-admin-seats", testInfo.repeatEachIndex);
  await signUpWithAuthenticator(page, adminUser);
  await page.goto("/#/msp");
  await page.getByRole("textbox", { name: "Your MSP's name" }).fill("Contoso IT");
  await page.getByRole("button", { name: "Create MSP" }).click();
  for (const name of ["Acme Dental", "Baker Law"]) {
    await page.getByRole("textbox", { name: "New client's name" }).fill(name);
    await page.getByRole("button", { name: "Add client" }).click();
    await expect(toast(page, `Added ${name}`)).toBeVisible();
  }

  // The clients' people join through the API, which needs no keys: two at
  // Acme Dental, one at Baker Law, and someone invited there who hasn't joined.
  const api = new Api(request);
  const admin: Account = { email: adminUser.email, password: "", token: token(), userId: "" };
  const mspId = (await api.call(admin, "GET", "/api/keykeeper/msp")).body.data.find(
    (m: { name: string }) => m.name === "Contoso IT",
  ).id as string;
  const clients = (await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}`)).body.clients as {
    id: string;
    name: string;
  }[];
  const acme = clients.find((c) => c.name === "Acme Dental")!.id;
  const baker = clients.find((c) => c.name === "Baker Law")!.id;
  for (const name of ["seats-ui-ana", "seats-ui-ben"]) {
    await api.addMember(admin, acme, await api.account(name), "user");
  }
  await api.addMember(admin, baker, await api.account("seats-ui-cara"), "user");
  const invited = await api.call(admin, "POST", `/api/organizations/${baker}/users/invite`, {
    emails: [`seats-ui-nobody-${testInfo.repeatEachIndex}@example.test`],
    type: 2,
    collections: [],
    groups: [],
    permissions: {},
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  // Last month, Acme Dental had more people for a day, under its old name.
  const last = monthFromNow(-1);
  await recordEarlier(mspId, acme, `${last}-01`, 4, "Acme Dental Old");
  await recordEarlier(mspId, acme, `${last}-02`, 2, "Acme Dental");

  await page.reload();
  const seats = page.getByTestId("msp-seats");
  await expect(seats.getByRole("heading", { name: "Seats" })).toBeVisible();
  await expect(seats.getByTestId("msp-seats-what-counts")).toHaveText(
    "A seat is each person in a client who has joined, counted once a day. People who've been invited but haven't joined don't count, and neither do your staff.",
  );
  const month = seats.getByRole("combobox", { name: "Month" });
  const now = monthFromNow(0);
  await expect(month).toHaveValue(now);
  await expect(month.getByRole("option")).toHaveText([`${monthName(now)} (this month)`, monthName(last)]);

  const row = (name: string) => seats.getByTestId(`msp-seats-${name}`);
  const cells = (name: string) => [
    row(name).getByTestId("msp-seats-most"),
    row(name).getByTestId("msp-seats-average"),
    row(name).getByTestId("msp-seats-today"),
  ];
  const expectRow = async (name: string, values: string[]) => {
    const [most, average, today] = cells(name);
    await expect(most).toHaveText(values[0]);
    await expect(average).toHaveText(values[1]);
    if (values.length > 2) {
      await expect(today).toHaveText(values[2]);
    } else {
      await expect(today).toHaveCount(0);
    }
  };
  await expect(seats.getByRole("columnheader")).toHaveText(["Client", "Most on any day", "Average", "Today"]);
  await expectRow("Acme Dental", ["2", "2.0", "2"]);
  await expectRow("Baker Law", ["1", "1.0", "1"]);
  await expectRow("total", ["3", "3.0", "3"]);

  const download = async (file: string) => {
    const [saved] = await Promise.all([
      page.waitForEvent("download"),
      seats.getByRole("button", { name: "Download CSV" }).click(),
    ]);
    expect(saved.suggestedFilename()).toBe(file);
    return fs.readFileSync(await saved.path(), "utf8");
  };
  expect(await download(`seats-${now}.csv`)).toBe(
    "\uFEFFMonth,Client,Most on any day,Average,Today\r\n" +
      `${now},Acme Dental,2,2.0,2\r\n` +
      `${now},Baker Law,1,1.0,1\r\n` +
      `${now},Total,3,3.0,3\r\n`,
  );

  // Last month: no Today column, Acme Dental's most on any day, and its
  // average over the two days recorded.
  await month.selectOption(last);
  await expect(seats.getByRole("columnheader")).toHaveText(["Client", "Most on any day", "Average"]);
  await expectRow("Acme Dental", ["4", "3.0"]);
  await expect(row("Baker Law")).toHaveCount(0);
  await expectRow("total", ["4", "3.0"]);
  expect(await download(`seats-${last}.csv`)).toBe(
    "\uFEFFMonth,Client,Most on any day,Average,Today\r\n" +
      `${last},Acme Dental,4,3.0,\r\n` +
      `${last},Total,4,3.0,\r\n`,
  );
});
