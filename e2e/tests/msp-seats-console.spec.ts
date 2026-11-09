// Seats in the MSP console (DESIGN.md, "Seats by client"): an MSP admin sees
// each client's seat-days, prorated seats, and peak this month, what counts
// and how a month is billed, the totals, an earlier month from the month
// picker, and downloads either month as CSV.
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

/** The days in a month (`YYYY-MM`): 28 to 31. */
function daysIn(month: string): number {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number, 0)).getUTCDate();
}

/** Seat-days over the days, to two decimals rounded half up, as the server and the console show them. */
function prorated(seatDays: number, days: number): string {
  const h = Math.floor((200 * seatDays + days) / (2 * days));
  return `${Math.floor(h / 100)}.${String(h % 100).padStart(2, "0")}`;
}

/** What the console says about how a month is billed. */
function howBilled(month: string): string {
  const name = new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  return (
    `Prorated seats are a client's seat-days (its seats each day, added up) divided by the ${daysIn(month)} days in ${name}, ` +
    "so a seat added late in the month counts only for its days. Peak is the most seats on any day, for reference."
  );
}

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
    "A seat is each person in a client who has joined, counted at the end of each day (UTC). People who've been invited but haven't joined don't count, and neither do your staff.",
  );
  const month = seats.getByRole("combobox", { name: "Month" });
  const now = monthFromNow(0);
  const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
  await expect(seats.getByTestId("msp-seats-how-billed")).toHaveText(howBilled(now));
  await expect(seats.getByTestId("msp-seats-through")).toHaveText(`So far, through ${today}.`);
  await expect(month).toHaveValue(now);
  await expect(month.getByRole("option")).toHaveText([`${monthName(now)} (this month)`, monthName(last)]);

  const row = (name: string) => seats.getByTestId(`msp-seats-${name}`);
  const cells = (name: string) => [
    row(name).getByTestId("msp-seats-seat-days"),
    row(name).getByTestId("msp-seats-prorated"),
    row(name).getByTestId("msp-seats-peak"),
    row(name).getByTestId("msp-seats-today"),
  ];
  /** Seat-days, prorated seats, peak, and today's when there's a Today column. */
  const expectRow = async (name: string, values: string[]) => {
    const [seatDays, proratedSeats, peak, today] = cells(name);
    await expect(seatDays).toHaveText(values[0]);
    await expect(proratedSeats).toHaveText(values[1]);
    await expect(peak).toHaveText(values[2]);
    if (values.length > 3) {
      await expect(today).toHaveText(values[3]);
    } else {
      await expect(today).toHaveCount(0);
    }
  };
  // This month so far: the clients were added today, and the month's
  // seat-days are divided by all of its days.
  const days = daysIn(now);
  await expect(seats.getByRole("columnheader")).toHaveText(["Client", "Seat-days", "Prorated seats", "Peak", "Today"]);
  await expectRow("Acme Dental", ["2", prorated(2, days), "2", "2"]);
  await expectRow("Baker Law", ["1", prorated(1, days), "1", "1"]);
  await expectRow("total", ["3", prorated(3, days), "3", "3"]);

  const download = async (file: string) => {
    const [saved] = await Promise.all([
      page.waitForEvent("download"),
      seats.getByRole("button", { name: "Download CSV" }).click(),
    ]);
    expect(saved.suggestedFilename()).toBe(file);
    return fs.readFileSync(await saved.path(), "utf8");
  };
  const header = "\uFEFFMonth,Through,Client,Seat-days,Days in month,Prorated seats,Peak,Today\r\n";
  const through = new Date().toISOString().slice(0, 10);
  expect(await download(`seats-${now}.csv`)).toBe(
    header +
      `${now},${through},Acme Dental,2,${days},${prorated(2, days)},2,2\r\n` +
      `${now},${through},Baker Law,1,${days},${prorated(1, days)},1,1\r\n` +
      `${now},${through},Total,3,${days},${prorated(3, days)},3,3\r\n`,
  );

  // Last month: no Today column or "So far", and Acme Dental's two days
  // recorded, 4 and 2, over all of the month's days, with 4 its peak.
  await month.selectOption(last);
  const lastDays = daysIn(last);
  await expect(seats.getByTestId("msp-seats-how-billed")).toHaveText(howBilled(last));
  await expect(seats.getByTestId("msp-seats-through")).toHaveCount(0);
  await expect(seats.getByRole("columnheader")).toHaveText(["Client", "Seat-days", "Prorated seats", "Peak"]);
  await expectRow("Acme Dental", ["6", prorated(6, lastDays), "4"]);
  await expect(row("Baker Law")).toHaveCount(0);
  await expectRow("total", ["6", prorated(6, lastDays), "4"]);
  const lastThrough = `${last}-${lastDays}`;
  expect(await download(`seats-${last}.csv`)).toBe(
    header +
      `${last},${lastThrough},Acme Dental,6,${lastDays},${prorated(6, lastDays)},4,\r\n` +
      `${last},${lastThrough},Total,6,${lastDays},${prorated(6, lastDays)},4,\r\n`,
  );
});
