// Stripe, the first payment provider (DESIGN.md, "Plans and billing", "Stripe,
// the first provider"): the server's Stripe adapter against stripe-standin.mjs,
// a stand-in for Stripe's API with a key, signing secrets, and prices made up
// for the run. Nothing here talks to Stripe.
//
// - Paying for Premium and Families is a Checkout Session; managing is the
//   customer portal; Business and an MSP's pool aren't paid for online yet.
// - Each request is form-encoded, with the restricted key as a bearer token
//   and the pinned Stripe-Version, which the stand-in checks.
// - The plan follows Stripe's subscriptions, read by the design's table, and
//   only after the server asks: a webhook is only a reason to look.
// - Someone Stripe already bills for a plan in effect gets the portal, never a
//   second checkout, whatever their button said.
// - Deleting an account or an organization cancels what Stripe bills for it,
//   at once, by every way there is to delete one; Stripe being unreachable is
//   logged for the operator and never stops the deletion.
// - With PLANS_ENFORCED off, or no provider, nothing is asked of Stripe and
//   every answer is what it has always been.
// - A server set up wrong doesn't start.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type APIRequestContext, expect, test } from "@playwright/test";

import {
  port as mainPort,
  stripeNoProviderServerPort,
  stripeOffServerPort,
  stripeRefusedServerPort,
  stripeReplaceServerPort,
  stripeServerPort,
  stripeStandinPagesPort,
  stripeStandinPort,
} from "../../paths.mjs";
import { stripeSignature } from "../../stripe-standin.mjs";
import { waitForMessage } from "../mail/mailbox";

import { type Account, Api, type Result } from "./support";

const e2eDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const DAY = 86_400_000;
const SECOND = 1000;

/** The version the adapter pins (passbundle-server, src/keykeeper_billing/stripe.rs, `VERSION`). */
const VERSION = "2026-10-28.endive";

/** The run's key, signing secrets, and prices, made up here and kept in memory only. */
const made = (prefix: string) => `${prefix}${randomBytes(18).toString("base64url")}`;
const API_KEY = made("rk_test_");
const SECRET = made("whsec_");
const OLD_SECRET = made("whsec_");
const NOT_OURS = made("whsec_");
const PREMIUM = made("price_");
const FAMILIES = made("price_");

const standinBase = `http://127.0.0.1:${stripeStandinPort}`;
/** Where the stand-in's pages are, over HTTPS, as Stripe's are. */
const pagesBase = `https://127.0.0.1:${stripeStandinPagesPort}`;
const UNREACHABLE = "The payment provider can't be reached right now. Try again in a few minutes.";

/** A moment this far from now, to the second, in seconds as Stripe writes them. */
const secondsFromNow = (ms: number) => Math.floor((Date.now() + ms) / SECOND);
/** A date the server sent, as a number. */
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

type Subscription = {
  id: string;
  status: string;
  customer: string;
  cancel_at_period_end: boolean;
  metadata: Record<string, string>;
  items: { data: { current_period_start: number; current_period_end: number; price: { id: string } }[] };
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

  /** The calls made after `before` of them. */
  async callsSince(before: number): Promise<Call[]> {
    return (await this.calls()).slice(before);
  }

  /** The customer the server made for an owner (`user_<id>` and the like). */
  async customerOf(whose: string): Promise<string> {
    const customers: { id: string; metadata: Record<string, string> }[] = await this.control("GET", "customers");
    const found = customers.filter((c) => c.metadata.whose === whose);
    expect(found.length, `one customer for ${whose}`).toBe(1);
    return found[0].id;
  }

  async subscriptionsOf(customer: string): Promise<Subscription[]> {
    return this.control("GET", `subscriptions?customer=${encodeURIComponent(customer)}`);
  }

  /** Changes a subscription as Stripe would on its own: its status, its period, its cancellation. */
  async change(id: string, changes: object): Promise<Subscription> {
    return this.control("POST", "subscription", { id, ...changes });
  }

  /** A customer and a subscription, made as if in Stripe's dashboard, with no webhook sent. */
  async make(options: object): Promise<{ customer: { id: string }; subscription: Subscription | null }> {
    return this.control("POST", "make", options);
  }

  /** Has the stand-in send a webhook, as Stripe would, to the server that pays for that customer. */
  async send(event: object): Promise<{ status: number; id: string }> {
    return this.control("POST", "send", event);
  }

  async refuse(refuse: boolean) {
    await this.control("POST", "refuse", { refuse });
  }

  /** How many times the server read a customer's subscriptions. */
  async looksAt(customer: string): Promise<number> {
    return (await this.calls()).filter((c) => c.method === "GET" && c.query.customer === customer).length;
  }
}

type StripeServer = {
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
  premium?: string | null;
  families?: string | null;
  mail?: boolean;
};

function serverEnv(port: string, dataDir: string, setup: ServerSetup, adminToken: string) {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    KK_PORT: port,
    KK_DATA_DIR: dataDir,
    KK_ADMIN_TOKEN: adminToken,
    KK_SERVER_LOG: path.join(dataDir, "server.log"),
    KK_PLANS_ENFORCED: setup.enforced ? "1" : "",
    KK_MAIL: setup.mail ? "1" : "",
    KK_BILLING_PROVIDER: setup.provider ?? "",
    KK_BILLING_API_BASE: setup.apiBase ?? standinBase,
    KK_BILLING_API_KEY: setup.apiKey ?? API_KEY,
    KK_BILLING_WEBHOOK_SECRET: setup.secrets?.[0] ?? SECRET,
    KK_BILLING_WEBHOOK_SECRET_OLD: setup.secrets?.[1] ?? "",
    KK_BILLING_LOOK_SCHEDULE: "",
  };
  delete env.KK_BILLING_PRICE_PREMIUM;
  delete env.KK_BILLING_PRICE_FAMILIES;
  if (setup.premium !== null) env.KK_BILLING_PRICE_PREMIUM = setup.premium ?? PREMIUM;
  if (setup.families !== null) env.KK_BILLING_PRICE_FAMILIES = setup.families ?? FAMILIES;
  return env;
}

/** Starts a server of the test's own, with the admin page on, and signs the operator in. */
async function startServer(
  playwright: { request: { newContext(options: object): Promise<APIRequestContext> } },
  port: string,
  setup: ServerSetup,
): Promise<StripeServer> {
  const adminToken = randomBytes(32).toString("base64url");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-e2e-stripe-"));
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
  // server.mjs names the log for the kind of side server it is.
  const log = path.join(dataDir, setup.mail ? "server-mail.log" : "server-restart.log");
  return { port, process: child, dataDir, log, admin };
}

async function stopServer(server: StripeServer | undefined) {
  if (!server) {
    return;
  }
  await server.admin.dispose();
  const exited = new Promise((resolve) => server.process.once("exit", resolve));
  server.process.kill("SIGTERM");
  await exited;
  fs.rmSync(server.dataDir, { recursive: true, force: true });
}

/** How a server set up a way ends: its exit code, or null for one that starts. */
async function exitOf(port: string, setup: ServerSetup): Promise<number | null> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-e2e-stripe-refused-"));
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

/** Reads (or with `write`, changes) a server's SQLite database. */
async function database(server: StripeServer) {
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

/** The caller's own plan, an organization's, or an MSP's, as `GET /api/keykeeper/plan` answers it. */
async function planOf(api: Api, as: Account, query = ""): Promise<any> {
  const answer = await api.call(as, "GET", `/api/keykeeper/plan${query}`);
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body;
}

/** A webhook as anyone could send one: these bytes, and this signature header (or none). */
async function webhook(request: APIRequestContext, port: string, body: string, header: string | null, provider = "stripe") {
  return result(
    await request.post(`https://127.0.0.1:${port}/api/keykeeper/billing/events/${provider}`, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...(header === null ? {} : { "Stripe-Signature": header }),
      },
      data: body,
    }),
  );
}

/** A snapshot event, as Stripe's reference shows one, about `object`. */
const snapshot = (type: string, object: object, extra: object = {}) =>
  JSON.stringify({
    id: `evt_${randomBytes(12).toString("hex")}`,
    object: "event",
    api_version: VERSION,
    created: secondsFromNow(0),
    data: { object },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    ...extra,
  });

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
/** A browser of sorts, for the stand-in's pages, over their throwaway certificate. */
let browser: APIRequestContext;

test.beforeAll(async ({ playwright }) => {
  standinProcess = spawn(process.execPath, ["stripe-standin.mjs"], {
    cwd: e2eDir,
    env: {
      ...process.env,
      KK_STRIPE_STANDIN_PORT: stripeStandinPort,
      KK_STRIPE_STANDIN_PAGES_PORT: stripeStandinPagesPort,
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
    .poll(async () => (await standinHttp.get(`${standinBase}/alive`).catch(() => null))?.status() ?? 0, {
      timeout: 30_000,
    })
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

test.describe("where plans are enforced and Stripe is the payment provider", () => {
  test.use({ baseURL: `https://127.0.0.1:${stripeServerPort}` });

  let server: StripeServer | undefined;
  const vault = `https://127.0.0.1:${stripeServerPort}/#`;

  test.beforeAll(async ({ playwright }) => {
    // It sends email, to the mail catcher, for the emailed way to delete an account.
    server = await startServer(playwright, stripeServerPort, { enforced: true, provider: "stripe", mail: true });
  });

  test.afterAll(async () => {
    await stopServer(server);
  });

  /** Someone who has paid for Premium on Stripe's page, and the plan the server then has. */
  async function paidPerson(api: Api, prefix: string) {
    const person = await api.account(prefix);
    const paid = await api.call(person, "POST", "/api/keykeeper/plan/pay", { plan: "premium" });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    await press(browser, paid.body.url);
    await expect.poll(async () => (await planOf(api, person)).state).toBe("active");
    const customer = await stripe.customerOf(`user_${person.userId}`);
    const [subscription] = await stripe.subscriptionsOf(customer);
    return { person, customer, subscription };
  }

  /** An organization whose owner has paid for Families on Stripe's page. */
  async function paidFamily(api: Api, prefix: string) {
    const owner = await api.account(prefix);
    const orgId = await api.organization(owner, `${prefix} family`);
    const paid = await api.call(owner, "POST", "/api/keykeeper/plan/pay", { organization: orgId, plan: "families" });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    await press(browser, paid.body.url);
    await expect.poll(async () => (await planOf(api, owner, `?organization=${orgId}`)).plan).toBe("families");
    const customer = await stripe.customerOf(`organization_${orgId}`);
    const [subscription] = await stripe.subscriptionsOf(customer);
    return { owner, orgId, customer, subscription };
  }

  test("paying for Premium: Stripe's Checkout, its webhooks, a look, and the plan in the sync, each request as Stripe takes it", async ({
    request,
  }) => {
    const api = new Api(request);
    const person = await api.account("stripe-premium");
    expect(await planOf(api, person)).toMatchObject({ plan: "free", state: null, canManage: true, canPay: true });

    const before = (await stripe.calls()).length;
    const paid = await api.call(person, "POST", "/api/keykeeper/plan/pay", { plan: "premium" });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(Object.keys(paid.body)).toEqual(["url"]);
    expect(paid.body.url).toMatch(new RegExp(`^${pagesBase}/c/pay/cs_test_`));

    // A customer, then a Checkout Session, and nothing else: form-encoded,
    // with the key as a bearer and the pinned version.
    const calls = await stripe.callsSince(before);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /v1/customers", "POST /v1/checkout/sessions"]);
    for (const call of calls) {
      expect(call).toMatchObject({
        bearer: true,
        version: VERSION,
        contentType: "application/x-www-form-urlencoded",
        query: {},
        idempotencyKey: null,
      });
    }
    const whose = `user_${person.userId}`;
    expect(calls[0].form).toEqual({ "metadata[whose]": whose });
    const customer = await stripe.customerOf(whose);
    const back = `${vault}/settings/plan`;
    expect(calls[1].form).toEqual({
      mode: "subscription",
      customer,
      client_reference_id: whose,
      "line_items[0][price]": PREMIUM,
      "line_items[0][quantity]": "1",
      "subscription_data[metadata][whose]": whose,
      "subscription_data[metadata][plan]": "premium",
      success_url: back,
      cancel_url: back,
    });
    // Nothing changes until Stripe says so.
    expect(await planOf(api, person)).toMatchObject({ plan: "free" });

    // Subscribing on Stripe's page comes back to the Plan page, and Stripe's
    // webhooks make the server look.
    const pay = await press(browser, paid.body.url);
    expect(pay.html).toContain(`href="${back}"`);
    expect(pay.location).toBe(back);
    await expect.poll(async () => (await planOf(api, person)).state).toBe("active");
    const [subscription] = await stripe.subscriptionsOf(customer);
    expect(subscription).toMatchObject({ status: "active", metadata: { whose, plan: "premium" } });
    const plan = await planOf(api, person);
    expect(plan).toMatchObject({ plan: "premium", state: "active", renews: true, canPay: true });
    expect(moment(plan.until)).toBe(subscription.items.data[0].current_period_end * SECOND);

    // Looking is reading the customer's subscriptions, in every status, 100 at a time.
    const looks = (await stripe.callsSince(before)).filter((c) => c.method === "GET");
    expect(looks.length).toBeGreaterThan(0);
    for (const look of looks) {
      expect(look).toMatchObject({
        path: "/v1/subscriptions",
        query: { customer, status: "all", limit: "100" },
        form: {},
        bearer: true,
        version: VERSION,
      });
    }

    // The sync says so, and the operator sees Stripe set it, with its ids.
    const profile = (await api.call(person, "GET", "/api/sync?excludeDomains=true")).body.profile;
    expect(profile.premium).toBe(true);
    expect(profile.keykeeperPlan).toEqual(plan);
    const read = await result(await server!.admin.get(`/admin/plans/users/${person.userId}`));
    expect(read.body.plan).toMatchObject({
      plan: "premium",
      standing: "until",
      setBy: "provider",
      provider: "stripe",
      providerCustomer: customer,
      providerSubscription: subscription.id,
      billed: "prepaid",
    });

    // Managing is Stripe's customer portal, which comes back to the Plan page.
    const portalBefore = (await stripe.calls()).length;
    const managed = await api.call(person, "POST", "/api/keykeeper/plan/manage", {});
    expect(managed.status, JSON.stringify(managed.body)).toBe(200);
    expect(managed.body.url).toMatch(new RegExp(`^${pagesBase}/p/session/`));
    const portal = await stripe.callsSince(portalBefore);
    expect(portal.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /v1/billing_portal/sessions"]);
    expect(portal[0]).toMatchObject({
      form: { customer, return_url: back },
      bearer: true,
      version: VERSION,
      contentType: "application/x-www-form-urlencoded",
    });
  });

  test("paying for Families, for an organization's owner; Business and an MSP's pool aren't paid for online yet", async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const api = new Api(request);
    const owner = await api.account("stripe-families");
    const orgId = await api.organization(owner, "Stripe Families Org");
    expect(await planOf(api, owner, `?organization=${orgId}`)).toMatchObject({
      plan: "business",
      state: "trial",
      canPay: true,
    });

    const before = (await stripe.calls()).length;
    const paid = await api.call(owner, "POST", "/api/keykeeper/plan/pay", { organization: orgId, plan: "families" });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const whose = `organization_${orgId}`;
    const checkout = (await stripe.callsSince(before)).find((c) => c.path === "/v1/checkout/sessions")!;
    expect(checkout.form).toMatchObject({
      client_reference_id: whose,
      "line_items[0][price]": FAMILIES,
      "subscription_data[metadata][whose]": whose,
      "subscription_data[metadata][plan]": "families",
      success_url: `${vault}/organizations/${orgId}/plan`,
    });
    expect((await press(browser, paid.body.url)).location).toBe(`${vault}/organizations/${orgId}/plan`);
    await expect.poll(async () => (await planOf(api, owner, `?organization=${orgId}`)).plan).toBe("families");
    expect(await planOf(api, owner, `?organization=${orgId}`)).toMatchObject({
      plan: "families",
      state: "active",
      renews: true,
      people: 6,
    });
    // The family's place in the owner's sync: six people, as upstream's Families.
    const entry = (await api.call(owner, "GET", "/api/sync?excludeDomains=true")).body.profile.organizations.find(
      (o: { id: string }) => o.id === orgId,
    );
    expect(entry).toMatchObject({ usersGetPremium: true, seats: 6, productTierType: 1 });

    // Business is billed by the day after each month (piece 10): not online yet,
    // and Stripe is asked nothing.
    const business = await api.organization(owner, "Stripe Business Org");
    const mspAdmin = await api.account("stripe-pool");
    const mspId = await api.msp(mspAdmin, "Stripe Pool MSP");
    const asked = (await stripe.calls()).length;
    expect(await api.call(owner, "POST", "/api/keykeeper/plan/pay", { organization: business, plan: "business" })).toEqual({
      status: 400,
      body: expect.objectContaining({ message: "Business can't be paid for online yet." }),
    });
    expect(await api.call(mspAdmin, "POST", "/api/keykeeper/plan/pay", { msp: mspId, plan: "msp" })).toEqual({
      status: 400,
      body: expect.objectContaining({ message: "An MSP's plan can't be paid for online yet." }),
    });
    expect((await stripe.calls()).length).toBe(asked);
    expect(await planOf(api, owner, `?organization=${business}`)).toMatchObject({ plan: "business", state: "trial" });
  });

  test("someone Stripe already bills gets the customer portal, never a second checkout, even before Stripe's webhook comes", async ({
    request,
  }) => {
    const api = new Api(request);
    // Paid, and the plan shows it: asking to pay again, as a page left open would.
    const { person, customer } = await paidPerson(api, "stripe-twice");
    const before = (await stripe.calls()).length;
    for (const plan of ["premium", "premium"]) {
      const again = await api.call(person, "POST", "/api/keykeeper/plan/pay", { plan });
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      expect(again.body.url).toMatch(new RegExp(`^${pagesBase}/p/session/`));
    }
    const calls = await stripe.callsSince(before);
    expect(calls.filter((c) => c.path === "/v1/checkout/sessions")).toEqual([]);
    expect(calls.filter((c) => c.path === "/v1/billing_portal/sessions").length).toBe(2);
    expect(await stripe.subscriptionsOf(customer)).toHaveLength(1);

    // Paid at Stripe, and no webhook has come: the server asks Stripe before
    // making a checkout, and sends them to the portal.
    const early = await api.account("stripe-twice-early");
    const first = await api.call(early, "POST", "/api/keykeeper/plan/pay", { plan: "premium" });
    expect(first.status).toBe(200);
    const earlyCustomer = await stripe.customerOf(`user_${early.userId}`);
    await stripe.make({ customer: earlyCustomer, subscription: { price: PREMIUM, metadata: { plan: "premium" } } });
    expect(await planOf(api, early)).toMatchObject({ plan: "free" });
    const sessions = (await stripe.calls()).filter((c) => c.path === "/v1/checkout/sessions").length;
    const second = await api.call(early, "POST", "/api/keykeeper/plan/pay", { plan: "premium" });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.url).toMatch(new RegExp(`^${pagesBase}/p/session/`));
    expect((await stripe.calls()).filter((c) => c.path === "/v1/checkout/sessions").length).toBe(sessions);
    expect(await planOf(api, early)).toMatchObject({ plan: "premium", state: "active" });

    // An organization paying for Families, asked to pay for Business: the portal too.
    const { owner, orgId } = await paidFamily(api, "stripe-twice-family");
    const other = await api.call(owner, "POST", "/api/keykeeper/plan/pay", { organization: orgId, plan: "business" });
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    expect(other.body.url).toMatch(new RegExp(`^${pagesBase}/p/session/`));
  });

  test("a payment that fails goes into grace from the end of the last period paid, and paying again ends it", async ({
    request,
  }) => {
    const api = new Api(request);
    const { person, customer, subscription } = await paidPerson(api, "stripe-past-due");
    // The renewal failed: Stripe's new period began two days ago, unpaid, and it retries.
    const start = secondsFromNow(-2 * DAY);
    const end = secondsFromNow(363 * DAY);
    await stripe.change(subscription.id, { status: "past_due", current_period_start: start, current_period_end: end });
    expect((await stripe.send({ type: "invoice.payment_failed", object: { id: "in_failed", object: "invoice", customer } })).status).toBe(200);
    await expect.poll(async () => (await planOf(api, person)).state).toBe("paymentDue");
    const due = await planOf(api, person);
    expect(due).toMatchObject({ plan: "premium", renews: true });
    expect(moment(due.until)).toBe(start * SECOND);
    expect(moment(due.endsAt)).toBe(start * SECOND + 14 * DAY);
    // Premium's features stay through grace.
    expect((await api.call(person, "GET", "/api/sync?excludeDomains=true")).body.profile.premium).toBe(true);
    // In grace, paying again is the portal, to fix the card.
    const again = await api.call(person, "POST", "/api/keykeeper/plan/pay", { plan: "premium" });
    expect(again.body.url).toMatch(new RegExp(`^${pagesBase}/p/session/`));

    // The retry worked.
    await stripe.change(subscription.id, { status: "active" });
    expect((await stripe.send({ type: "invoice.paid", object: { id: "in_paid", object: "invoice", customer } })).status).toBe(200);
    await expect.poll(async () => (await planOf(api, person)).state).toBe("active");
    expect(moment((await planOf(api, person)).until)).toBe(end * SECOND);
  });

  test("canceling in Stripe's portal: the plan says it ends on its date, and ends when Stripe says it's over", async ({
    request,
  }) => {
    const api = new Api(request);
    const { person, customer, subscription } = await paidPerson(api, "stripe-cancel");
    const until = (await planOf(api, person)).until;
    const managed = await api.call(person, "POST", "/api/keykeeper/plan/manage", {});
    expect((await press(browser, managed.body.url)).location).toBe(`${vault}/settings/plan`);
    await expect.poll(async () => (await planOf(api, person)).renews).toBe(false);
    const canceled = await planOf(api, person);
    expect(canceled).toMatchObject({ state: "active", until });
    // No grace after a plan someone canceled: it ends on its date.
    expect(canceled.endsAt).toBe(until);
    expect((await stripe.subscriptionsOf(customer))[0].cancel_at_period_end).toBe(true);

    // The period ends, and Stripe ends the subscription.
    await stripe.change(subscription.id, { status: "canceled", ended_at: secondsFromNow(0) });
    expect((await stripe.send({ type: "customer.subscription.deleted", subscription: subscription.id })).status).toBe(200);
    await expect.poll(async () => (await planOf(api, person)).state).toBe("ended");
    expect((await api.call(person, "GET", "/api/sync?excludeDomains=true")).body.profile.premium).toBe(false);
    // Over, they can pay again: a new checkout.
    const again = await api.call(person, "POST", "/api/keykeeper/plan/pay", { plan: "premium" });
    expect(again.body.url).toMatch(new RegExp(`^${pagesBase}/c/pay/`));
  });

  test("each of a subscription's statuses, read by the design's table, and one the server doesn't know leaves the plan as it was", async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const api = new Api(request);
    const { person, subscription } = await paidPerson(api, "stripe-statuses");
    const after = async (status: string) => {
      const looks = await stripe.looksAt(subscription.customer);
      await stripe.change(subscription.id, { status });
      expect((await stripe.send({ subscription: subscription.id })).status).toBe(200);
      await expect.poll(() => stripe.looksAt(subscription.customer)).toBe(looks + 1);
      return planOf(api, person);
    };
    expect(await after("trialing")).toMatchObject({ plan: "premium", state: "active" });
    for (const status of ["unpaid", "paused", "incomplete_expired", "canceled"]) {
      expect(await after(status), status).toMatchObject({ plan: "premium", state: "ended" });
      expect(await after("active"), `${status}, then active`).toMatchObject({ plan: "premium", state: "active" });
    }
    // A status this server doesn't know: no answer, so the last one stands.
    const before = await planOf(api, person);
    expect(await after("on_hold")).toEqual(before);
    // A first payment that never finished is nothing yet: Free, for someone new.
    const fresh = await api.account("stripe-incomplete");
    expect((await api.call(fresh, "POST", "/api/keykeeper/plan/pay", { plan: "premium" })).status).toBe(200);
    const freshCustomer = await stripe.customerOf(`user_${fresh.userId}`);
    const { subscription: incomplete } = await stripe.make({
      customer: freshCustomer,
      subscription: { price: PREMIUM, status: "incomplete" },
    });
    expect((await stripe.send({ subscription: incomplete!.id })).status).toBe(200);
    await expect.poll(() => stripe.looksAt(freshCustomer)).toBe(1);
    expect(await planOf(api, fresh)).toMatchObject({ plan: "free", state: null });
  });

  test("webhooks: Stripe's signature over the bytes, snapshot events only, and the other mode dropped", async ({ request }) => {
    const api = new Api(request);
    const { customer, subscription } = await paidPerson(api, "stripe-webhooks");
    const object = { id: subscription.id, object: "subscription", customer, status: "active" };
    const body = snapshot("customer.subscription.updated", object);
    const now = secondsFromNow(0);
    const sign = (secrets: string[], what = body, at = now) => stripeSignature(secrets, what, at);
    const thin = JSON.stringify({
      id: `evt_${randomBytes(12).toString("hex")}`,
      object: "v2.core.event",
      type: "v1.customer.subscription.updated",
      livemode: false,
      created: new Date().toISOString(),
      related_object: { id: subscription.id, type: "subscription", url: `/v1/subscriptions/${subscription.id}` },
    });
    const changed = body.replace(customer, `${customer.slice(0, -1)}${customer.endsWith("0") ? "1" : "0"}`);
    const looks = await stripe.looksAt(customer);
    for (const [what, sent, header] of [
      ["a secret not in use", body, sign([NOT_OURS])],
      ["the API key as the secret", body, sign([API_KEY])],
      ["a body changed by one byte", changed, sign([SECRET])],
      ["only Stripe's fake v0", body, sign([SECRET]).replace(/v1=[0-9a-f]+,/, "")],
      ["six minutes old", body, sign([SECRET], body, now - 360)],
      ["no signature", body, null],
      ["a thin event, which this endpoint isn't set to take", thin, stripeSignature([SECRET], thin)],
    ] as [string, string, string | null][]) {
      expect(await webhook(request, stripeServerPort, sent, header), what).toEqual({ status: 400, body: null });
    }
    expect(await stripe.looksAt(customer)).toBe(looks);

    // The stand-in's route isn't this server's.
    const nowhere = await api.call(null, "POST", `/api/keykeeper/no-such-route-${randomUUID()}`);
    expect(await webhook(request, stripeServerPort, body, sign([SECRET]), "standin")).toEqual(nowhere);

    // Signed with the secret in use, with Stripe's v0 and debugging entries beside it: a look.
    expect(await webhook(request, stripeServerPort, body, sign([SECRET]))).toEqual({ status: 200, body: null });
    await expect.poll(() => stripe.looksAt(customer)).toBe(looks + 1);
    // A live event on a server whose key is a test one: answered, and dropped.
    const live = snapshot("customer.subscription.updated", object, { livemode: true });
    expect(await webhook(request, stripeServerPort, live, stripeSignature([SECRET], live))).toEqual({ status: 200, body: null });
    // An event about the customer itself.
    const about = snapshot("customer.updated", { id: customer, object: "customer", email: null });
    expect(await webhook(request, stripeServerPort, about, stripeSignature([SECRET], about))).toEqual({ status: 200, body: null });
    await expect.poll(() => stripe.looksAt(customer)).toBe(looks + 2);
    // The old secret isn't in use on this server.
    expect((await stripe.send({ subscription: subscription.id, secrets: [OLD_SECRET] })).status).toBe(400);
  });

  test("each way an account is deleted cancels what Stripe bills for it at once: the person's own, by email, and the admin page's", async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const api = new Api(request);
    /** Whether Stripe canceled the subscription, at once, with a DELETE and nothing in it. */
    const canceledAtOnce = async (before: number, subscription: Subscription) => {
      const cancels = (await stripe.callsSince(before)).filter((c) => c.method === "DELETE");
      expect(cancels).toEqual([
        expect.objectContaining({ path: `/v1/subscriptions/${subscription.id}`, form: {}, query: {}, bearer: true, version: VERSION }),
      ]);
      expect((await stripe.subscriptionsOf(subscription.customer))[0].status).toBe("canceled");
    };

    // The person's own, by either of the routes the apps use.
    for (const [prefix, method, route] of [
      ["stripe-delete-own", "DELETE", "/api/accounts"],
      ["stripe-delete-own-post", "POST", "/api/accounts/delete"],
    ] as const) {
      const { person, subscription } = await paidPerson(api, prefix);
      const before = (await stripe.calls()).length;
      const deleted = await api.call(person, method, route, { masterPasswordHash: person.password });
      expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
      await canceledAtOnce(before, subscription);
      expect((await api.call(person, "GET", "/api/accounts/profile")).status).toBe(401);
    }

    // By the link in the email, for someone who can't sign in.
    {
      const { person, subscription } = await paidPerson(api, "stripe-delete-email");
      expect((await api.call(null, "POST", "/api/accounts/delete-recover", { email: person.email })).status).toBe(200);
      const message = await waitForMessage(person.email, /Delete Your Account/i);
      const link = /verify-recover-delete\?(\S+)/.exec(message.text)?.[1];
      expect(link, message.text).toBeTruthy();
      const params = new URLSearchParams(link!);
      const before = (await stripe.calls()).length;
      const deleted = await api.call(null, "POST", "/api/accounts/delete-recover-token", {
        userId: params.get("userId"),
        token: params.get("token"),
      });
      expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
      await canceledAtOnce(before, subscription);
    }

    // The admin page's.
    {
      const { person, subscription } = await paidPerson(api, "stripe-delete-admin");
      const before = (await stripe.calls()).length;
      const deleted = await server!.admin.post(`/admin/users/${person.userId}/delete`, { data: {} });
      expect(deleted.status(), await deleted.text()).toBe(200);
      await canceledAtOnce(before, subscription);
    }

    // Someone who opened Stripe's page and never paid: Stripe is asked, and has nothing to cancel.
    const browsed = await api.account("stripe-delete-browsed");
    expect((await api.call(browsed, "POST", "/api/keykeeper/plan/pay", { plan: "premium" })).status).toBe(200);
    const browsedCustomer = await stripe.customerOf(`user_${browsed.userId}`);
    let before = (await stripe.calls()).length;
    expect((await api.call(browsed, "DELETE", "/api/accounts", { masterPasswordHash: browsed.password })).status).toBe(200);
    const asked = await stripe.callsSince(before);
    expect(asked.map((c) => `${c.method} ${c.path} ${c.query.customer ?? ""}`)).toEqual([
      `GET /v1/subscriptions ${browsedCustomer}`,
    ]);
    // Someone Stripe never heard of: Stripe isn't asked at all.
    const stranger = await api.account("stripe-delete-stranger");
    before = (await stripe.calls()).length;
    expect((await api.call(stranger, "DELETE", "/api/accounts", { masterPasswordHash: stranger.password })).status).toBe(200);
    expect(await stripe.callsSince(before)).toEqual([]);
  });

  test("each way an organization is deleted cancels what Stripe bills for it at once: its owner, the admin page, and its MSP", async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const api = new Api(request);
    const canceledAtOnce = async (before: number, subscription: Subscription) => {
      const cancels = (await stripe.callsSince(before)).filter((c) => c.method === "DELETE");
      expect(cancels.map((c) => c.path)).toEqual([`/v1/subscriptions/${subscription.id}`]);
      expect((await stripe.subscriptionsOf(subscription.customer))[0].status).toBe("canceled");
    };

    // Its owner.
    {
      const { owner, orgId, subscription } = await paidFamily(api, "stripe-delete-family");
      const before = (await stripe.calls()).length;
      const deleted = await api.call(owner, "DELETE", `/api/organizations/${orgId}`, { masterPasswordHash: owner.password });
      expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
      await canceledAtOnce(before, subscription);
      // The owner's own account goes on, with nothing of theirs canceled.
      expect((await api.call(owner, "GET", "/api/accounts/profile")).status).toBe(200);
    }

    // The admin page's.
    {
      const { orgId, subscription } = await paidFamily(api, "stripe-delete-family-admin");
      const before = (await stripe.calls()).length;
      const deleted = await server!.admin.post(`/admin/organizations/${orgId}/delete`, { data: {} });
      expect(deleted.status(), await deleted.text()).toBe(200);
      await canceledAtOnce(before, subscription);
    }

    // An MSP deleting a client run only by it. A client's plan is its MSP's
    // pool, so nothing makes an organization that paid Stripe into a client
    // yet; this one paid before the MSP took it on, which the server's own
    // record of Stripe's customers says, written here.
    {
      const mspAdmin = await api.account("stripe-delete-msp");
      const mspId = await api.msp(mspAdmin, "Stripe Delete MSP");
      const clientId = await api.client(mspAdmin, mspId, "Stripe Delete Client");
      const { customer, subscription } = await stripe.make({
        metadata: { whose: `organization_${clientId}` },
        subscription: { price: FAMILIES, metadata: { plan: "families" } },
        server: `https://127.0.0.1:${stripeServerPort}`,
      });
      const db = await database(server!);
      expect(
        db.write(
          "INSERT INTO billing_customers (provider, customer, org_uuid, created_at) VALUES (?, ?, ?, ?)",
          "stripe",
          customer.id,
          clientId,
          new Date().toISOString().replace("T", " ").replace("Z", ""),
        ),
      ).toBe(1);
      const before = (await stripe.calls()).length;
      const deleted = await api.call(mspAdmin, "DELETE", `/api/organizations/${clientId}`, {
        masterPasswordHash: mspAdmin.password,
      });
      expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
      await canceledAtOnce(before, subscription!);
      // The record went with the organization.
      expect(db.count("SELECT COUNT(*) FROM billing_customers WHERE org_uuid = ?", clientId)).toBe(0);
    }
  });

  test("Stripe unreachable: the plan stays as it was, and deleting still works and tells the operator", async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const api = new Api(request);
    const { person, customer, subscription } = await paidPerson(api, "stripe-down");
    const family = await paidFamily(api, "stripe-down-family");
    const before = await planOf(api, person);
    try {
      await stripe.refuse(true);
      // Over at Stripe, which can't be asked: nothing ends on a guess.
      await stripe.change(subscription.id, { status: "canceled" });
      const looked = await api.call(person, "POST", "/api/keykeeper/plan/look", {});
      expect(looked.status).toBe(200);
      expect(looked.body).toEqual(before);
      for (const [route, data] of [
        ["pay", { plan: "premium" }],
        ["manage", {}],
      ] as const) {
        const page = await api.call(person, "POST", `/api/keykeeper/plan/${route}`, data);
        expect(page, route).toEqual({ status: 400, body: expect.objectContaining({ message: UNREACHABLE }) });
      }
      expect(await planOf(api, person)).toEqual(before);
      await stripe.change(subscription.id, { status: "active" });

      // Deleting goes ahead, and the operator is told what to cancel by hand.
      const deleted = await api.call(person, "DELETE", "/api/accounts", { masterPasswordHash: person.password });
      expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
      expect((await api.call(person, "GET", "/api/accounts/profile")).status).toBe(401);
      const orgDeleted = await api.call(family.owner, "DELETE", `/api/organizations/${family.orgId}`, {
        masterPasswordHash: family.owner.password,
      });
      expect(orgDeleted.status, JSON.stringify(orgDeleted.body)).toBe(200);
      await expect
        .poll(() => fs.readFileSync(server!.log, "utf8"), { timeout: 15_000 })
        .toMatch(new RegExp(`\\[ERROR\\].*couldn't be asked to cancel what its customer ${customer} pays for`));
      expect(fs.readFileSync(server!.log, "utf8")).toMatch(
        new RegExp(`\\[ERROR\\].*couldn't be asked to cancel what its customer ${family.customer} pays for`),
      );
      // Still billing at Stripe, for the operator to cancel there.
      expect((await stripe.subscriptionsOf(customer))[0].status).toBe("active");
      expect((await stripe.subscriptionsOf(family.customer))[0].status).toBe("active");
    } finally {
      await stripe.refuse(false);
    }
  });

  test("Stripe's key and signing secret never reach a log or the admin page", async () => {
    const log = fs.readFileSync(server!.log, "utf8");
    expect(log.length).toBeGreaterThan(0);
    const pages = await Promise.all(
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
    expect(pages[1]).toMatch(/"billing_provider":\s*"stripe"/);
  });
});

test.describe("while Stripe's signing secret is rolled", () => {
  test.use({ baseURL: `https://127.0.0.1:${stripeReplaceServerPort}` });

  let server: StripeServer | undefined;

  test.beforeAll(async ({ playwright }) => {
    server = await startServer(playwright, stripeReplaceServerPort, {
      enforced: true,
      provider: "stripe",
      secrets: [SECRET, OLD_SECRET],
    });
  });

  test.afterAll(async () => {
    await stopServer(server);
  });

  test("a webhook signed with the old secret, the new one, or both is taken, and no other", async ({ request }) => {
    const api = new Api(request);
    const person = await api.account("stripe-roll");
    const paid = await api.call(person, "POST", "/api/keykeeper/plan/pay", { plan: "premium" });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    // Subscribed at Stripe, and no webhook yet: each one below is what makes the server look.
    const customer = await stripe.customerOf(`user_${person.userId}`);
    const { subscription } = await stripe.make({ customer, subscription: { price: PREMIUM } });
    let looks = await stripe.looksAt(customer);
    for (const [what, secrets, status] of [
      ["the old secret alone", [OLD_SECRET], 200],
      ["both, as Stripe signs while both are in use", [SECRET, OLD_SECRET], 200],
      ["the new secret alone", [SECRET], 200],
      ["a secret not in use beside the old one", [NOT_OURS, OLD_SECRET], 200],
      ["a secret not in use", [NOT_OURS], 400],
    ] as [string, string[], number][]) {
      expect((await stripe.send({ subscription: subscription!.id, secrets })).status, what).toBe(status);
      if (status === 200) {
        looks += 1;
        await expect.poll(() => stripe.looksAt(customer), { message: what }).toBe(looks);
      }
    }
    expect(await planOf(api, person)).toMatchObject({ plan: "premium", state: "active" });
    expect(await stripe.looksAt(customer)).toBe(looks);
  });
});

/** The same request on the main test server, which has no provider and doesn't enforce plans. */
async function onMainServer(playwright: { request: { newContext(options: object): Promise<APIRequestContext> } }) {
  return playwright.request.newContext({ baseURL: `https://127.0.0.1:${mainPort}`, ignoreHTTPSErrors: true });
}

/** A request's answer, byte for byte. */
async function raw(api: APIRequestContext, as: Account | null, method: string, route: string, data?: unknown) {
  const response = await api.fetch(route, {
    method,
    data,
    headers: as ? { Authorization: `Bearer ${as.token}` } : {},
  });
  return { status: response.status(), text: await response.text() };
}

/** What a sync says about plans, which nothing here may change. */
function planFields(profile: any) {
  const org = (o: any) => ({
    keykeeperPlan: o.keykeeperPlan,
    usersGetPremium: o.usersGetPremium,
    maxStorageGb: o.maxStorageGb,
    seats: o.seats,
    productTierType: o.productTierType,
    enabled: o.enabled,
    uses: Object.fromEntries(Object.entries(o).filter(([key]) => /^use[A-Z]/.test(key))),
  });
  return {
    premium: profile.premium,
    premiumFromOrganization: profile.premiumFromOrganization,
    keykeeperPlan: profile.keykeeperPlan,
    organizations: profile.organizations.map(org),
  };
}

for (const [title, port, setup] of [
  ["where Stripe is set and plans aren't enforced", stripeOffServerPort, { enforced: false, provider: "stripe" }],
  ["where plans are enforced and no payment provider is set", stripeNoProviderServerPort, { enforced: true }],
] as [string, string, ServerSetup][]) {
  test.describe(title, () => {
    test.use({ baseURL: `https://127.0.0.1:${port}` });

    let server: StripeServer | undefined;

    test.beforeAll(async ({ playwright }) => {
      server = await startServer(playwright, port, setup);
    });

    test.afterAll(async () => {
      await stopServer(server);
    });

    test("nothing is asked of Stripe, and paying, webhooks, and deleting answer as they always have", async ({
      playwright,
      request,
    }) => {
      const main = await onMainServer(playwright);
      try {
        const here = new Api(request);
        const there = new Api(main);
        const before = (await stripe.calls()).length;
        const [person, otherPerson] = [await here.account("stripe-unset"), await there.account("stripe-unset")];
        const [orgId, otherOrgId] = [
          await here.organization(person, "Stripe Unset Org"),
          await there.organization(otherPerson, "Stripe Unset Org"),
        ];

        // No route to pay, manage, or look, and no webhook route: the 404 of any path this server doesn't have.
        const nowhere = await raw(request, person, "POST", `/api/keykeeper/no-such-route-${randomUUID()}`);
        expect(nowhere.status).toBe(404);
        for (const [route, data] of [
          ["/api/keykeeper/plan/pay", { plan: "premium" }],
          ["/api/keykeeper/plan/manage", {}],
          ["/api/keykeeper/plan/look", {}],
        ] as const) {
          expect(await raw(request, person, "POST", route, data), route).toEqual(nowhere);
        }
        const body = snapshot("customer.subscription.updated", { id: "sub_1", object: "subscription", customer: "cus_1" });
        for (const provider of ["stripe", "standin"]) {
          const answer = await request.post(`/api/keykeeper/billing/events/${provider}`, {
            headers: { "Stripe-Signature": stripeSignature([SECRET], body) },
            data: body,
          });
          expect({ status: answer.status(), text: await answer.text() }, provider).toEqual({
            status: 404,
            text: (await raw(request, null, "POST", `/api/keykeeper/no-such-route-${randomUUID()}`)).text,
          });
        }

        if (!setup.enforced) {
          // Plans aren't enforced: the plan and the sync, byte for byte as on a
          // server with nothing set.
          const plan = await raw(request, person, "GET", "/api/keykeeper/plan");
          expect(plan).toEqual(await raw(main, otherPerson, "GET", "/api/keykeeper/plan"));
          expect(plan).toEqual({ status: 200, text: '{"enforced":false}' });
          const sync = (await here.call(person, "GET", "/api/sync?excludeDomains=true")).body.profile;
          const otherSync = (await there.call(otherPerson, "GET", "/api/sync?excludeDomains=true")).body.profile;
          expect(planFields(sync)).toEqual(planFields(otherSync));
        }

        // Deleting an organization and an account, byte for byte as on a server
        // with nothing set, and nothing asked of Stripe.
        const deletedOrg = await raw(request, person, "DELETE", `/api/organizations/${orgId}`, {
          masterPasswordHash: person.password,
        });
        expect(deletedOrg).toEqual(
          await raw(main, otherPerson, "DELETE", `/api/organizations/${otherOrgId}`, {
            masterPasswordHash: otherPerson.password,
          }),
        );
        expect(deletedOrg.status).toBe(200);
        const deleted = await raw(request, person, "DELETE", "/api/accounts", { masterPasswordHash: person.password });
        expect(deleted).toEqual(
          await raw(main, otherPerson, "DELETE", "/api/accounts", { masterPasswordHash: otherPerson.password }),
        );
        expect(deleted.status).toBe(200);
        expect(await stripe.callsSince(before)).toEqual([]);
        const db = await database(server!);
        expect(db.count("SELECT COUNT(*) FROM billing_customers")).toBe(0);
        expect(db.count("SELECT COUNT(*) FROM billing_events")).toBe(0);
        if (!setup.enforced) {
          expect(fs.readFileSync(server!.log, "utf8")).toContain("BILLING_PROVIDER does nothing while PLANS_ENFORCED is off.");
        }
      } finally {
        await main.dispose();
      }
    });
  });
}

test.describe("a server set up with Stripe wrong", () => {
  test("doesn't start: a full secret key, a live key beside a test address, an address off this machine, a missing or wrong price, or a signing secret that isn't one", async () => {
    test.setTimeout(300_000);
    const stripeSetup: ServerSetup = { enforced: true, provider: "stripe" };
    for (const [what, setup] of [
      ["the account's full secret key, in test mode", { apiKey: made("sk_test_") }],
      ["the account's full secret key, live", { apiKey: made("sk_live_"), apiBase: "" }],
      ["a publishable key", { apiKey: made("pk_test_") }],
      ["a live key beside BILLING_API_BASE", { apiKey: made("rk_live_") }],
      ["an address off this machine", { apiBase: "http://192.0.2.10:8128" }],
      ["a name for this machine", { apiBase: `http://localhost:${stripeStandinPort}` }],
      ["no Premium price", { premium: null }],
      ["no Families price", { families: null }],
      ["a product instead of a price", { premium: made("prod_") }],
      ["the same price for both plans", { families: PREMIUM }],
      ["a signing secret that isn't one", { secrets: [made("sk_test_")] }],
    ] as [string, Partial<ServerSetup>][]) {
      const code = await exitOf(stripeRefusedServerPort, { ...stripeSetup, ...setup });
      expect(code, what).not.toBeNull();
      expect(code, what).not.toBe(0);
    }
    // Set up right, it starts: a restricted test key and the stand-in. (No test
    // here ever gives the server Stripe's own address.)
    expect(await exitOf(stripeRefusedServerPort, stripeSetup)).toBeNull();
  });
});
