// Seats by client (DESIGN.md, "Seats by client"): who counts as a seat (a
// client's member who joined, isn't revoked, and isn't the MSP's staff;
// someone in two clients counts in each), each client's most seats on any
// day and average over a month, today's, the CSV, and who may see them (MSP
// admins only; everyone else gets "not found", never 403, which would sign
// the web vault out). The daily record and earlier months run on a server of
// these tests' own, whose seats job runs every second and whose database the
// tests can write a past month into: the server's clock can't be moved.
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

type ClientSeats = {
  id: string;
  name: string;
  current: boolean;
  most: number;
  average: number;
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
  expect(month.month).toBe(thisMonth());
  expect(month.thisMonth).toBe(true);
  expect(month.months).toEqual([thisMonth()]);
  expect(month.days).toBe(1);
  expect(month.byName["Seats Dental"]).toEqual({
    id: dental,
    name: "Seats Dental",
    current: true,
    most: 3,
    average: 3,
    today: 3,
  });
  expect(month.byName["Seats Law"]).toEqual({
    id: law,
    name: "Seats Law",
    current: true,
    most: 1,
    average: 1,
    today: 1,
  });
  expect(month.totals).toEqual({ most: 4, average: 4, today: 4 });

  // Restored, they count again; removed from the staff, a technician whose
  // place was the client's own is a seat there.
  const restored = await api.call(admin, "PUT", `/api/organizations/${dental}/users/${danId}/restore`);
  expect(restored.status, JSON.stringify(restored.body)).toBe(200);
  const left = await api.call(admin, "DELETE", `/api/keykeeper/msp/${mspId}/staff/${joinedStaff.userId}`);
  expect(left.status, JSON.stringify(left.body)).toBe(200);
  const later = await seats(api, admin, mspId);
  expect(later.byName["Seats Dental"].today).toBe(5);
  expect(later.byName["Seats Law"].today).toBe(1);
  expect(later.totals.today).toBe(6);
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
  expect(old).toMatchObject({ month: "2001-01", thisMonth: false, days: 0, clients: [] });
  expect(old.totals).toEqual({ most: 0, average: 0, today: null });
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
  expect((await response.body()).toString("utf8")).toBe(
    "\uFEFFMonth,Client,Most on any day,Average,Today\r\n" +
      `${m},"'=HYPERLINK(""https://example.test"")",1,1.0,1\r\n` +
      `${m},"Smith, Jones & Co",2,2.0,2\r\n` +
      `${m},Total,3,3.0,3\r\n`,
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

    // The month still has it, by its name then, with no seats today.
    const month = await seats(api, admin, mspId);
    expect(month.byName["Seats Bakery"]).toEqual({
      id: bakery,
      name: "Seats Bakery",
      current: false,
      most: 2,
      average: 2,
      today: null,
    });
    expect(month.byName["Seats Clinic"]).toMatchObject({ current: true, most: 3, today: 3 });
    expect(month.totals).toEqual({ most: 5, average: 5, today: 3 });
    expect(await recorded(bakery)).toEqual([{ day: today(), seats: 2, org_name: "Seats Bakery" }]);
  });

  test("an earlier month: each client's most on any day and average over the days recorded, the months there are, and its CSV", async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const api = new Api(request);
    const admin = await api.account("seats-history-admin");
    const mspId = await api.msp(admin, "Seats History MSP");
    const dental = await api.client(admin, mspId, "History Dental");
    await api.addMember(admin, dental, await api.account("seats-history-a"), "user");
    const last = monthFromNow(-1);
    const gone = randomUUID();
    await record(mspId, [
      { orgId: dental, day: `${last}-01`, seats: 3, name: "Dental Old Name" },
      { orgId: dental, day: `${last}-02`, seats: 5, name: "Dental Old Name" },
      { orgId: dental, day: `${last}-03`, seats: 4, name: "History Dental" },
      // A client that left after the first day, long since deleted: its
      // other days count as none.
      { orgId: gone, day: `${last}-01`, seats: 2, name: "Gone Clinic" },
    ]);

    const month = await seats(api, admin, mspId, last);
    expect(month.month).toBe(last);
    expect(month.thisMonth).toBe(false);
    expect(month.months).toEqual([thisMonth(), last]);
    expect(month.days).toBe(3);
    expect(month.clients).toEqual([
      { id: gone, name: "Gone Clinic", current: false, most: 2, average: 0.7, today: null },
      // Its name on its last day that month.
      { id: dental, name: "History Dental", current: true, most: 5, average: 4, today: null },
    ]);
    expect(month.totals).toEqual({ most: 7, average: 4.7, today: null });

    const csv = await request.get(`/api/keykeeper/msp/${mspId}/seats?month=${last}&format=csv`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect(csv.status()).toBe(200);
    expect(csv.headers()["content-disposition"]).toBe(`attachment; filename="seats-${last}.csv"`);
    expect((await csv.body()).toString("utf8")).toBe(
      "\uFEFFMonth,Client,Most on any day,Average,Today\r\n" +
        `${last},Gone Clinic,2,0.7,\r\n` +
        `${last},History Dental,5,4.0,\r\n` +
        `${last},Total,7,4.7,\r\n`,
    );

    // This month counts today as it is now.
    const now = await seats(api, admin, mspId);
    expect(now.clients).toEqual([
      { id: dental, name: "History Dental", current: true, most: 1, average: 1, today: 1 },
    ]);
  });
});
