// Seats by client (DESIGN.md, "Seats by client"): who counts as a seat (a
// client's member who joined, isn't revoked, and isn't the MSP's staff;
// someone in two clients counts in each), each client's seat-days, prorated
// seats (seat-days over the days in the month, two decimals), and peak over
// a month, today's, the CSV, and who may see them (MSP admins only; everyone
// else gets "not found", never 403, which would sign the web vault out). The
// daily record and earlier months run on a server of these tests' own, whose
// seats job runs every second and whose database the tests can write past
// months into: the server's clock can't be moved.
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { seatsServerPort } from "../../paths.mjs";

import { type Account, Api } from "./support";

const e2eDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Today (UTC), as the server names days. */
const today = () => new Date().toISOString().slice(0, 10);
/** This month (UTC), as the API names months. */
const thisMonth = () => today().slice(0, 7);
/** A month this many months from this one. */
function monthFromNow(months: number): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 7);
}

/** The days in a month (`YYYY-MM`): 28 to 31. */
function daysIn(month: string): number {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number, 0)).getUTCDate();
}

/** A month's last day, as the server names days. */
const lastDay = (month: string) => `${month}-${String(daysIn(month)).padStart(2, "0")}`;

/** Seat-days over the days, in hundredths, rounded half up as the server rounds them. */
const hundredths = (seatDays: number, days: number) => Math.floor((200 * seatDays + days) / (2 * days));
/** Prorated seats as the JSON has them. */
const prorated = (seatDays: number, days: number) => hundredths(seatDays, days) / 100;
/** Prorated seats as the CSV writes them: always two decimals. */
const proratedText = (seatDays: number, days: number) => {
  const h = hundredths(seatDays, days);
  return `${Math.floor(h / 100)}.${String(h % 100).padStart(2, "0")}`;
};

type ClientSeats = {
  id: string;
  name: string;
  current: boolean;
  seatDays: number;
  prorated: number;
  most: number;
  today: number | null;
};

/** A month's seats as an MSP admin sees them, by client name. */
async function seats(api: Api, admin: Account, mspId: string, month?: string) {
  const query = month ? `?month=${month}` : "";
  const answer = await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/seats${query}`);
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  const byName: Record<string, ClientSeats> = {};
  for (const c of answer.body.clients as ClientSeats[]) {
    byName[c.name] = c;
  }
  return { ...answer.body, byName };
}

/** An invitation to an address with no account: invited, never joined. */
async function inviteNobody(api: Api, admin: Account, orgId: string) {
  const email = `seats-nobody-${randomUUID().slice(0, 8)}@api.example.test`;
  const invited = await api.call(admin, "POST", `/api/organizations/${orgId}/users/invite`, {
    emails: [email],
    type: 2,
    collections: [],
    groups: [],
    permissions: {},
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  return email;
}

test("a seat is a client's member who joined: not the MSP's staff, the invited, or the revoked, and someone in two clients counts in each", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const admin = await api.account("seats-admin");
  const mspId = await api.msp(admin, "Seats MSP");
  const dental = await api.client(admin, mspId, "Seats Dental");
  const law = await api.client(admin, mspId, "Seats Law");

  // The MSP's people: its admin, an owner of each client, and a technician.
  const tech = await api.account("seats-tech");
  await api.addStaff(admin, mspId, tech, "technician");
  // Someone the client added itself, who then joined the MSP's staff: their
  // place in the client stays the client's own, but they're staff.
  const joinedStaff = await api.account("seats-joined-staff");
  await api.addMember(admin, dental, joinedStaff, "user");
  await api.addStaff(admin, mspId, joinedStaff, "technician");
  await api.confirmPending(admin, mspId);

  // The client's own people.
  const ana = await api.account("seats-ana");
  await api.addMember(admin, dental, ana, "user");
  // Accepted but not confirmed yet: joined, so a seat.
  const ben = await api.account("seats-ben");
  await api.addMember(admin, dental, ben, "user", { confirm: false });
  const nobody = await inviteNobody(api, admin, dental);
  const dan = await api.account("seats-dan");
  const danId = await api.addMember(admin, dental, dan, "user");
  const revoked = await api.call(admin, "PUT", `/api/organizations/${dental}/users/${danId}/revoke`);
  expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
  const eve = await api.account("seats-eve");
  await api.addMember(admin, dental, eve, "user");
  await api.addMember(admin, law, eve, "user");

  const status = Object.fromEntries((await api.members(admin, dental)).map((m) => [m.email, m.status]));
  expect(status[ben.email]).toBe(1);
  expect(status[nobody]).toBe(0);
  expect(status[dan.email]).toBeLessThan(0);
  expect(status[tech.email]).toBe(2);
  expect(status[joinedStaff.email]).toBe(2);

  const month = await seats(api, admin, mspId);
  const days = daysIn(thisMonth());
  expect(month.month).toBe(thisMonth());
  expect(month.thisMonth).toBe(true);
  expect(month.months).toEqual([thisMonth()]);
  // This month so far, over all of its days: the clients were added today.
  expect(month.daysInMonth).toBe(days);
  expect(month.through).toBe(today());
  expect(month.byName["Seats Dental"]).toEqual({
    id: dental,
    name: "Seats Dental",
    current: true,
    seatDays: 3,
    prorated: prorated(3, days),
    most: 3,
    today: 3,
  });
  expect(month.byName["Seats Law"]).toEqual({
    id: law,
    name: "Seats Law",
    current: true,
    seatDays: 1,
    prorated: prorated(1, days),
    most: 1,
    today: 1,
  });
  expect(month.totals).toEqual({ seatDays: 4, prorated: prorated(4, days), most: 4, today: 4 });

  // Restored, they count again; removed from the staff, a technician whose
  // place was the client's own is a seat there.
  const restored = await api.call(admin, "PUT", `/api/organizations/${dental}/users/${danId}/restore`);
  expect(restored.status, JSON.stringify(restored.body)).toBe(200);
  const left = await api.call(admin, "DELETE", `/api/keykeeper/msp/${mspId}/staff/${joinedStaff.userId}`);
  expect(left.status, JSON.stringify(left.body)).toBe(200);
  const later = await seats(api, admin, mspId);
  expect(later.byName["Seats Dental"]).toMatchObject({ seatDays: 5, most: 5, today: 5 });
  expect(later.byName["Seats Law"].today).toBe(1);
  expect(later.totals).toMatchObject({ seatDays: 6, prorated: prorated(6, days), today: 6 });
});

test("only the MSP's admins see seats: technicians, the client's own owner, another MSP's admin, and strangers get not found", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const admin = await api.account("seats-perm-admin");
  const mspId = await api.msp(admin, "Seats Matrix MSP");
  const orgId = await api.client(admin, mspId, "Seats Matrix Client");
  const tech = await api.account("seats-perm-tech");
  await api.addStaff(admin, mspId, tech, "technician");
  await api.confirmPending(admin, mspId);
  const owner = await api.account("seats-perm-owner");
  await api.addMember(admin, orgId, owner, "owner");
  const otherAdmin = await api.account("seats-perm-other");
  await api.msp(otherAdmin, "Other Seats MSP");
  const stranger = await api.account("seats-perm-stranger");

  const callers: [string, Account | null, number][] = [
    ["MSP admin", admin, 200],
    ["technician", tech, 404],
    ["client owner", owner, 404],
    ["another MSP's admin", otherAdmin, 404],
    ["stranger", stranger, 404],
    ["no one", null, 401],
  ];
  for (const query of ["", `?month=${thisMonth()}`, "?format=csv", `?month=${monthFromNow(-1)}&format=csv`]) {
    for (const [who, account, expected] of callers) {
      const answer = await api.call(account, "GET", `/api/keykeeper/msp/${mspId}/seats${query}`);
      expect(answer.status, `${who} ${query}: ${JSON.stringify(answer.body)}`).toBe(expected);
    }
  }
  // An MSP that doesn't exist is the same as one that isn't yours.
  const missing = await api.call(admin, "GET", `/api/keykeeper/msp/${randomUUID()}/seats`);
  expect(missing.status).toBe(404);
});

test("a month is YYYY-MM, this one or earlier, and the format json or csv", async ({ request }) => {
  const api = new Api(request);
  const admin = await api.account("seats-input-admin");
  const mspId = await api.msp(admin, "Seats Input MSP");
  for (const query of ["?month=2026-13", "?month=11-2026", "?month=next", `?month=${monthFromNow(1)}`, "?format=xml"]) {
    const answer = await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/seats${query}`);
    expect(answer.status, `${query}: ${JSON.stringify(answer.body)}`).toBe(400);
  }
  const old = await seats(api, admin, mspId, "2001-01");
  expect(old).toMatchObject({
    month: "2001-01",
    thisMonth: false,
    daysInMonth: 31,
    through: "2001-01-31",
    clients: [],
  });
  expect(old.totals).toEqual({ seatDays: 0, prorated: 0, most: 0, today: null });
});

test("the CSV has the month's line for each client and the total, names quoted and never read as formulas", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const admin = await api.account("seats-csv-admin");
  const mspId = await api.msp(admin, "Seats CSV MSP");
  const firm = await api.client(admin, mspId, "Smith, Jones & Co");
  const sneaky = await api.client(admin, mspId, '=HYPERLINK("https://example.test")');
  for (const name of ["seats-csv-a", "seats-csv-b"]) {
    await api.addMember(admin, firm, await api.account(name), "user");
  }
  await api.addMember(admin, sneaky, await api.account("seats-csv-c"), "user");
  await inviteNobody(api, admin, sneaky);

  const response = await request.get(`/api/keykeeper/msp/${mspId}/seats?format=csv`, {
    headers: { Authorization: `Bearer ${admin.token}` },
  });
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/csv");
  expect(response.headers()["content-disposition"]).toBe(`attachment; filename="seats-${thisMonth()}.csv"`);
  const m = thisMonth();
  const t = today();
  const d = daysIn(m);
  expect((await response.body()).toString("utf8")).toBe(
    "\uFEFFMonth,Through,Client,Seat-days,Days in month,Prorated seats,Peak,Today\r\n" +
      `${m},${t},"'=HYPERLINK(""https://example.test"")",1,${d},${proratedText(1, d)},1,1\r\n` +
      `${m},${t},"Smith, Jones & Co",2,${d},${proratedText(2, d)},2,2\r\n` +
      `${m},${t},Total,3,${d},${proratedText(3, d)},3,3\r\n`,
  );
});

test.describe("on a server that records seats every second", () => {
  test.use({ baseURL: `https://127.0.0.1:${seatsServerPort}` });

  let server: ChildProcess;
  let dataDir: string;

  test.beforeAll(async ({ playwright }) => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-e2e-seats-"));
    server = spawn(process.execPath, ["server.mjs"], {
      cwd: e2eDir,
      env: {
        ...process.env,
        KK_PORT: seatsServerPort,
        KK_DATA_DIR: dataDir,
        KK_SEATS_SCHEDULE: "* * * * * *",
      },
      stdio: "ignore",
    });
    const http = await playwright.request.newContext({ ignoreHTTPSErrors: true });
    await expect
      .poll(
        async () =>
          (await http.get(`https://127.0.0.1:${seatsServerPort}/alive`).catch(() => null))?.status() ?? 0,
        { timeout: 60_000 },
      )
      .toBe(200);
    await http.dispose();
  });

  test.afterAll(async () => {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await exited;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** Opens this server's SQLite database. */
  async function database(readOnly: boolean) {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(dataDir, "db.sqlite3"), { readOnly });
    db.exec("PRAGMA busy_timeout = 5000");
    return db;
  }

  /** What the server recorded for a client. */
  async function recorded(orgId: string) {
    const db = await database(true);
    try {
      return db
        .prepare("SELECT day, seats, org_name FROM msp_client_seats WHERE org_uuid = ? ORDER BY day")
        .all(orgId)
        .map((r) => ({ ...r }));
    } finally {
      db.close();
    }
  }

  /** Writes readings as the server would have taken them on earlier days. */
  async function record(mspId: string, rows: { orgId: string; day: string; seats: number; name: string }[]) {
    const db = await database(false);
    try {
      const insert = db.prepare(
        "INSERT INTO msp_client_seats (msp_uuid, org_uuid, day, seats, org_name) VALUES (?, ?, ?, ?, ?)",
      );
      for (const r of rows) {
        insert.run(mspId, r.orgId, r.day, r.seats, r.name);
      }
    } finally {
      db.close();
    }
  }

  test("the server records each client's seats for the day, and a client that left keeps its month", async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const api = new Api(request);
    const admin = await api.account("seats-daily-admin");
    const mspId = await api.msp(admin, "Seats Daily MSP");
    const clinic = await api.client(admin, mspId, "Seats Clinic");
    const bakery = await api.client(admin, mspId, "Seats Bakery");
    for (const name of ["seats-daily-a", "seats-daily-b"]) {
      await api.addMember(admin, clinic, await api.account(name), "user");
    }
    const bakeryOwner = await api.account("seats-bakery-owner");
    await api.addMember(admin, bakery, bakeryOwner, "owner");
    await api.addMember(admin, bakery, await api.account("seats-daily-c"), "user");

    await expect
      .poll(() => recorded(clinic), { timeout: 15_000 })
      .toEqual([{ day: today(), seats: 2, org_name: "Seats Clinic" }]);
    await expect
      .poll(() => recorded(bakery), { timeout: 15_000 })
      .toEqual([{ day: today(), seats: 2, org_name: "Seats Bakery" }]);
    // A later reading the same day replaces the day's.
    await api.addMember(admin, clinic, await api.account("seats-daily-d"), "user");
    await expect
      .poll(() => recorded(clinic), { timeout: 15_000 })
      .toEqual([{ day: today(), seats: 3, org_name: "Seats Clinic" }]);

    // The bakery leaves: its own owner removes the MSP, then deletes it.
    const removed = await api.call(bakeryOwner, "DELETE", `/api/keykeeper/organizations/${bakery}/msp`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    const deleted = await api.call(bakeryOwner, "DELETE", `/api/organizations/${bakery}`, {
      masterPasswordHash: bakeryOwner.password,
    });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);

    // The month still has it, by its name then, with its day and no seats
    // today.
    const month = await seats(api, admin, mspId);
    const days = daysIn(thisMonth());
    expect(month.byName["Seats Bakery"]).toEqual({
      id: bakery,
      name: "Seats Bakery",
      current: false,
      seatDays: 2,
      prorated: prorated(2, days),
      most: 2,
      today: null,
    });
    expect(month.byName["Seats Clinic"]).toMatchObject({ current: true, seatDays: 3, most: 3, today: 3 });
    expect(month.totals).toEqual({ seatDays: 5, prorated: prorated(5, days), most: 5, today: 3 });
    expect(await recorded(bakery)).toEqual([{ day: today(), seats: 2, org_name: "Seats Bakery" }]);
  });

  test("an earlier month: each client's seat-days, prorated over the month's own days, its peak, the months there are, and its CSV", async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const api = new Api(request);
    const admin = await api.account("seats-history-admin");
    const mspId = await api.msp(admin, "Seats History MSP");
    const dental = await api.client(admin, mspId, "History Dental");
    await api.addMember(admin, dental, await api.account("seats-history-a"), "user");
    const last = monthFromNow(-1);
    const days = daysIn(last);
    const on = (day: number) => `${last}-${String(day).padStart(2, "0")}`;
    const gone = randomUUID();
    const late = randomUUID();
    const rows: { orgId: string; day: string; seats: number; name: string }[] = [
      // A client that left after the first day, long since deleted: its
      // other days count as none.
      { orgId: gone, day: on(1), seats: 2, name: "Gone Clinic" },
    ];
    for (let day = 1; day <= days; day++) {
      // The server was down on the 15th: no reading for anyone.
      if (day === 15) {
        continue;
      }
      // Three seats, and a fourth added on the 10th; renamed that day.
      rows.push({
        orgId: dental,
        day: on(day),
        seats: day < 10 ? 3 : 4,
        name: day < 10 ? "Dental Old Name" : "History Dental",
      });
      // A client added on the 20th, since gone.
      if (day >= 20) {
        rows.push({ orgId: late, day: on(day), seats: 2, name: "Late Bakery" });
      }
    }
    await record(mspId, rows);

    const month = await seats(api, admin, mspId, last);
    expect(month.month).toBe(last);
    expect(month.thisMonth).toBe(false);
    expect(month.months).toEqual([thisMonth(), last]);
    expect(month.daysInMonth).toBe(days);
    expect(month.through).toBe(lastDay(last));
    // Nine days of 3, then 4 a day, the 15th counting the lower of the 14th
    // and 16th (both 4).
    const dentalDays = 9 * 3 + (days - 9) * 4;
    const lateDays = (days - 19) * 2;
    expect(month.clients).toEqual([
      { id: gone, name: "Gone Clinic", current: false, seatDays: 2, prorated: prorated(2, days), most: 2, today: null },
      // Its name on its last day that month.
      {
        id: dental,
        name: "History Dental",
        current: true,
        seatDays: dentalDays,
        prorated: prorated(dentalDays, days),
        most: 4,
        today: null,
      },
      {
        id: late,
        name: "Late Bakery",
        current: false,
        seatDays: lateDays,
        prorated: prorated(lateDays, days),
        most: 2,
        today: null,
      },
    ]);
    const total = 2 + dentalDays + lateDays;
    expect(month.totals).toEqual({ seatDays: total, prorated: prorated(total, days), most: 8, today: null });

    const csv = await request.get(`/api/keykeeper/msp/${mspId}/seats?month=${last}&format=csv`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect(csv.status()).toBe(200);
    expect(csv.headers()["content-disposition"]).toBe(`attachment; filename="seats-${last}.csv"`);
    const through = lastDay(last);
    expect((await csv.body()).toString("utf8")).toBe(
      "\uFEFFMonth,Through,Client,Seat-days,Days in month,Prorated seats,Peak,Today\r\n" +
        `${last},${through},Gone Clinic,2,${days},${proratedText(2, days)},2,\r\n` +
        `${last},${through},History Dental,${dentalDays},${days},${proratedText(dentalDays, days)},4,\r\n` +
        `${last},${through},Late Bakery,${lateDays},${days},${proratedText(lateDays, days)},2,\r\n` +
        `${last},${through},Total,${total},${days},${proratedText(total, days)},8,\r\n`,
    );

    // This month counts through today as it is now, over all of its days.
    const now = await seats(api, admin, mspId);
    const thisDays = daysIn(thisMonth());
    expect(now.clients).toEqual([
      {
        id: dental,
        name: "History Dental",
        current: true,
        seatDays: 1,
        prorated: prorated(1, thisDays),
        most: 1,
        today: 1,
      },
    ]);
  });

  test("months of 28, 29, 30, and 31 days: a seat added on the 20th of a 30-day month pays 11/30 of one", async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const api = new Api(request);
    const admin = await api.account("seats-days-admin");
    const mspId = await api.msp(admin, "Seats Days MSP");
    const dental = await api.client(admin, mspId, "Days Dental");
    const late = randomUUID();
    /** A client's readings on days `from` to `to` of `month`. */
    const days = (orgId: string, name: string, month: string, from: number, to: number, seats: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => ({
        orgId,
        day: `${month}-${String(from + i).padStart(2, "0")}`,
        seats,
        name,
      }));
    await record(mspId, [
      // September 2026, 30 days: ten seats, and an eleventh from the 20th.
      ...days(dental, "Days Dental", "2026-09", 1, 19, 10),
      ...days(dental, "Days Dental", "2026-09", 20, 30, 11),
      // December 2025, 31 days: five seats, one removed on the 16th.
      ...days(dental, "Days Dental", "2025-12", 1, 15, 5),
      ...days(dental, "Days Dental", "2025-12", 16, 31, 4),
      // February 2026, 28 days: two seats, and a client added on the 15th.
      ...days(dental, "Days Dental", "2026-02", 1, 28, 2),
      ...days(late, "Late Law", "2026-02", 15, 28, 3),
      // February 2024, a leap year: two seats, and a third from the 20th.
      ...days(dental, "Days Dental", "2024-02", 1, 19, 2),
      ...days(dental, "Days Dental", "2024-02", 20, 29, 3),
    ]);

    const month = async (m: string) => {
      const answer = await seats(api, admin, mspId, m);
      return {
        daysInMonth: answer.daysInMonth,
        through: answer.through,
        clients: (answer.clients as ClientSeats[]).map((c) => [c.name, c.seatDays, c.prorated, c.most]),
        totals: answer.totals,
      };
    };
    // 19 × 10 + 11 × 11 = 311 seat-days: ten seats and 11/30 of one.
    expect(await month("2026-09")).toEqual({
      daysInMonth: 30,
      through: "2026-09-30",
      clients: [["Days Dental", 311, 10.37, 11]],
      totals: { seatDays: 311, prorated: 10.37, most: 11, today: null },
    });
    // 15 × 5 + 16 × 4 = 139 seat-days over 31.
    expect(await month("2025-12")).toEqual({
      daysInMonth: 31,
      through: "2025-12-31",
      clients: [["Days Dental", 139, 4.48, 5]],
      totals: { seatDays: 139, prorated: 4.48, most: 5, today: null },
    });
    // 56 and 14 × 3 = 42 seat-days over 28.
    expect(await month("2026-02")).toEqual({
      daysInMonth: 28,
      through: "2026-02-28",
      clients: [
        ["Days Dental", 56, 2, 2],
        ["Late Law", 42, 1.5, 3],
      ],
      totals: { seatDays: 98, prorated: 3.5, most: 5, today: null },
    });
    // 19 × 2 + 10 × 3 = 68 seat-days over 29.
    expect(await month("2024-02")).toEqual({
      daysInMonth: 29,
      through: "2024-02-29",
      clients: [["Days Dental", 68, 2.34, 3]],
      totals: { seatDays: 68, prorated: 2.34, most: 3, today: null },
    });
    expect((await seats(api, admin, mspId)).months).toEqual([thisMonth(), "2026-09", "2026-02", "2025-12", "2024-02"]);

    const csv = await request.get(`/api/keykeeper/msp/${mspId}/seats?month=2026-09&format=csv`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect((await csv.body()).toString("utf8")).toBe(
      "\uFEFFMonth,Through,Client,Seat-days,Days in month,Prorated seats,Peak,Today\r\n" +
        "2026-09,2026-09-30,Days Dental,311,30,10.37,11,\r\n" +
        "2026-09,2026-09-30,Total,311,30,10.37,11,\r\n",
    );
  });
});
