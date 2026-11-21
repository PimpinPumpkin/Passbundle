// Billing by the day, after each month (DESIGN.md, "Plans and billing",
// "Learning who has paid" and "Stripe, the first provider"; decisions 8, 9,
// and 10): an MSP's pool and a Business organization with no MSP put a card
// on file with Stripe's Checkout in setup mode, and after each month the
// server invoices it for the month's seat-days, prorated over the month's
// days, at the price of the tier the month's prorated seats fall in. Against
// stripe-standin.mjs, with a key, a signing secret, and a seat's prices made
// up for the run. Nothing here talks to Stripe.
//
// - The month's figures are the seat report's own, for the same readings.
// - One invoice for each plan and month, ever: the job runs every second
//   here, and a crash before or after Stripe is asked makes nothing twice.
// - A failed payment puts the pool in grace from that invoice's first failed
//   attempt, and paying ends it.
// - With PLANS_ENFORCED off, or no provider, nothing here exists or runs.
// - A server set up for billing by the day without a seat's prices doesn't start.
//
// The server's clock can't be moved, so the month invoiced is the one before
// this one, and its readings are written into the server's SQLite database,
// as tests/api/msp-seats.spec.ts writes past months.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type APIRequestContext, expect, test } from "@playwright/test";

import {
  invoicesNoProviderServerPort,
  invoicesOffServerPort,
  invoicesRefusedServerPort,
  invoicesServerPort,
  invoicesStandinPagesPort,
  invoicesStandinPort,
} from "../../paths.mjs";

import { type Account, Api, type Result } from "./support";

const e2eDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const DAY = 86_400_000;
const SECOND = 1000;

/** The version the adapter pins (passbundle-server, src/keykeeper_billing/stripe.rs, `VERSION`). */
const VERSION = "2026-10-28.endive";

const made = (prefix: string) => `${prefix}${randomBytes(18).toString("base64url")}`;
const API_KEY = made("rk_test_");
const SECRET = made("whsec_");
const PREMIUM = made("price_");
const FAMILIES = made("price_");
/** A seat's prices a month, as the site has them: the pool's three tiers, and Business's two. */
const MSP_PRICES = "1:1.50,500:1.25,2500:1.00";
const BUSINESS_PRICES = "1:2.00,250:1.75";

const standinBase = `http://127.0.0.1:${invoicesStandinPort}`;
const pagesBase = `https://127.0.0.1:${invoicesStandinPagesPort}`;

/** The month before this one (UTC), `YYYY-MM`: the month that has just ended, which the job invoices. */
function lastMonth(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

/** The days in a month (`YYYY-MM`). */
function daysIn(month: string): number {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number, 0)).getUTCDate();
}

const day = (month: string, d: number) => `${month}-${String(d).padStart(2, "0")}`;

/** A month's first and last seconds, as the invoice item's period. */
function period(month: string): { start: number; end: number } {
  const [year, number] = month.split("-").map(Number);
  return { start: Date.UTC(year, number - 1, 1) / SECOND, end: Date.UTC(year, number, 1) / SECOND - 1 };
}

/** `November 2026`. */
function inWords(month: string): string {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** The seat report's rounding: hundredths, half up. */
const hundredths = (seatDays: number, days: number) => Math.floor((200 * seatDays + days) / (2 * days));

async function result(response: { status(): number; text(): Promise<string> }): Promise<Result> {
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON; keep the text.
  }
  return { status: response.status(), body };
}

/** A request's answer, byte for byte. */
async function raw(api: APIRequestContext, as: Account | null, method: string, route: string, data?: unknown) {
  const response = await api.fetch(route, { method, data, headers: as ? { Authorization: `Bearer ${as.token}` } : {} });
  return { status: response.status(), text: await response.text() };
}

type Call = {
  method: string;
  path: string;
  query: Record<string, string>;
  form: Record<string, string>;
  version: string | null;
  bearer: boolean;
  contentType: string | null;
  idempotencyKey: string | null;
};

type Invoice = {
  id: string;
  status: string;
  customer: string;
  attempted: boolean;
  amount_due: number;
  total: number;
  metadata: Record<string, string>;
  status_transitions: { finalized_at: number | null };
  lines: { data: { amount: number; description: string; period: { start: number; end: number } }[] };
};

/** The stand-in, as a test drives it. */
class Stripe {
  constructor(private readonly http: APIRequestContext) {}

  private async control(method: "GET" | "POST", what: string, data?: unknown) {
    const answer = await this.http.fetch(`${standinBase}/control/${what}`, { method, data });
    expect(answer.status(), `stand-in ${what}: ${await answer.text()}`).toBe(200);
    return answer.json();
  }

  async calls(): Promise<Call[]> {
    return this.control("GET", "calls");
  }

  async callsFor(customer: string): Promise<Call[]> {
    return (await this.calls()).filter((c) => c.form.customer === customer || c.query.customer === customer || c.path.endsWith(`/${customer}`));
  }

  async customerOf(whose: string): Promise<{ id: string; invoice_settings: { default_payment_method: string | null } }> {
    const customers: { id: string; metadata: Record<string, string>; invoice_settings: { default_payment_method: string | null } }[] =
      await this.control("GET", "customers");
    const found = customers.filter((c) => c.metadata.whose === whose);
    expect(found.length, `one customer for ${whose}`).toBe(1);
    return found[0];
  }

  async invoicesOf(customer: string): Promise<Invoice[]> {
    return this.control("GET", `invoices?customer=${encodeURIComponent(customer)}`);
  }

  async itemsOf(customer: string): Promise<{ id: string; amount: number; invoice: string | null; metadata: Record<string, string> }[]> {
    return this.control("GET", `invoiceitems?customer=${encodeURIComponent(customer)}`);
  }

  async collect(invoice: string, fail = false): Promise<Invoice> {
    return this.control("POST", "collect", { invoice, fail });
  }

  async fail(method: string, path: string, when: "before" | "after", times: number, forget = false) {
    await this.control("POST", "fail", { method, path, when, times, forget });
  }

  async clearFailures() {
    await this.control("POST", "fail", { clear: true });
  }
}

type InvoicesServer = {
  port: string;
  process: ChildProcess;
  dataDir: string;
  log: string;
  admin: APIRequestContext;
  adminToken: string;
};

type ServerSetup = {
  enforced: boolean;
  provider?: string;
  /** A seat's prices, or null for none. */
  mspPrices?: string | null;
  businessPrices?: string | null;
  /** The month job's schedule, every second unless given. */
  invoices?: string;
};

/**
 * Where a server here keeps its log: with the run's other server logs when
 * the run keeps them (KK_SERVER_LOG; CI keeps that folder with a failed
 * run's report), one file for each port, so what the server said about a
 * webhook or a month can be read after a failure. Otherwise in its data
 * folder, which goes when the server stops. server.mjs adds "-restart" to
 * the name, as for every server that keeps its data.
 */
function serverLog(port: string, dataDir: string): string {
  const kept = process.env.KK_SERVER_LOG;
  return kept ? path.join(path.dirname(kept), `invoices-${port}.log`) : path.join(dataDir, "server.log");
}

function serverEnv(port: string, dataDir: string, setup: ServerSetup, adminToken: string) {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    KK_PORT: port,
    KK_DATA_DIR: dataDir,
    // A SQLite file in either job: the tests write last month's seats into it (database).
    KK_SQLITE: "1",
    KK_ADMIN_TOKEN: adminToken,
    KK_SERVER_LOG: serverLog(port, dataDir),
    KK_PLANS_ENFORCED: setup.enforced ? "1" : "",
    KK_BILLING_PROVIDER: setup.provider ?? "",
    KK_BILLING_API_BASE: standinBase,
    KK_BILLING_API_KEY: API_KEY,
    KK_BILLING_WEBHOOK_SECRET: SECRET,
    KK_BILLING_PRICE_PREMIUM: PREMIUM,
    KK_BILLING_PRICE_FAMILIES: FAMILIES,
    KK_BILLING_LOOK_SCHEDULE: "",
    // The seats job and the month job, every second.
    KK_SEATS_SCHEDULE: "* * * * * *",
    KK_BILLING_INVOICE_SCHEDULE: setup.invoices ?? "* * * * * *",
  };
  delete env.KK_BILLING_SEAT_PRICES_MSP;
  delete env.KK_BILLING_SEAT_PRICES_BUSINESS;
  if (setup.mspPrices !== null) env.KK_BILLING_SEAT_PRICES_MSP = setup.mspPrices ?? MSP_PRICES;
  if (setup.businessPrices !== null) env.KK_BILLING_SEAT_PRICES_BUSINESS = setup.businessPrices ?? BUSINESS_PRICES;
  return env;
}

type Playwright = { request: { newContext(options: object): Promise<APIRequestContext> } };

/** Starts a server of the test's own (on `dataDir`, to start one again after a crash), and signs the operator in. */
async function startServer(
  playwright: Playwright,
  port: string,
  setup: ServerSetup,
  again?: { dataDir: string; adminToken: string },
): Promise<InvoicesServer> {
  const adminToken = again?.adminToken ?? randomBytes(32).toString("base64url");
  const dataDir = again?.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-e2e-invoices-"));
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: e2eDir,
    env: serverEnv(port, dataDir, setup, adminToken),
    stdio: "ignore",
  });
  const admin = await playwright.request.newContext({ baseURL: `https://127.0.0.1:${port}`, ignoreHTTPSErrors: true });
  await expect
    .poll(async () => (await admin.get("/alive").catch(() => null))?.status() ?? 0, { timeout: 60_000 })
    .toBe(200);
  const signedIn = await admin.post("/admin", { form: { token: adminToken } });
  expect(signedIn.status(), "the operator's sign-in to the admin page").toBe(200);
  const log = serverLog(port, dataDir).replace(/(\.log)?$/, "-restart$1");
  return { port, process: child, dataDir, log, admin, adminToken };
}

/** Stops a server, as a crash would, keeping its data unless asked not to. */
async function stopServer(server: InvoicesServer | undefined, keep = false) {
  if (!server) {
    return;
  }
  await server.admin.dispose();
  const exited = new Promise((resolve) => server.process.once("exit", resolve));
  server.process.kill("SIGTERM");
  await exited;
  if (!keep) {
    fs.rmSync(server.dataDir, { recursive: true, force: true });
  }
}

/** How a server set up a way ends: its exit code, or null for one that starts. */
async function exitOf(port: string, setup: ServerSetup): Promise<number | null> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-e2e-invoices-refused-"));
  try {
    const child = spawn(process.execPath, ["server.mjs"], {
      cwd: e2eDir,
      env: serverEnv(port, dataDir, setup, randomBytes(32).toString("base64url")),
      stdio: "ignore",
    });
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    const alive = () =>
      new Promise<boolean>((resolve) => {
        https
          .get(`https://127.0.0.1:${port}/alive`, { rejectUnauthorized: false }, (response) => {
            response.resume();
            resolve(response.statusCode === 200);
          })
          .on("error", () => resolve(false));
      });
    let done = false;
    const started = (async () => {
      while (!done) {
        if (await alive()) {
          return "started" as const;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return "started" as const;
    })();
    const first = await Promise.race([exited, started]);
    done = true;
    if (first === "started") {
      child.kill("SIGTERM");
      await exited;
      return null;
    }
    return first;
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

/** Reads, and writes, a server's SQLite database. */
async function database(server: InvoicesServer) {
  const { DatabaseSync } = await import("node:sqlite");
  const file = path.join(server.dataDir, "db.sqlite3");
  const open = (readOnly: boolean) => {
    const db = new DatabaseSync(file, { readOnly });
    if (!readOnly) db.exec("PRAGMA busy_timeout = 5000");
    return db;
  };
  return {
    rows(sql: string, ...params: (string | number)[]): any[] {
      const db = open(true);
      try {
        return db.prepare(sql).all(...params);
      } finally {
        db.close();
      }
    },
    count(sql: string, ...params: (string | number)[]): number {
      const db = open(true);
      try {
        return Number(Object.values(db.prepare(sql).get(...params) ?? {})[0] ?? 0);
      } finally {
        db.close();
      }
    },
    /** A client's seats on each day of `month`, as the seats job records them, `seats(d)` for day d. */
    clientSeats(mspId: string, orgId: string, name: string, month: string, seats: (d: number) => number | null) {
      const db = open(false);
      try {
        const insert = db.prepare(
          "INSERT OR REPLACE INTO msp_client_seats (msp_uuid, org_uuid, day, seats, org_name) VALUES (?, ?, ?, ?, ?)",
        );
        // All at once, so the invoices job never reads half a month.
        db.exec("BEGIN IMMEDIATE");
        for (let d = 1; d <= daysIn(month); d++) {
          const n = seats(d);
          if (n !== null) insert.run(mspId, orgId, day(month, d), n, name);
        }
        db.exec("COMMIT");
      } finally {
        db.close();
      }
    },
    /** An organization's own seats on each day of `month`. */
    orgSeats(orgId: string, month: string, seats: (d: number) => number | null) {
      const db = open(false);
      try {
        const insert = db.prepare("INSERT OR REPLACE INTO org_seats (org_uuid, day, seats) VALUES (?, ?, ?)");
        db.exec("BEGIN IMMEDIATE");
        for (let d = 1; d <= daysIn(month); d++) {
          const n = seats(d);
          if (n !== null) insert.run(orgId, day(month, d), n);
        }
        db.exec("COMMIT");
      } finally {
        db.close();
      }
    },
  };
}

/** The caller's plan of an organization or an MSP, as `GET /api/keykeeper/plan` answers it. */
async function planOf(api: Api, as: Account, query: string): Promise<any> {
  const answer = await api.call(as, "GET", `/api/keykeeper/plan${query}`);
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body;
}

/** Opens a page of the stand-in's that the server handed out, and presses its one button. */
async function press(browser: APIRequestContext, url: string): Promise<{ html: string; location: string }> {
  const opened = await browser.get(url);
  expect(opened.status(), url).toBe(200);
  const html = await opened.text();
  const action = html.match(/<form method="post" action="([^"]+)">/)![1].replaceAll("&amp;", "&");
  const pressed = await browser.post(new URL(action, url).toString(), { maxRedirects: 0 });
  expect(pressed.status(), `pressing the button on ${url}`).toBe(303);
  return { html, location: pressed.headers().location };
}

let standinProcess: ChildProcess | undefined;
let stripe: Stripe;
let standinHttp: APIRequestContext;
let browser: APIRequestContext;

test.beforeAll(async ({ playwright }) => {
  standinProcess = spawn(process.execPath, ["stripe-standin.mjs"], {
    cwd: e2eDir,
    env: {
      ...process.env,
      KK_STRIPE_STANDIN_PORT: invoicesStandinPort,
      KK_STRIPE_STANDIN_PAGES_PORT: invoicesStandinPagesPort,
      KK_STRIPE_API_KEY: API_KEY,
      KK_STRIPE_WEBHOOK_SECRETS: SECRET,
      KK_STRIPE_VERSION: VERSION,
      KK_STRIPE_PRICES: [PREMIUM, FAMILIES].join(","),
    },
    stdio: "ignore",
  });
  standinHttp = await playwright.request.newContext();
  browser = await playwright.request.newContext({ ignoreHTTPSErrors: true });
  await expect
    .poll(async () => (await standinHttp.get(`${standinBase}/alive`).catch(() => null))?.status() ?? 0, { timeout: 30_000 })
    .toBe(200);
  stripe = new Stripe(standinHttp);
});

test.afterAll(async () => {
  await browser?.dispose();
  await standinHttp?.dispose();
  if (standinProcess) {
    const exited = new Promise((resolve) => standinProcess!.once("exit", resolve));
    standinProcess.kill("SIGTERM");
    await exited;
  }
});

test.describe("where plans are enforced, Stripe is the payment provider, and billing by the day is on", () => {
  test.use({ baseURL: `https://127.0.0.1:${invoicesServerPort}` });

  let server: InvoicesServer | undefined;
  const vault = `https://127.0.0.1:${invoicesServerPort}/#`;

  test.beforeAll(async ({ playwright }) => {
    server = await startServer(playwright, invoicesServerPort, { enforced: true, provider: "stripe" });
  });

  test.afterAll(async () => {
    await stopServer(server);
  });

  /** The operator gives the pool or the organization a plan billed by the day with no free days (or free until `freeUntil`). */
  async function billedByTheDay(kind: "msps" | "organizations", id: string, plan: "msp" | "business", freeUntil?: string) {
    const set = await server!.admin.post(`/admin/plans/${kind}/${id}`, {
      data: {
        plan,
        standing: "none",
        renews: false,
        billed: "by_the_day",
        ...(freeUntil ? { freeUntil, freeWhy: "offer" } : {}),
      },
    });
    expect(set.status(), await set.text()).toBe(200);
  }

  /** Adds a card on Stripe's page, and waits for the plan to say it's on file. */
  async function addCard(api: Api, as: Account, query: string, body: object) {
    const asked = await api.call(as, "POST", "/api/keykeeper/plan/pay", body);
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    expect(asked.body.url).toMatch(new RegExp(`^${pagesBase}/c/pay/cs_test_`));
    const page = await press(browser, asked.body.url);
    await expect.poll(async () => (await planOf(api, as, query)).state, { timeout: 30_000 }).toBe("active");
    return page;
  }

  /** An MSP whose pool has a card on file and no free days, with one client. */
  async function pool(api: Api, prefix: string) {
    const admin = await api.account(prefix);
    const mspId = await api.msp(admin, `${prefix} MSP`);
    const clientId = await api.client(admin, mspId, `${prefix} Client`);
    await billedByTheDay("msps", mspId, "msp");
    await addCard(api, admin, `?msp=${mspId}`, { msp: mspId, plan: "msp" });
    const customer = (await stripe.customerOf(`msp_${mspId}`)).id;
    return { admin, mspId, clientId, customer };
  }

  /** The plan's invoices, as the Plan page lists them. */
  async function invoicesOf(api: Api, as: Account, query: string): Promise<any[]> {
    const answer = await api.call(as, "GET", `/api/keykeeper/plan/invoices${query}`);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return answer.body.invoices;
  }

  test("an MSP's pool adds a card on Stripe's Checkout in setup mode, which charges nothing and becomes the card invoices are charged to", async ({
    request,
  }) => {
    const api = new Api(request);
    const admin = await api.account("invoices-card");
    const mspId = await api.msp(admin, "Invoices Card MSP");
    // A new MSP's pool gets the same 30-day trial as a Business organization (decision 10).
    const trial = await planOf(api, admin, `?msp=${mspId}`);
    expect(trial).toMatchObject({ plan: "msp", state: "trial", freeWhy: "trial", canManage: true, canPay: true });
    expect(new Date(trial.freeUntil).getTime() - Date.now()).toBeGreaterThan(29 * DAY);

    const before = (await stripe.calls()).length;
    const asked = await api.call(admin, "POST", "/api/keykeeper/plan/pay", { msp: mspId, plan: "msp" });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    const whose = `msp_${mspId}`;
    const calls = (await stripe.calls()).slice(before);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /v1/customers", "POST /v1/checkout/sessions"]);
    const customer = (await stripe.customerOf(whose)).id;
    expect(calls[1]).toMatchObject({ bearer: true, version: VERSION, contentType: "application/x-www-form-urlencoded" });
    expect(calls[1].form).toEqual({
      mode: "setup",
      currency: "usd",
      customer,
      client_reference_id: whose,
      "metadata[whose]": whose,
      "metadata[plan]": "msp",
      "setup_intent_data[metadata][whose]": whose,
      "setup_intent_data[metadata][plan]": "msp",
      success_url: `${vault}/msp`,
      cancel_url: `${vault}/msp`,
    });

    // Saving the card comes back to the MSP console, and Stripe's webhook makes the server look.
    const saved = await press(browser, asked.body.url);
    expect(saved.html).toContain("Nothing is charged now.");
    expect(saved.location).toBe(`${vault}/msp`);
    await expect.poll(async () => (await planOf(api, admin, `?msp=${mspId}`)).state).toBe("active");
    const plan = await planOf(api, admin, `?msp=${mspId}`);
    // Good with no end, and the trial's days stay free.
    expect(plan).toMatchObject({ plan: "msp", state: "active", until: null, endsAt: null, renews: true, freeUntil: trial.freeUntil });
    // The card is now the customer's default for invoices.
    const card = (await stripe.customerOf(whose)).invoice_settings.default_payment_method;
    expect(card).toMatch(/^pm_/);
    const look = (await stripe.calls()).slice(before + 2).map((c) => `${c.method} ${c.path}`);
    expect(look).toEqual(
      expect.arrayContaining([
        "GET /v1/subscriptions",
        "GET /v1/checkout/sessions",
        `GET /v1/customers/${customer}`,
        `POST /v1/customers/${customer}`,
        "GET /v1/invoices",
      ]),
    );
    const sessions = (await stripe.calls()).find((c) => c.method === "GET" && c.path === "/v1/checkout/sessions" && c.query.customer === customer)!;
    expect(sessions.query).toMatchObject({ status: "complete", limit: "100", "expand[]": "data.setup_intent.payment_method" });
    const setDefault = (await stripe.calls()).filter((c) => c.method === "POST" && c.path === `/v1/customers/${customer}`);
    expect(setDefault.map((c) => c.form)).toEqual([{ "invoice_settings[default_payment_method]": card }]);
    const row = await result(await server!.admin.get(`/admin/plans/msps/${mspId}`));
    expect(row.body.plan).toMatchObject({ plan: "msp", standing: "open", billed: "by_the_day", setBy: "provider", provider: "stripe", providerCustomer: customer });

    // A card on file: asking again is the portal, never a second setup.
    const setups = (await stripe.calls()).filter((c) => c.path === "/v1/checkout/sessions" && c.method === "POST").length;
    const again = await api.call(admin, "POST", "/api/keykeeper/plan/pay", { msp: mspId, plan: "msp" });
    expect(again.body.url).toMatch(new RegExp(`^${pagesBase}/p/session/`));
    expect((await stripe.calls()).filter((c) => c.path === "/v1/checkout/sessions" && c.method === "POST").length).toBe(setups);
    // Nothing billed yet.
    expect(await invoicesOf(api, admin, `?msp=${mspId}`)).toEqual([]);
    expect(await stripe.invoicesOf(customer)).toEqual([]);
  });

  test("a month is invoiced once, with the seat report's figures at the price of the tier its prorated seats fall in, and paid", async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const api = new Api(request);
    const { admin, mspId, clientId, customer } = await pool(api, "invoices-month");
    const month = lastMonth();
    const days = daysIn(month);
    // 499 seats, and a 500th from the 20th: between 499 and 500 prorated seats,
    // which round up to 500, so every one is billed at the second tier's $1.25.
    const db = await database(server!);
    db.clientSeats(mspId, clientId, "Invoices Month Client", month, (d) => (d < 20 ? 499 : 500));
    const seatDays = 19 * 499 + (days - 19) * 500;
    const prorated = hundredths(seatDays, days);
    expect(prorated).toBeGreaterThan(49_900);
    expect(prorated).toBeLessThan(50_000);
    const amount = Math.floor((prorated * 125 + 50) / 100);

    // The seat report says the same of the same month.
    const report = await api.call(admin, "GET", `/api/keykeeper/msp/${mspId}/seats?month=${month}`);
    expect(report.status).toBe(200);
    expect(report.body.totals).toMatchObject({ seatDays, prorated: prorated / 100 });

    await expect.poll(async () => (await invoicesOf(api, admin, `?msp=${mspId}`))[0]?.state, { timeout: 30_000 }).toBe("invoiced");
    const [listed] = await invoicesOf(api, admin, `?msp=${mspId}`);
    expect(listed).toMatchObject({
      month,
      seatDays,
      freeDays: 0,
      daysInMonth: days,
      prorated: prorated / 100,
      priceCents: 125,
      amountCents: amount,
      currency: "usd",
      state: "invoiced",
    });

    // One invoice item, then one invoice that takes it, each sent once with its key.
    const key = `passbundle-invoice-msp-${mspId}-${month}`;
    const calls = await stripe.callsFor(customer);
    const items = calls.filter((c) => c.method === "POST" && c.path === "/v1/invoiceitems");
    const made = calls.filter((c) => c.method === "POST" && c.path === "/v1/invoices");
    expect(items.length).toBe(1);
    expect(made.length).toBe(1);
    const description = `MSP seat pool, ${inWords(month)}: ${seatDays} seat-days over the month's ${days} days, ${(prorated / 100).toFixed(2)} seats at $1.25 a seat`;
    expect(items[0]).toMatchObject({ bearer: true, version: VERSION, idempotencyKey: `${key}-item` });
    expect(items[0].form).toEqual({
      customer,
      amount: String(amount),
      currency: "usd",
      description,
      "period[start]": String(period(month).start),
      "period[end]": String(period(month).end),
      "metadata[invoice]": key,
      "metadata[month]": month,
    });
    expect(made[0]).toMatchObject({ idempotencyKey: `${key}-invoice` });
    expect(made[0].form).toEqual({
      customer,
      collection_method: "charge_automatically",
      auto_advance: "true",
      pending_invoice_items_behavior: "include",
      "metadata[invoice]": key,
      "metadata[month]": month,
    });
    // Before making either, the server looked for one made with the key.
    const order = calls.map((c) => `${c.method} ${c.path}`);
    const first = order.indexOf("POST /v1/invoiceitems");
    expect(order.slice(first - 2, first + 2)).toEqual(["GET /v1/invoices", "GET /v1/invoiceitems", "POST /v1/invoiceitems", "POST /v1/invoices"]);
    const [invoice] = await stripe.invoicesOf(customer);
    expect(invoice).toMatchObject({ status: "draft", total: amount, metadata: { invoice: key, month } });
    expect(invoice.lines.data).toEqual([expect.objectContaining({ amount, description, period: period(month) })]);

    // Stripe collects it from the card on file: paid, and the pool stays as it was.
    await stripe.collect(invoice.id);
    await expect.poll(async () => (await stripe.callsFor(customer)).filter((c) => c.path === "/v1/invoices" && c.method === "GET").length).toBeGreaterThan(2);
    expect(await planOf(api, admin, `?msp=${mspId}`)).toMatchObject({ state: "active", until: null });

    // The job keeps running every second, and makes nothing more.
    await new Promise((resolve) => setTimeout(resolve, 3 * SECOND));
    expect((await stripe.itemsOf(customer)).length).toBe(1);
    expect((await stripe.invoicesOf(customer)).length).toBe(1);
    expect(db.count("SELECT COUNT(*) FROM plan_invoices WHERE msp_uuid = ?", mspId)).toBe(1);
  });

  test("a failed payment puts the pool in grace from the invoice's first failed attempt, and paying ends it", async ({ request }) => {
    test.setTimeout(120_000);
    const api = new Api(request);
    const { admin, mspId, clientId, customer } = await pool(api, "invoices-failed");
    (await database(server!)).clientSeats(mspId, clientId, "Invoices Failed Client", lastMonth(), () => 3);
    await expect.poll(async () => (await stripe.invoicesOf(customer)).length, { timeout: 30_000 }).toBe(1);
    const [invoice] = await stripe.invoicesOf(customer);

    // The card is declined: the invoice stays open, and Stripe retries it.
    const failed = await stripe.collect(invoice.id, true);
    expect(failed).toMatchObject({ status: "open", attempted: true });
    await expect.poll(async () => (await planOf(api, admin, `?msp=${mspId}`)).state).toBe("paymentDue");
    const due = await planOf(api, admin, `?msp=${mspId}`);
    const firstFailed = failed.status_transitions.finalized_at! * SECOND;
    expect(new Date(due.until).getTime()).toBe(firstFailed);
    expect(new Date(due.endsAt).getTime()).toBe(firstFailed + 14 * DAY);
    expect(due.renews).toBe(true);
    // The clients keep everything through grace.
    const client = (await api.call(admin, "GET", "/api/sync?excludeDomains=true")).body.profile.organizations.find(
      (o: { id: string }) => o.id === clientId,
    );
    expect(client).toMatchObject({ usersGetPremium: true, enabled: true });
    // In grace, the button is the portal, to fix the card.
    const pay = await api.call(admin, "POST", "/api/keykeeper/plan/pay", { msp: mspId, plan: "msp" });
    expect(pay.body.url).toMatch(new RegExp(`^${pagesBase}/p/session/`));

    // A retry goes through: good with no end again.
    await stripe.collect(invoice.id);
    await expect.poll(async () => (await planOf(api, admin, `?msp=${mspId}`)).state).toBe("active");
    expect(await planOf(api, admin, `?msp=${mspId}`)).toMatchObject({ until: null, endsAt: null });
  });

  test("the server stopping before Stripe is asked: the month is written down, and once it's back it's sent as written, once", async ({
    playwright,
    request,
  }) => {
    test.setTimeout(180_000);
    let api = new Api(request);
    const { admin, mspId, clientId, customer } = await pool(api, "invoices-crash-before");
    // Stripe can't take the invoice item.
    await stripe.fail("POST", "/v1/invoiceitems", "before", 1000);
    const db = await database(server!);
    db.clientSeats(mspId, clientId, "Invoices Crash Client", lastMonth(), () => 7);
    await expect
      .poll(() => db.count("SELECT COUNT(*) FROM plan_invoices WHERE msp_uuid = ? AND provider_invoice IS NULL", mspId), { timeout: 30_000 })
      .toBe(1);
    const [written] = db.rows("SELECT amount_cents, seat_days FROM plan_invoices WHERE msp_uuid = ?", mspId);
    expect(written.seat_days).toBe(7 * daysIn(lastMonth()));
    expect((await api.call(admin, "GET", `/api/keykeeper/plan/invoices?msp=${mspId}`)).body.invoices).toEqual([
      expect.objectContaining({ month: lastMonth(), state: "pending", amountCents: written.amount_cents }),
    ]);
    expect(await stripe.itemsOf(customer)).toEqual([]);

    // The server stops; the readings change while it's down; it starts again with Stripe working.
    const { dataDir, adminToken } = server!;
    await stopServer(server, true);
    db.clientSeats(mspId, clientId, "Invoices Crash Client", lastMonth(), () => 70);
    await stripe.clearFailures();
    server = await startServer(playwright, invoicesServerPort, { enforced: true, provider: "stripe" }, { dataDir, adminToken });
    const context = await playwright.request.newContext({ baseURL: `https://127.0.0.1:${invoicesServerPort}`, ignoreHTTPSErrors: true });
    try {
      api = new Api(context);
      await expect.poll(async () => (await stripe.invoicesOf(customer)).length, { timeout: 30_000 }).toBe(1);
      const items = await stripe.itemsOf(customer);
      // The figures written before the stop, not the readings since.
      expect(items.map((i) => i.amount)).toEqual([written.amount_cents]);
      const [invoice] = await stripe.invoicesOf(customer);
      expect(items[0].invoice).toBe(invoice.id);
      await expect
        .poll(() => db.count("SELECT COUNT(*) FROM plan_invoices WHERE msp_uuid = ? AND provider_invoice = ?", mspId, invoice.id))
        .toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 3 * SECOND));
      expect((await stripe.itemsOf(customer)).length).toBe(1);
      expect((await stripe.invoicesOf(customer)).length).toBe(1);
    } finally {
      await context.dispose();
    }
  });

  test("Stripe's answers lost after it made the invoice item and the invoice, and its keys forgotten: the server finds what it made, and makes nothing twice", async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const api = new Api(request);
    const { mspId, clientId, customer } = await pool(api, "invoices-crash-after");
    // Each is made, its answer lost, and Stripe's idempotency keys forgotten, as a day passing does.
    await stripe.fail("POST", "/v1/invoiceitems", "after", 1, true);
    await stripe.fail("POST", "/v1/invoices", "after", 1, true);
    const db = await database(server!);
    db.clientSeats(mspId, clientId, "Invoices After Client", lastMonth(), () => 2);
    await expect
      .poll(() => db.count("SELECT COUNT(*) FROM plan_invoices WHERE msp_uuid = ? AND provider_invoice IS NOT NULL", mspId), {
        timeout: 30_000,
      })
      .toBe(1);
    const items = await stripe.itemsOf(customer);
    const invoices = await stripe.invoicesOf(customer);
    expect(items.length).toBe(1);
    expect(invoices.length).toBe(1);
    expect(items[0].invoice).toBe(invoices[0].id);
    const [row] = db.rows("SELECT provider_invoice FROM plan_invoices WHERE msp_uuid = ?", mspId);
    expect(row.provider_invoice).toBe(invoices[0].id);
    // Each was asked for once, its answer lost, and found after by the key it was made with.
    const calls = await stripe.callsFor(customer);
    expect(calls.filter((c) => c.method === "POST" && c.path === "/v1/invoiceitems").length).toBe(1);
    expect(calls.filter((c) => c.method === "POST" && c.path === "/v1/invoices").length).toBe(1);
    expect(calls.filter((c) => c.method === "GET" && c.path === "/v1/invoiceitems").length).toBeGreaterThanOrEqual(2);
  });

  test("a Business organization with no MSP is billed the same way: a card from its Plan page, its own readings each day, and the month after its free days", async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const api = new Api(request);
    const owner = await api.account("invoices-business");
    const orgId = await api.organization(owner, "Invoices Business Org");
    // Its trial is unchanged: 30 days, no card asked.
    expect(await planOf(api, owner, `?organization=${orgId}`)).toMatchObject({ plan: "business", state: "trial", canPay: true });
    // The daily reading of an organization with no MSP: its people who joined.
    const db = await database(server!);
    const today = new Date().toISOString().slice(0, 10);
    await expect.poll(() => db.count("SELECT seats FROM org_seats WHERE org_uuid = ? AND day = ?", orgId, today), { timeout: 30_000 }).toBe(1);

    // Free until the 10th of last month, then billed by the day.
    const month = lastMonth();
    await billedByTheDay("organizations", orgId, "business", `${day(month, 10)}T00:00:00Z`);
    const page = await addCard(api, owner, `?organization=${orgId}`, { organization: orgId, plan: "business" });
    expect(page.location).toBe(`${vault}/organizations/${orgId}/plan`);
    const whose = `organization_${orgId}`;
    const customer = (await stripe.customerOf(whose)).id;
    const setup = (await stripe.callsFor(customer)).find((c) => c.method === "POST" && c.path === "/v1/checkout/sessions")!;
    expect(setup.form).toMatchObject({ mode: "setup", currency: "usd", "metadata[plan]": "business", "metadata[whose]": whose });

    // 12 people every day: the 1st to the 9th are free.
    db.orgSeats(orgId, month, () => 12);
    const days = daysIn(month);
    const seatDays = 12 * (days - 9);
    const prorated = hundredths(seatDays, days);
    const amount = Math.floor((prorated * 200 + 50) / 100);
    await expect.poll(async () => (await api.call(owner, "GET", `/api/keykeeper/plan/invoices?organization=${orgId}`)).body.invoices[0]?.state, { timeout: 30_000 }).toBe("invoiced");
    const [listed] = (await api.call(owner, "GET", `/api/keykeeper/plan/invoices?organization=${orgId}`)).body.invoices;
    expect(listed).toMatchObject({ month, seatDays, freeDays: 9, daysInMonth: days, prorated: prorated / 100, priceCents: 200, amountCents: amount });
    const [item] = await stripe.itemsOf(customer);
    expect(item.amount).toBe(amount);
    const [invoice] = await stripe.invoicesOf(customer);
    expect(invoice.lines.data[0].description).toBe(
      `Business, ${inWords(month)}: ${seatDays} seat-days over the month's ${days} days (its first 9 days free), ${(prorated / 100).toFixed(2)} seats at $2.00 a seat`,
    );
  });

  test("the invoices are for whoever may pay for the plan, and 404 for everyone else", async ({ request }) => {
    const api = new Api(request);
    const admin = await api.account("invoices-who");
    const mspId = await api.msp(admin, "Invoices Who MSP");
    const technician = await api.account("invoices-who-tech");
    await api.addStaff(admin, mspId, technician, "technician");
    const clientId = await api.client(admin, mspId, "Invoices Who Client");
    const other = await api.account("invoices-who-other");
    const otherMsp = await api.msp(other, "Invoices Who Other MSP");
    const owner = await api.account("invoices-who-owner");
    const orgId = await api.organization(owner, "Invoices Who Org");
    const member = await api.account("invoices-who-member");
    await api.addMember(owner, orgId, member, "admin");
    const stranger = await api.account("invoices-who-stranger");

    const notFound = (await api.call(stranger, "GET", `/api/keykeeper/plan/invoices?msp=${mspId}`)).body;
    for (const [who, query, status] of [
      [admin, `?msp=${mspId}`, 200],
      [technician, `?msp=${mspId}`, 404],
      [other, `?msp=${mspId}`, 404],
      [owner, `?msp=${mspId}`, 404],
      [stranger, `?msp=${mspId}`, 404],
      [null, `?msp=${mspId}`, 401],
      [owner, `?organization=${orgId}`, 200],
      [member, `?organization=${orgId}`, 404],
      [admin, `?organization=${orgId}`, 404],
      [stranger, `?organization=${orgId}`, 404],
      [null, `?organization=${orgId}`, 401],
      // A client's plan is its MSP's: nobody pays for it on its own.
      [admin, `?organization=${clientId}`, 404],
      [other, `?msp=${otherMsp}`, 200],
    ] as [Account | null, string, number][]) {
      const answer = await api.call(who, "GET", `/api/keykeeper/plan/invoices${query}`);
      expect(answer.status, `${who?.email ?? "nobody"} ${query}`).toBe(status);
      if (status === 200) expect(answer.body).toEqual({ invoices: [] });
      if (status === 404) expect(answer.body).toEqual(notFound);
    }
  });
});

for (const [title, port, setup] of [
  ["where Stripe and billing by the day are set and plans aren't enforced", invoicesOffServerPort, { enforced: false, provider: "stripe" }],
  ["where plans are enforced and no payment provider is set", invoicesNoProviderServerPort, { enforced: true }],
] as [string, string, ServerSetup][]) {
  test.describe(title, () => {
    test.use({ baseURL: `https://127.0.0.1:${port}` });

    let server: InvoicesServer | undefined;

    test.beforeAll(async ({ playwright }) => {
      server = await startServer(playwright, port, setup);
    });

    test.afterAll(async () => {
      await stopServer(server);
    });

    test("no route, no organization's readings, no invoice, and nothing asked of Stripe, while the seat report goes on as it always has", async ({
      request,
    }) => {
      test.setTimeout(60_000);
      const api = new Api(request);
      const before = (await stripe.calls()).length;
      const admin = await api.account("invoices-unset");
      const mspId = await api.msp(admin, "Invoices Unset MSP");
      const clientId = await api.client(admin, mspId, "Invoices Unset Client");
      const owner = await api.account("invoices-unset-owner");
      const orgId = await api.organization(owner, "Invoices Unset Org");
      const db = await database(server!);
      db.clientSeats(mspId, clientId, "Invoices Unset Client", lastMonth(), () => 5);
      db.orgSeats(orgId, lastMonth(), () => 5);
      // The seats job, every second, reads the MSP's clients as it always has.
      const today = new Date().toISOString().slice(0, 10);
      await expect.poll(() => db.count("SELECT COUNT(*) FROM msp_client_seats WHERE msp_uuid = ? AND day = ?", mspId, today), { timeout: 30_000 }).toBe(1);
      // And the month job, every second too, does nothing.
      await new Promise((resolve) => setTimeout(resolve, 3 * SECOND));
      expect(db.count("SELECT COUNT(*) FROM org_seats WHERE day = ?", today)).toBe(0);
      expect(db.count("SELECT COUNT(*) FROM plan_invoices")).toBe(0);

      // The routes are the 404 of a path this server doesn't have.
      const nowhere = await raw(request, admin, "GET", `/api/keykeeper/no-such-route-${randomUUID()}`);
      expect(nowhere.status).toBe(404);
      for (const query of [`?msp=${mspId}`, `?organization=${orgId}`, ""]) {
        expect(await raw(request, admin, "GET", `/api/keykeeper/plan/invoices${query}`), query).toEqual(nowhere);
      }
      const posted = await raw(request, admin, "POST", `/api/keykeeper/no-such-route-${randomUUID()}`);
      expect(await raw(request, admin, "POST", "/api/keykeeper/plan/pay", { msp: mspId, plan: "msp" })).toEqual(posted);
      const plan = await api.call(admin, "GET", `/api/keykeeper/plan?msp=${mspId}`);
      if (setup.enforced) {
        expect(plan.body).toMatchObject({ plan: "msp", state: "trial", canPay: false });
      } else {
        expect(plan).toEqual({ status: 200, body: { enforced: false } });
      }
      expect((await stripe.calls()).slice(before)).toEqual([]);
    });
  });
}

test.describe("a server set up for billing by the day wrong", () => {
  test("doesn't start: Stripe, or the stand-in, without a seat's prices, or with prices that don't read", async () => {
    test.setTimeout(240_000);
    for (const [what, setup] of [
      ["no prices for the pool", { enforced: true, provider: "stripe", mspPrices: null }],
      ["no prices for Business", { enforced: true, provider: "stripe", businessPrices: null }],
      ["a pool's first tier from 2 seats", { enforced: true, provider: "stripe", mspPrices: "2:1.50,500:1.25" }],
      ["tiers out of order", { enforced: true, provider: "stripe", mspPrices: "1:1.50,500:1.25,400:1.00" }],
      ["a price that isn't dollars and cents", { enforced: true, provider: "stripe", businessPrices: "1:2.005" }],
      ["a schedule that isn't one", { enforced: true, provider: "stripe", invoices: "every month" }],
    ] as [string, ServerSetup][]) {
      expect(await exitOf(invoicesRefusedServerPort, setup), what).not.toBeNull();
    }
    // Set right, it starts; and with billing by the day off, it needs no prices.
    expect(await exitOf(invoicesRefusedServerPort, { enforced: true, provider: "stripe" })).toBeNull();
    expect(await exitOf(invoicesRefusedServerPort, { enforced: true, provider: "stripe", mspPrices: null, businessPrices: null, invoices: "" })).toBeNull();
  });
});
