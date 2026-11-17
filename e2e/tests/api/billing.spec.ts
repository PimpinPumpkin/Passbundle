// Learning who has paid (DESIGN.md, "Plans and billing", "Learning who has
// paid" and "Self-hosted servers"): the boundary to a payment provider, its
// webhook route and the checks there, looking again, and the routes that send
// someone to the provider's pages. Against billing-standin.mjs, a stand-in
// provider with secrets made up for the run: no real provider is involved.
//
// - A provider (BILLING_PROVIDER) is a second switch that does nothing unless
//   PLANS_ENFORCED is on. Without both, none of these routes exists and
//   nothing is asked of anyone.
// - A webhook is checked before anything in it is believed: the route is the
//   provider's, the body is at most 1 MiB, the signature is good with a
//   secret in use (two while one is replaced), its timestamp is within five
//   minutes, its id is new, and it's for the provider's mode. A refusal is an
//   empty 400. Then it only causes a look: the server asks the provider and
//   writes that answer, never what the webhook says.
// - The provider is asked again: when someone who manages the plan asks (at
//   most once a minute), when the plan's paid-through date passes, once a
//   day, and after a webhook whose look got no answer. A plan never ends on
//   a guess: when the provider can't be asked, the last answer stands.
// - Paying, managing, and looking are for whoever may pay for the plan, which
//   is what the sync's `canPay` says, and 404 for everyone else.
//
// The servers keep their data in SQLite, which the tests read to see what's
// kept, and write to make a plan's last answer older, since the server's clock
// can't be moved.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type APIRequestContext, expect, test } from "@playwright/test";

import { SIGNATURE_HEADER, signatureHeader } from "../../billing-standin.mjs";
import {
  billingNoProviderServerPort,
  billingOffServerPort,
  billingRefusedServerPort,
  billingReplaceServerPort,
  billingServerPort,
  billingStandinPagesPort,
  billingStandinPort,
} from "../../paths.mjs";

import { type Account, Api, type Result } from "./support";

const e2eDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const DAY = 86_400_000;
const MIB = 1024 * 1024;

/** The run's secrets, made up here and kept in memory only. */
const made = (prefix: string) => `${prefix}${randomBytes(18).toString("base64url")}`;
const API_KEY = made("sk_test_");
const SECRET = made("whsec_");
const OLD_SECRET = made("whsec_");
const NOT_OURS = made("whsec_");

const standinBase = `http://127.0.0.1:${billingStandinPort}`;
/** Where the stand-in's pages are, over HTTPS, as a provider's are. */
const pagesBase = `https://127.0.0.1:${billingStandinPagesPort}`;
const UNREACHABLE = "The payment provider can't be reached right now. Try again in a few minutes.";
const NOTHING_TO_MANAGE = "Nothing has been paid for this plan yet, so there's nothing to manage.";

/** A moment this far from now, to the second. */
const fromNow = (ms: number) => new Date(Math.floor((Date.now() + ms) / 1000) * 1000).toISOString();
/** A date the server sent or took, as a number. */
const moment = (date: string | null) => (date === null ? null : new Date(date).getTime());

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

/** The stand-in, as a test drives it. */
class Standin {
  constructor(private readonly http: APIRequestContext) {}

  private async control(method: "GET" | "POST", what: string, data?: unknown) {
    const answer = await this.http.fetch(`${standinBase}/control/${what}`, { method, data });
    expect(answer.status(), `stand-in ${what}`).toBe(200);
    return answer.json();
  }

  /** The customer the server was given for an owner (`user:<id>` and the like). */
  async customerOf(whose: string): Promise<string> {
    const customers: { id: string; whose: string }[] = await this.control("GET", "customers");
    const found = customers.filter((c) => c.whose === whose);
    expect(found.length, `one customer for ${whose}`).toBe(1);
    return found[0].id;
  }

  async customers(): Promise<{ id: string; whose: string; plan: string }[]> {
    return this.control("GET", "customers");
  }

  /** What the provider will say about a customer from now on. Null: nothing. */
  async setStanding(customer: string, standing: object | null) {
    await this.control("POST", "standing", { customer, standing });
  }

  async refuse(refuse: boolean) {
    await this.control("POST", "refuse", { refuse });
  }

  /** How many times the server asked about a customer's standing. */
  async looksAt(customer: string): Promise<number> {
    const calls: { method: string; path: string; customer: string | null }[] = await this.control("GET", "calls");
    return calls.filter((c) => c.method === "GET" && c.customer === customer).length;
  }

  async allCalls(): Promise<number> {
    return (await this.control("GET", "calls")).length;
  }

  /** Has the stand-in send a webhook about a customer, signed with the run's secret. */
  async send(port: string, event: object): Promise<{ status: number; id: string }> {
    return this.control("POST", "send", { url: `https://127.0.0.1:${port}/api/keykeeper/billing/events/standin`, event });
  }
}

/** Paid through a moment, as the provider says it. */
const paidThrough = (plan: string, until: string, renews = true) => ({
  plan,
  standing: "until",
  until,
  renews,
  billed: plan === "msp" || plan === "business" ? "by_the_day" : "prepaid",
  subscription: `sub_${randomUUID().slice(0, 8)}`,
});
/** Over: the provider has the subscription, and nothing is paid. */
const over = (plan: string) => ({ plan, standing: "none", renews: false, billed: "prepaid" });

type BillingServer = {
  port: string;
  process: ChildProcess;
  dataDir: string;
  log: string;
  admin: APIRequestContext;
};

type ServerSetup = {
  enforced: boolean;
  provider?: string;
  apiBase?: string;
  apiKey?: string;
  secrets?: string[];
  schedule?: string;
};

function serverEnv(port: string, dataDir: string, setup: ServerSetup, adminToken: string) {
  return {
    ...process.env,
    KK_PORT: port,
    KK_DATA_DIR: dataDir,
    KK_ADMIN_TOKEN: adminToken,
    KK_SERVER_LOG: path.join(dataDir, "server.log"),
    KK_PLANS_ENFORCED: setup.enforced ? "1" : "",
    KK_BILLING_PROVIDER: setup.provider ?? "",
    KK_BILLING_API_BASE: setup.apiBase ?? standinBase,
    KK_BILLING_API_KEY: setup.apiKey ?? API_KEY,
    KK_BILLING_WEBHOOK_SECRET: setup.secrets?.[0] ?? SECRET,
    KK_BILLING_WEBHOOK_SECRET_OLD: setup.secrets?.[1] ?? "",
    KK_BILLING_LOOK_SCHEDULE: setup.schedule ?? "",
  };
}

/** Starts a server of the test's own, with the admin page on, and signs the operator in. */
async function startServer(
  playwright: { request: { newContext(options: object): Promise<APIRequestContext> } },
  port: string,
  setup: ServerSetup,
): Promise<BillingServer> {
  const adminToken = randomBytes(32).toString("base64url");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-e2e-billing-"));
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
  return { port, process: child, dataDir, log: path.join(dataDir, "server-restart.log"), admin };
}

async function stopServer(server: BillingServer | undefined) {
  if (!server) {
    return;
  }
  await server.admin.dispose();
  const exited = new Promise((resolve) => server.process.once("exit", resolve));
  server.process.kill("SIGTERM");
  await exited;
  fs.rmSync(server.dataDir, { recursive: true, force: true });
}

/** How a server that's set up wrong ends: its exit code, which never comes for one that starts. */
async function exitOf(port: string, setup: ServerSetup): Promise<number | null> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-e2e-billing-refused-"));
  try {
    const child = spawn(process.execPath, ["server.mjs"], {
      cwd: e2eDir,
      env: serverEnv(port, dataDir, setup, randomBytes(32).toString("base64url")),
      stdio: "ignore",
    });
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    // Whether it answers, over the run's throwaway certificate.
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

/** Reads (or with `write`, changes) a server's SQLite database. */
async function database(server: BillingServer) {
  const { DatabaseSync } = await import("node:sqlite");
  const file = path.join(server.dataDir, "db.sqlite3");
  return {
    count(sql: string, ...params: string[]): number {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        return Number(Object.values(db.prepare(sql).get(...params) ?? {})[0] ?? 0);
      } finally {
        db.close();
      }
    },
    write(sql: string, ...params: string[]): number {
      const db = new DatabaseSync(file);
      try {
        db.exec("PRAGMA busy_timeout = 5000");
        return Number(db.prepare(sql).run(...params).changes);
      } finally {
        db.close();
      }
    },
  };
}

/** Makes the provider's last answer about someone's plan `hours` older. */
async function ageLastAnswer(server: BillingServer, userId: string, hours: number) {
  const db = await database(server);
  const changed = db.write(
    `UPDATE plans SET checked_at = strftime('%Y-%m-%d %H:%M:%f', checked_at, ?) WHERE user_uuid = ?`,
    `-${hours} hours`,
    userId,
  );
  expect(changed, "the plan's last answer was made older").toBe(1);
}

/** A webhook as anyone could send one: these bytes, and this signature header (or none). */
async function webhook(request: APIRequestContext, port: string, body: string | Buffer, header?: string | null, provider = "standin") {
  return result(
    await request.post(`https://127.0.0.1:${port}/api/keykeeper/billing/events/${provider}`, {
      headers: {
        "Content-Type": "application/json",
        ...(header === null || header === undefined ? {} : { [SIGNATURE_HEADER]: header }),
      },
      data: body,
    }),
  );
}

const event = (customer: string | null, extra: object = {}) =>
  JSON.stringify({ id: `evt_${randomUUID()}`, object: "event", livemode: false, type: "invoice.paid", customer, ...extra });

/** The caller's own plan, an organization's, or an MSP's, as `GET /api/keykeeper/plan` answers it. */
async function planOf(api: Api, as: Account, query = ""): Promise<any> {
  const answer = await api.call(as, "GET", `/api/keykeeper/plan${query}`);
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body;
}

/** Each payment route with a request it takes, for a person's own plan and for an organization's. */
const paymentRoutes = (orgId: string): [string, object][] => [
  ["pay", { plan: "premium" }],
  ["manage", {}],
  ["look", {}],
  ["pay", { organization: orgId, plan: "business" }],
  ["manage", { organization: orgId }],
];

/** Someone who has opened the provider's page to pay for their Premium, and the customer the provider made. */
async function payingPerson(api: Api, standin: Standin, prefix: string): Promise<{ person: Account; customer: string }> {
  const person = await api.account(prefix);
  const paid = await api.call(person, "POST", "/api/keykeeper/plan/pay", { plan: "premium" });
  expect(paid.status, JSON.stringify(paid.body)).toBe(200);
  expect(paid.body.url).toMatch(new RegExp(`^${pagesBase}/checkout/`));
  return { person, customer: await standin.customerOf(`user:${person.userId}`) };
}

let standinProcess: ChildProcess | undefined;
let standin: Standin;
let standinHttp: APIRequestContext;

test.beforeAll(async ({ playwright }) => {
  standinProcess = spawn(process.execPath, ["billing-standin.mjs"], {
    cwd: e2eDir,
    env: {
      ...process.env,
      KK_BILLING_STANDIN_PORT: billingStandinPort,
      KK_BILLING_STANDIN_PAGES_PORT: billingStandinPagesPort,
      KK_BILLING_API_KEY: API_KEY,
      KK_BILLING_WEBHOOK_SECRET: SECRET,
    },
    stdio: "ignore",
  });
  standinHttp = await playwright.request.newContext();
  await expect
    .poll(async () => (await standinHttp.get(`${standinBase}/alive`).catch(() => null))?.status() ?? 0, {
      timeout: 30_000,
    })
    .toBe(200);
  standin = new Standin(standinHttp);
});

test.afterAll(async () => {
  await standinHttp?.dispose();
  if (standinProcess) {
    const exited = new Promise((resolve) => standinProcess!.once("exit", resolve));
    standinProcess.kill("SIGTERM");
    await exited;
  }
});

test.describe("where plans are enforced and the stand-in is the payment provider", () => {
  test.use({ baseURL: `https://127.0.0.1:${billingServerPort}` });

  let server: BillingServer | undefined;

  test.beforeAll(async ({ playwright }) => {
    // The billing job runs every second here, so the looks it makes are seen now.
    server = await startServer(playwright, billingServerPort, {
      enforced: true,
      provider: "standin",
      schedule: "* * * * * *",
    });
  });

  test.afterAll(async () => {
    await stopServer(server);
  });

  test("paying: the provider's page, and the plan changes only through a look after a good webhook", async ({
    request,
  }) => {
    const api = new Api(request);
    const person = await api.account("billing-pay");
    expect(await planOf(api, person)).toMatchObject({ plan: "free", state: null, canManage: true, canPay: true });

    // The page to pay, on the provider's site, as an https address.
    const paid = await api.call(person, "POST", "/api/keykeeper/plan/pay", { plan: "premium" });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(Object.keys(paid.body)).toEqual(["url"]);
    expect(paid.body.url).toMatch(new RegExp(`^${pagesBase}/checkout/`));
    const customer = await standin.customerOf(`user:${person.userId}`);
    // Asking again uses the same customer, so its webhooks are about someone the server knows.
    expect((await api.call(person, "POST", "/api/keykeeper/plan/pay", { plan: "premium" })).status).toBe(200);
    expect(await standin.customerOf(`user:${person.userId}`)).toBe(customer);
    // A plan a person can't have: the server's ordinary 400.
    for (const plan of ["business", "families", "msp", "enterprise", ""]) {
      const wrong = await api.call(person, "POST", "/api/keykeeper/plan/pay", { plan });
      expect(wrong.status, plan).toBe(400);
    }
    // No plan, or something else in the request: a request the server can't read, as for any route.
    for (const data of [{}, { plan: "premium", until: "2099-01-01T00:00:00Z" }]) {
      const wrong = await api.call(person, "POST", "/api/keykeeper/plan/pay", data);
      expect(wrong.status, JSON.stringify(data)).toBe(422);
    }

    // Paid at the provider: nothing changes on its own.
    const until = fromNow(365 * DAY);
    await standin.setStanding(customer, paidThrough("premium", until));
    expect(await planOf(api, person)).toMatchObject({ plan: "free" });

    // A webhook whose body claims things is only a reason to look: what
    // the plan becomes is what the provider says when it's asked.
    const sent = await standin.send(billingServerPort, {
      customer,
      plan: "business",
      standing: "open",
      data: { object: { status: "active", current_period_end: 4102444800 } },
    });
    expect(sent.status).toBe(200);
    await expect.poll(async () => (await planOf(api, person)).state).toBe("active");
    const plan = await planOf(api, person);
    expect(plan).toMatchObject({ plan: "premium", state: "active", renews: true, canPay: true });
    expect(moment(plan.until)).toBe(moment(until));
    const profile = (await api.call(person, "GET", "/api/sync?excludeDomains=true")).body.profile;
    expect(profile.premium).toBe(true);
    expect(profile.keykeeperPlan).toEqual(plan);

    // The operator sees who set it and when the provider was asked.
    const read = await result(await server!.admin.get(`/admin/plans/users/${person.userId}`));
    expect(read.body.plan).toMatchObject({
      plan: "premium",
      standing: "until",
      setBy: "provider",
      provider: "standin",
      providerCustomer: customer,
    });
    expect(Date.now() - new Date(read.body.plan.checkedAt).getTime()).toBeLessThan(60_000);

    // Managing: the provider's page for that customer, which comes back to
    // the person's Plan page.
    const managed = await api.call(person, "POST", "/api/keykeeper/plan/manage", {});
    expect(managed.status, JSON.stringify(managed.body)).toBe(200);
    const back = `https://127.0.0.1:${billingServerPort}/#/settings/plan`;
    expect(managed.body.url).toBe(`${pagesBase}/portal/${customer}?back=${encodeURIComponent(back)}`);

    // A webhook about a Free person with nothing at the provider changes nothing.
    const free = await payingPerson(api, standin, "billing-pay-free");
    expect((await standin.send(billingServerPort, { customer: free.customer, plan: "premium" })).status).toBe(200);
    await expect.poll(() => standin.looksAt(free.customer)).toBe(1);
    expect(await planOf(api, free.person)).toMatchObject({ plan: "free", state: null });
    expect((await api.call(free.person, "POST", "/api/keykeeper/plan/manage", {})).status).toBe(200);
  });

  test("the provider's pages: paying and canceling there come back to the Plan page, and the plan follows", async ({
    playwright,
    request,
  }) => {
    test.setTimeout(120_000);
    const api = new Api(request);
    const browser = await playwright.request.newContext({ ignoreHTTPSErrors: true });
    try {
      /** Opens a page the server handed out, and presses its one button. */
      const press = async (url: string, button: "pay" | "cancel") => {
        const opened = await browser.get(url);
        expect(opened.status(), url).toBe(200);
        const html = await opened.text();
        const action = html.match(/<form method="post" action="([^"]+)">/)![1].replaceAll("&amp;", "&");
        const pressed = await browser.post(new URL(action, url).toString(), { maxRedirects: 0 });
        expect(pressed.status(), button).toBe(303);
        return { html, location: pressed.headers().location };
      };
      const vault = `https://127.0.0.1:${billingServerPort}/#`;

      // A person's Premium.
      const person = await api.account("billing-pages");
      const paid = await api.call(person, "POST", "/api/keykeeper/plan/pay", { plan: "premium" });
      const pay = await press(paid.body.url, "pay");
      expect(pay.html).toContain(`href="${vault}/settings/plan"`);
      expect(pay.location).toBe(`${vault}/settings/plan`);
      await expect.poll(async () => (await planOf(api, person)).state).toBe("active");
      expect(await planOf(api, person)).toMatchObject({ plan: "premium", renews: true });
      const managed = await api.call(person, "POST", "/api/keykeeper/plan/manage", {});
      expect((await press(managed.body.url, "cancel")).location).toBe(`${vault}/settings/plan`);
      await expect.poll(async () => (await planOf(api, person)).renews).toBe(false);
      expect((await planOf(api, person)).state).toBe("active");

      // An organization's Business, for its owner.
      const owner = await api.account("billing-pages-owner");
      const orgId = await api.organization(owner, "Billing Pages Org");
      const orgPaid = await api.call(owner, "POST", "/api/keykeeper/plan/pay", { organization: orgId, plan: "business" });
      expect(orgPaid.status, JSON.stringify(orgPaid.body)).toBe(200);
      expect((await press(orgPaid.body.url, "pay")).location).toBe(`${vault}/organizations/${orgId}/plan`);
      await expect.poll(async () => (await planOf(api, owner, `?organization=${orgId}`)).state).toBe("active");

      // An MSP's pool, for its admins: a card on file.
      const mspAdmin = await api.account("billing-pages-msp");
      const mspId = await api.msp(mspAdmin, "Billing Pages MSP");
      const poolPaid = await api.call(mspAdmin, "POST", "/api/keykeeper/plan/pay", { msp: mspId, plan: "msp" });
      expect(poolPaid.status, JSON.stringify(poolPaid.body)).toBe(200);
      expect((await press(poolPaid.body.url, "pay")).location).toBe(`${vault}/msp`);
      await expect.poll(async () => (await planOf(api, mspAdmin, `?msp=${mspId}`)).state).toBe("active");
      expect(await planOf(api, mspAdmin, `?msp=${mspId}`)).toMatchObject({ plan: "msp", until: null, canPay: true });
    } finally {
      await browser.dispose();
    }
  });

  test("a wrong secret, a changed byte, an old or early timestamp, another scheme, or no signature: an empty 400, and nothing kept or looked at", async ({
    request,
  }) => {
    const api = new Api(request);
    const { person, customer } = await payingPerson(api, standin, "billing-refused");
    await standin.setStanding(customer, paidThrough("premium", fromNow(365 * DAY)));
    const db = await database(server!);
    const kept = db.count("SELECT COUNT(*) FROM billing_events");
    const now = Math.floor(Date.now() / 1000);

    const body = event(customer);
    const changed = body.replace(customer, `${customer.slice(0, -1)}${customer.endsWith("0") ? "1" : "0"}`);
    expect(changed.length).toBe(body.length);
    const marker = `refused-body-${randomUUID()}`;
    const withMarker = event(customer, { note: marker });
    const refusals: [string, string, string | null][] = [
      ["a secret not in use", body, signatureHeader([NOT_OURS], body)],
      ["the API key as the secret", body, signatureHeader([API_KEY], body)],
      ["a body changed by one byte", changed, signatureHeader([SECRET], body)],
      ["a timestamp six minutes old", body, signatureHeader([SECRET], body, now - 360)],
      ["a timestamp six minutes ahead", body, signatureHeader([SECRET], body, now + 360)],
      ["another scheme", body, signatureHeader([SECRET], body).replace("v1=", "v0=")],
      ["no signature", body, null],
      ["an empty signature header", body, ""],
      ["a signature over nothing", body, signatureHeader([SECRET], "")],
      ["a body to remember", withMarker, signatureHeader([NOT_OURS], withMarker)],
    ];
    for (const [what, sentBody, header] of refusals) {
      const answer = await webhook(request, billingServerPort, sentBody, header);
      // A 400 that says nothing about why.
      expect(answer, what).toEqual({ status: 400, body: null });
    }
    expect(db.count("SELECT COUNT(*) FROM billing_events")).toBe(kept);
    expect(await standin.looksAt(customer)).toBe(0);
    expect(await planOf(api, person)).toMatchObject({ plan: "free" });

    // The route is only the provider's that's set: any other is a path the server doesn't have.
    const nowhere = await api.call(person, "POST", `/api/keykeeper/no-such-route-${randomUUID()}`);
    for (const provider of ["stripe", "Standin", "standin2"]) {
      const answer = await webhook(request, billingServerPort, body, signatureHeader([SECRET], body), provider);
      expect(answer, provider).toEqual(nowhere);
    }

    // The same body, signed with the secret in use, is taken.
    const taken = await webhook(request, billingServerPort, body, signatureHeader([SECRET], body));
    expect(taken).toEqual({ status: 200, body: null });
    await expect.poll(async () => (await planOf(api, person)).plan).toBe("premium");
    expect(db.count("SELECT COUNT(*) FROM billing_events")).toBe(kept + 1);
    // The refused body was never written to the log.
    expect(fs.readFileSync(server!.log, "utf8")).not.toContain(marker);
  });

  test("the same event twice is answered and dropped, and the other mode is dropped", async ({ request }) => {
    const api = new Api(request);
    const { person, customer } = await payingPerson(api, standin, "billing-twice");
    const db = await database(server!);
    await standin.setStanding(customer, paidThrough("premium", fromNow(365 * DAY)));
    const body = event(customer);
    const id = JSON.parse(body).id;
    expect(await webhook(request, billingServerPort, body, signatureHeader([SECRET], body))).toEqual({
      status: 200,
      body: null,
    });
    await expect.poll(() => standin.looksAt(customer)).toBe(1);
    await expect.poll(async () => (await planOf(api, person)).renews).toBe(true);

    // Canceled at the provider. The same event again, freshly signed as a
    // provider resends one, is answered and causes no look.
    await standin.setStanding(customer, paidThrough("premium", fromNow(365 * DAY), false));
    expect(await webhook(request, billingServerPort, body, signatureHeader([SECRET], body))).toEqual({
      status: 200,
      body: null,
    });
    // A live event, on a server whose provider is in test mode, the same.
    const live = event(customer, { livemode: true });
    expect(await webhook(request, billingServerPort, live, signatureHeader([SECRET], live))).toEqual({
      status: 200,
      body: null,
    });
    expect(db.count("SELECT COUNT(*) FROM billing_events WHERE event_id = ?", id)).toBe(1);
    expect(
      db.count("SELECT COUNT(*) FROM billing_events WHERE event_id = ? AND pending_customer IS NULL", JSON.parse(live).id),
    ).toBe(1);
    expect((await planOf(api, person)).renews).toBe(true);

    // A new event does cause one, which is the only other look there was.
    expect((await standin.send(billingServerPort, { customer })).status).toBe(200);
    await expect.poll(async () => (await planOf(api, person)).renews).toBe(false);
    expect(await standin.looksAt(customer)).toBe(2);
  });

  test("a body over 1 MiB is refused, and one of exactly 1 MiB taken", async ({ request }) => {
    const api = new Api(request);
    const { person, customer } = await payingPerson(api, standin, "billing-size");
    await standin.setStanding(customer, paidThrough("premium", fromNow(365 * DAY)));
    const base = event(customer);
    // The same event padded with spaces, which JSON allows, to a size.
    const padded = (size: number) => `${base.slice(0, -1)}${" ".repeat(size - base.length)}}`;
    const tooLarge = padded(MIB + 1);
    expect(Buffer.byteLength(tooLarge)).toBe(MIB + 1);
    expect(await webhook(request, billingServerPort, tooLarge, signatureHeader([SECRET], tooLarge))).toEqual({
      status: 400,
      body: null,
    });
    expect(await standin.looksAt(customer)).toBe(0);
    const largest = padded(MIB);
    expect(Buffer.byteLength(largest)).toBe(MIB);
    expect(await webhook(request, billingServerPort, largest, signatureHeader([SECRET], largest))).toEqual({
      status: 200,
      body: null,
    });
    await expect.poll(async () => (await planOf(api, person)).plan).toBe("premium");
  });

  test("an event about nobody the server knows, or about no customer, is answered and dropped", async ({ request }) => {
    const db = await database(server!);
    for (const customer of ["cus_nobody", null]) {
      const body = event(customer);
      expect(await webhook(request, billingServerPort, body, signatureHeader([SECRET], body))).toEqual({
        status: 200,
        body: null,
      });
      await expect
        .poll(() => db.count("SELECT COUNT(*) FROM billing_events WHERE event_id = ? AND pending_customer IS NULL", JSON.parse(body).id))
        .toBe(1);
    }
    // The provider wasn't asked about the customer it never had.
    expect(await standin.looksAt("cus_nobody")).toBe(0);
    // An id the server won't keep is refused like a bad signature.
    const odd = JSON.stringify({ id: "evt with spaces", livemode: false, customer: null });
    expect((await webhook(request, billingServerPort, odd, signatureHeader([SECRET], odd))).status).toBe(400);
    const notAnEvent = "[1,2,3]";
    expect((await webhook(request, billingServerPort, notAnEvent, signatureHeader([SECRET], notAnEvent))).status).toBe(400);
  });

  test("a webhook that never came is made up by looking again: when asked, when the plan's date passes, and once a day", async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const api = new Api(request);

    // Back from the provider's page, the Plan page asks, so the plan shows
    // before any webhook: at most once a minute for each plan.
    const asked = await payingPerson(api, standin, "billing-look-asked");
    await standin.setStanding(asked.customer, paidThrough("premium", fromNow(365 * DAY)));
    const looked = await api.call(asked.person, "POST", "/api/keykeeper/plan/look", {});
    expect(looked.status).toBe(200);
    expect(looked.body).toMatchObject({ plan: "premium", state: "active", renews: true, canPay: true });
    expect(looked.body).toEqual(await planOf(api, asked.person));
    await standin.setStanding(asked.customer, paidThrough("premium", fromNow(365 * DAY), false));
    const again = await api.call(asked.person, "POST", "/api/keykeeper/plan/look", {});
    expect(again.status).toBe(200);
    expect(again.body.renews).toBe(true);
    expect(await standin.looksAt(asked.customer)).toBe(1);

    // The date it's paid through passes, and the provider renewed it
    // without a webhook: the server asks then.
    const renewed = await payingPerson(api, standin, "billing-look-renewed");
    await standin.setStanding(renewed.customer, paidThrough("premium", fromNow(8_000)));
    expect((await standin.send(billingServerPort, { customer: renewed.customer })).status).toBe(200);
    await expect.poll(async () => (await planOf(api, renewed.person)).state).toBe("active");
    const nextYear = fromNow(365 * DAY);
    await standin.setStanding(renewed.customer, paidThrough("premium", nextYear));
    await expect
      .poll(async () => moment((await planOf(api, renewed.person)).until), { timeout: 30_000 })
      .toBe(moment(nextYear));
    expect((await planOf(api, renewed.person)).state).toBe("active");

    // Once a day, every plan the provider set: canceled at the provider
    // with no webhook, seen once the last answer is a day old. One plan's
    // answer is 23 hours old and the other's 25: the run of the job that
    // looks at the second has seen the first, and leaves it.
    const [young, old] = [
      await payingPerson(api, standin, "billing-look-young"),
      await payingPerson(api, standin, "billing-look-daily"),
    ];
    for (const { person, customer } of [young, old]) {
      await standin.setStanding(customer, paidThrough("premium", fromNow(365 * DAY)));
      expect((await standin.send(billingServerPort, { customer })).status).toBe(200);
      await expect.poll(async () => (await planOf(api, person)).renews).toBe(true);
      await standin.setStanding(customer, paidThrough("premium", fromNow(365 * DAY), false));
    }
    await ageLastAnswer(server!, young.person.userId, 23);
    await ageLastAnswer(server!, old.person.userId, 25);
    await expect.poll(async () => (await planOf(api, old.person)).renews, { timeout: 30_000 }).toBe(false);
    expect(await standin.looksAt(old.customer)).toBe(2);
    expect(await standin.looksAt(young.customer)).toBe(1);
    expect((await planOf(api, young.person)).renews).toBe(true);
    // An hour on, it's a day old too.
    await ageLastAnswer(server!, young.person.userId, 2);
    await expect.poll(async () => (await planOf(api, young.person)).renews, { timeout: 30_000 }).toBe(false);
    expect(await standin.looksAt(young.customer)).toBe(2);
  });

  test("events out of order leave the plan the provider has now", async ({ request }) => {
    const api = new Api(request);
    const { person, customer } = await payingPerson(api, standin, "billing-order");
    const until = fromNow(365 * DAY);
    // Paid, then canceled: the provider's truth is canceled.
    await standin.setStanding(customer, paidThrough("premium", until, false));
    // The cancellation's event comes first, and the payment's after.
    expect((await standin.send(billingServerPort, { customer, type: "customer.subscription.updated" })).status).toBe(
      200,
    );
    await expect.poll(() => standin.looksAt(customer)).toBe(1);
    expect((await standin.send(billingServerPort, { customer, type: "customer.subscription.created" })).status).toBe(
      200,
    );
    await expect.poll(() => standin.looksAt(customer)).toBe(2);
    const plan = await planOf(api, person);
    expect(plan).toMatchObject({ plan: "premium", state: "active", renews: false });
    expect(moment(plan.until)).toBe(moment(until));

    // Over at the provider, then a late event from when it was paid: over.
    await standin.setStanding(customer, over("premium"));
    expect((await standin.send(billingServerPort, { customer, type: "customer.subscription.deleted" })).status).toBe(
      200,
    );
    await expect.poll(async () => (await planOf(api, person)).state).toBe("ended");
    expect((await standin.send(billingServerPort, { customer, type: "invoice.paid" })).status).toBe(200);
    await expect.poll(() => standin.looksAt(customer)).toBe(4);
    expect(await planOf(api, person)).toMatchObject({ plan: "premium", state: "ended" });
  });

  test("a provider that refuses every call leaves the plan as it was, the server keeps asking, and the operator is told after a day", async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const api = new Api(request);
    const { person, customer } = await payingPerson(api, standin, "billing-refusing");
    const until = fromNow(365 * DAY);
    await standin.setStanding(customer, paidThrough("premium", until));
    expect((await standin.send(billingServerPort, { customer })).status).toBe(200);
    await expect.poll(async () => (await planOf(api, person)).state).toBe("active");
    const db = await database(server!);
    const before = await planOf(api, person);

    try {
      await standin.refuse(true);
      // Ended at the provider, which can't be asked: nothing ends on a guess.
      await standin.setStanding(customer, over("premium"));
      const sent = await standin.send(billingServerPort, { customer });
      expect(sent.status).toBe(200);
      await expect
        .poll(() => db.count("SELECT COUNT(*) FROM billing_events WHERE event_id = ? AND pending_customer = ?", sent.id, customer))
        .toBe(1);
      const looked = await api.call(person, "POST", "/api/keykeeper/plan/look", {});
      expect(looked.status).toBe(200);
      expect(looked.body).toEqual(before);
      // Pages can't be had either, and say so.
      for (const [route, data] of [
        ["pay", { plan: "premium" }],
        ["manage", {}],
      ] as const) {
        const page = await api.call(person, "POST", `/api/keykeeper/plan/${route}`, data);
        expect(page.status, route).toBe(400);
        expect(page.body.message).toBe(UNREACHABLE);
      }

      // A day without an answer: the job keeps asking, the operator is told,
      // and the plan still stands.
      const asked = await standin.looksAt(customer);
      await ageLastAnswer(server!, person.userId, 25);
      await expect.poll(() => standin.looksAt(customer), { timeout: 30_000 }).toBeGreaterThan(asked + 1);
      await expect
        .poll(() => fs.readFileSync(server!.log, "utf8"), { timeout: 30_000 })
        .toMatch(/\[ERROR\].*The payment provider `standin` hasn't answered about \d+ plan\(s\) for more than a day/);
      expect(await planOf(api, person)).toEqual(before);
      expect(db.count("SELECT COUNT(*) FROM billing_events WHERE pending_customer = ?", customer)).toBe(1);
    } finally {
      await standin.refuse(false);
    }

    // Answering again: the job's next look writes what the provider says, and
    // the webhook's look is no longer owed.
    await expect.poll(async () => (await planOf(api, person)).state, { timeout: 30_000 }).toBe("ended");
    await expect.poll(() => db.count("SELECT COUNT(*) FROM billing_events WHERE pending_customer = ?", customer)).toBe(0);
  });

  test("webhooks' ids are kept 35 days, and cleared by the job after", async ({ request }) => {
    const db = await database(server!);
    const kept = event(null);
    const cleared = event(null);
    for (const body of [kept, cleared]) {
      expect((await webhook(request, billingServerPort, body, signatureHeader([SECRET], body))).status).toBe(200);
    }
    const age = (body: string, days: number) =>
      db.write(
        `UPDATE billing_events SET received_at = strftime('%Y-%m-%d %H:%M:%f', received_at, ?) WHERE event_id = ?`,
        `-${days} days`,
        JSON.parse(body).id,
      );
    expect(age(kept, 34)).toBe(1);
    expect(age(cleared, 36)).toBe(1);
    await expect
      .poll(() => db.count("SELECT COUNT(*) FROM billing_events WHERE event_id = ?", JSON.parse(cleared).id), {
        timeout: 30_000,
      })
      .toBe(0);
    expect(db.count("SELECT COUNT(*) FROM billing_events WHERE event_id = ?", JSON.parse(kept).id)).toBe(1);
    // Still within its 35 days, it's still a repeat.
    expect((await webhook(request, billingServerPort, kept, signatureHeader([SECRET], kept))).status).toBe(200);
    expect(db.count("SELECT COUNT(*) FROM billing_events WHERE event_id = ?", JSON.parse(kept).id)).toBe(1);
  });

  test("paying, managing, and looking are for whoever may pay for the plan, which canPay says, and 404 for everyone else", async ({
    request,
  }) => {
    test.setTimeout(180_000);
    const api = new Api(request);
    const owner = await api.account("billing-who-owner");
    const orgId = await api.organization(owner, "Billing Who Org");
    const orgAdmin = await api.account("billing-who-org-admin");
    await api.addMember(owner, orgId, orgAdmin, "admin");
    const manager = await api.account("billing-who-manager");
    await api.addMember(owner, orgId, manager, "manager");
    const member = await api.account("billing-who-member");
    await api.addMember(owner, orgId, member, "user");
    const unconfirmed = await api.account("billing-who-unconfirmed");
    await api.addMember(owner, orgId, unconfirmed, "owner", { confirm: false });
    const mspAdmin = await api.account("billing-who-msp-admin");
    const mspId = await api.msp(mspAdmin, "Billing Who MSP");
    const clientId = await api.client(mspAdmin, mspId, "Billing Who Client");
    const tech = await api.account("billing-who-tech");
    await api.addStaff(mspAdmin, mspId, tech, "technician");
    const clientOwner = await api.account("billing-who-client-owner");
    await api.addMember(mspAdmin, clientId, clientOwner, "owner");
    const outsider = await api.account("billing-who-outsider");
    const otherOwner = await api.account("billing-who-other-owner");
    await api.organization(otherOwner, "Billing Who Other");

    const everyone = { owner, orgAdmin, manager, member, unconfirmed, mspAdmin, tech, clientOwner, outsider, otherOwner };
    type Name = keyof typeof everyone;
    const orgPlanBefore = await planOf(api, owner, `?organization=${orgId}`);
    // Whose plan, the plan paid for, and who may pay for it. A client's plan
    // is its MSP's pool: its MSP's admins manage it, and pay for it as the pool.
    const plans: [{ organization: string } | { msp: string }, string, Name[]][] = [
      [{ organization: orgId }, "business", ["owner"]],
      [{ msp: mspId }, "msp", ["mspAdmin"]],
      [{ organization: clientId }, "business", []],
      [{ organization: randomUUID() }, "business", []],
      [{ msp: orgId }, "msp", []],
    ];
    for (const [whose, plan, may] of plans) {
      const [kind, id] = Object.entries(whose)[0];
      for (const name of Object.keys(everyone) as Name[]) {
        const as = everyone[name];
        const label = `${name} ${kind} ${id}`;
        const read = await api.call(as, "GET", `/api/keykeeper/plan?${kind}=${id}`);
        const pay = await api.call(as, "POST", "/api/keykeeper/plan/pay", { ...whose, plan });
        const manage = await api.call(as, "POST", "/api/keykeeper/plan/manage", whose);
        const look = await api.call(as, "POST", "/api/keykeeper/plan/look", whose);
        // What canPay says and what the routes answer agree.
        const canPay = read.status === 200 && read.body.canPay === true;
        expect(canPay, label).toBe(may.includes(name));
        if (canPay) {
          expect(pay.status, label).toBe(200);
          expect(manage, label).toEqual({ status: 200, body: expect.objectContaining({ url: expect.any(String) }) });
          expect(look.status, label).toBe(200);
        } else {
          for (const [route, answer] of [
            ["pay", pay],
            ["manage", manage],
            ["look", look],
          ] as const) {
            // Never 403, which would sign the web vault out.
            expect(answer, `${label} ${route}`).toEqual({
              status: 404,
              body: expect.objectContaining({ message: "Plan not found" }),
            });
          }
        }
      }
    }
    // The MSP's admin manages the client's plan, and pays for it as the pool.
    expect(await planOf(api, mspAdmin, `?organization=${clientId}`)).toMatchObject({ canManage: true, canPay: false });

    // Everyone may pay for their own Premium, and manage it once there's
    // something paid for at the provider.
    for (const name of Object.keys(everyone) as Name[]) {
      const as = everyone[name];
      expect((await planOf(api, as)).canPay, name).toBe(true);
    }
    const fresh = await api.account("billing-who-fresh");
    expect(await api.call(fresh, "POST", "/api/keykeeper/plan/manage", {})).toEqual({
      status: 400,
      body: expect.objectContaining({ message: NOTHING_TO_MANAGE }),
    });
    // Not signed in: sign in first.
    for (const [route, data] of paymentRoutes(orgId)) {
      expect((await api.call(null, "POST", `/api/keykeeper/plan/${route}`, data)).status, route).toBe(401);
    }
    // An organization or an MSP, not both.
    expect(
      (await api.call(owner, "POST", "/api/keykeeper/plan/manage", { organization: orgId, msp: mspId })).status,
    ).toBe(400);
    // Nobody writes a plan through these: with nothing paid at the provider,
    // the organization's plan is as it was.
    expect(await planOf(api, owner, `?organization=${orgId}`)).toEqual(orgPlanBefore);
  });

  test("the provider's secrets never reach a log, the admin page, or its support details", async () => {
    const log = fs.readFileSync(server!.log, "utf8");
    expect(log.length).toBeGreaterThan(0);
    const pages = await Promise.all(
      // The settings page, and the configuration the diagnostics page hands
      // out as support details. (The diagnostics page itself asks the
      // internet for the latest versions, which these tests never reach.)
      ["/admin", "/admin/diagnostics/config"].map(async (page) => {
        const answer = await server!.admin.get(page, {
          headers: { Accept: page.endsWith("config") ? "application/json" : "text/html" },
        });
        expect(answer.status(), page).toBe(200);
        return answer.text();
      }),
    );
    for (const secret of [API_KEY, SECRET]) {
      expect(log.includes(secret)).toBe(false);
      for (const page of pages) {
        expect(page.includes(secret)).toBe(false);
      }
    }
    // The admin page names the provider, which isn't a secret.
    expect(pages[1]).toMatch(/"billing_provider":\s*"standin"/);
  });
});

test.describe("while a signing secret is replaced", () => {
  test.use({ baseURL: `https://127.0.0.1:${billingReplaceServerPort}` });

  let server: BillingServer | undefined;

  test.beforeAll(async ({ playwright }) => {
    server = await startServer(playwright, billingReplaceServerPort, {
      enforced: true,
      provider: "standin",
      secrets: [SECRET, OLD_SECRET],
    });
  });

  test.afterAll(async () => {
    await stopServer(server);
  });

  test("either secret signs, alone or beside the other, and nothing else does", async ({ request }) => {
    const api = new Api(request);
    const { person, customer } = await payingPerson(api, standin, "billing-replace");
    await standin.setStanding(customer, paidThrough("premium", fromNow(365 * DAY)));
    const signed: [string, string[], number][] = [
      ["the old secret alone", [OLD_SECRET], 200],
      ["the new secret alone", [SECRET], 200],
      ["both, as the provider sends while both are in use", [OLD_SECRET, SECRET], 200],
      ["a secret not in use beside the old one", [NOT_OURS, OLD_SECRET], 200],
      ["a secret not in use", [NOT_OURS], 400],
    ];
    let looks = 0;
    for (const [what, secrets, status] of signed) {
      const body = event(customer);
      expect(await webhook(request, billingReplaceServerPort, body, signatureHeader(secrets, body)), what).toEqual({
        status,
        body: null,
      });
      if (status === 200) {
        looks += 1;
        await expect.poll(() => standin.looksAt(customer), { message: what }).toBe(looks);
      }
    }
    expect(await planOf(api, person)).toMatchObject({ plan: "premium", state: "active" });
  });
});

test.describe("where plans are enforced and no payment provider is set", () => {
  test.use({ baseURL: `https://127.0.0.1:${billingNoProviderServerPort}` });

  let server: BillingServer | undefined;

  test.beforeAll(async ({ playwright }) => {
    server = await startServer(playwright, billingNoProviderServerPort, { enforced: true });
  });

  test.afterAll(async () => {
    await stopServer(server);
  });

  test("there's no webhook route, no page to pay or manage, and canPay is false for everyone", async ({ request }) => {
    const api = new Api(request);
    const person = await api.account("billing-none");
    const orgId = await api.organization(person, "Billing None Org");
    const nowhere = await api.call(person, "POST", `/api/keykeeper/no-such-route-${randomUUID()}`);
    expect(nowhere.status).toBe(404);
    const body = event(null);
    for (const provider of ["standin", "stripe", ""]) {
      const answer = await webhook(request, billingNoProviderServerPort, body, signatureHeader([SECRET], body), provider);
      expect(answer, provider).toEqual(nowhere);
    }
    for (const [route, data] of paymentRoutes(orgId)) {
      expect(await api.call(person, "POST", `/api/keykeeper/plan/${route}`, data), route).toEqual(nowhere);
    }
    expect(await planOf(api, person)).toMatchObject({ enforced: true, canManage: true, canPay: false });
    expect(await planOf(api, person, `?organization=${orgId}`)).toMatchObject({ canManage: true, canPay: false });
    const db = await database(server!);
    expect(db.count("SELECT COUNT(*) FROM billing_events")).toBe(0);
  });
});

test.describe("where plans aren't enforced, with a payment provider set", () => {
  test.use({ baseURL: `https://127.0.0.1:${billingOffServerPort}` });

  let server: BillingServer | undefined;

  test.beforeAll(async ({ playwright }) => {
    server = await startServer(playwright, billingOffServerPort, {
      enforced: false,
      provider: "standin",
      schedule: "* * * * * *",
    });
  });

  test.afterAll(async () => {
    await stopServer(server);
  });

  test("the provider does nothing: no route, nothing asked of it, and the sync as it has always been", async ({
    request,
  }) => {
    const api = new Api(request);
    const before = await standin.allCalls();
    const person = await api.account("billing-off");
    const orgId = await api.organization(person, "Billing Off Org");
    const nowhere = await api.call(person, "POST", `/api/keykeeper/no-such-route-${randomUUID()}`);
    expect(nowhere.status).toBe(404);
    const body = event("cus_anyone");
    expect(await webhook(request, billingOffServerPort, body, signatureHeader([SECRET], body))).toEqual(nowhere);
    for (const [route, data] of paymentRoutes(orgId)) {
      expect(await api.call(person, "POST", `/api/keykeeper/plan/${route}`, data), route).toEqual(nowhere);
    }
    // Every plan field is as it has always been: no canPay, and nothing else.
    expect(await api.call(person, "GET", "/api/keykeeper/plan")).toEqual({ status: 200, body: { enforced: false } });
    const profile = (await api.call(person, "GET", "/api/sync?excludeDomains=true")).body.profile;
    expect(profile.premium).toBe(true);
    expect(profile.keykeeperPlan).toEqual({ enforced: false });
    expect(profile.organizations[0].keykeeperPlan).toEqual({ enforced: false });
    // A plan the operator recorded is never looked at, by any job.
    const set = await server!.admin.post(`/admin/plans/users/${person.userId}`, {
      data: { plan: "premium", standing: "until", until: fromNow(-2 * DAY), renews: true },
    });
    expect(set.status()).toBe(200);
    const db = await database(server!);
    expect(db.count("SELECT COUNT(*) FROM billing_events")).toBe(0);
    expect(db.count("SELECT COUNT(*) FROM billing_customers")).toBe(0);
    expect(await standin.allCalls()).toBe(before);
    expect(fs.readFileSync(server!.log, "utf8")).toContain("BILLING_PROVIDER does nothing while PLANS_ENFORCED is off.");
  });
});

test.describe("a server set up with the stand-in for anything but tests", () => {
  test("doesn't start: an address off this machine, a name, or a key that looks live", async () => {
    test.setTimeout(180_000);
    for (const [what, setup] of [
      ["an address off this machine", { apiBase: "http://192.0.2.10:8124" }],
      ["a name for this machine", { apiBase: `http://localhost:${billingStandinPort}` }],
      ["no address", { apiBase: "" }],
      ["a key that looks live", { apiKey: "rk_live_madeup" }],
      ["no webhook secret", { secrets: [""] }],
      ["a provider the server doesn't have", { provider: "stripe" }],
    ] as [string, Partial<ServerSetup>][]) {
      const code = await exitOf(billingRefusedServerPort, { enforced: true, provider: "standin", ...setup });
      expect(code, what).not.toBeNull();
      expect(code, what).not.toBe(0);
    }
  });
});
