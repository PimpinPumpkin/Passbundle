// A stand-in for Stripe's API, for the tests of the server's Stripe adapter
// (passbundle-server, src/keykeeper_billing/stripe.rs; tests/api/stripe.spec.ts),
// as entra-standin.mjs is for Entra. It answers only the endpoints the adapter
// calls, in the shapes Stripe's API reference shows for the version the
// adapter pins (docs.stripe.com, read November 16, 2026), checks the
// Stripe-Version header and the key's Bearer, and sends webhooks signed with
// Stripe's published scheme under secrets made up for the run. Nothing here
// talks to Stripe, and it listens on 127.0.0.1 only. No dependencies.
//
// The adapter's calls, each with `Authorization: Bearer <KK_STRIPE_API_KEY>`
// and `Stripe-Version: <KK_STRIPE_VERSION>`, POSTs form-encoded:
//   POST   /v1/customers                -> a customer
//   GET    /v1/customers/<id>           -> the customer, with its default card for invoices
//   POST   /v1/customers/<id>           -> the customer, with a card of its made its default
//   POST   /v1/checkout/sessions        -> a Checkout Session, with its page's url
//                                         (subscription mode, or setup mode for a card)
//   GET    /v1/checkout/sessions        -> a page of a customer's Checkout Sessions,
//                                         each SetupIntent and its card expanded if asked
//   POST   /v1/billing_portal/sessions  -> a portal session, with its page's url
//   GET    /v1/subscriptions            -> a page of a customer's subscriptions
//   DELETE /v1/subscriptions/<id>       -> the subscription, canceled at once
//   GET    /v1/invoiceitems             -> a page of a customer's invoice items
//   POST   /v1/invoiceitems             -> an invoice item, for the customer's next invoice
//   GET    /v1/invoices                 -> a page of a customer's invoices
//   POST   /v1/invoices                 -> a draft invoice, taking the pending items if asked
// Anything else, a parameter Stripe wouldn't take, a wrong key, or another
// version is answered with Stripe's error shape and status. A POST with an
// `Idempotency-Key` is answered as the first one with that key was, as long
// as its parameters are the same, until a test says a day has passed.
//
// The pages it answers are on a port of their own, over HTTPS with a
// throwaway certificate, since the apps open only https pages: a Checkout
// page whose button pays for a year (the subscription goes active, and Stripe's
// webhooks are sent: checkout.session.completed and
// customer.subscription.created), or in setup mode saves a card to the
// customer (checkout.session.completed), and a
// portal whose button cancels at the period's end
// (customer.subscription.updated). Each goes back where the server asked.
//
// An invoice made with auto_advance waits for a test to say how Stripe's
// collection goes (/control/collect): finalized, then paid or failed on the
// card on file, with the webhook Stripe sends for it (invoice.paid or
// invoice.payment_failed). It sends only the events the server's endpoint is
// set to take (deploy/README.md, "Stripe").
//
// A test's controls (/control/...): reset, refuse every call, fail one kind
// of call before or after it's done, forget the idempotency keys (as a day
// passing does), read the calls made, the customers, the subscriptions, the
// invoice items, and the invoices, change a subscription, make a customer and
// a subscription directly, collect an invoice, take a card off a customer, and
// send a webhook.
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DAY = 86_400;
const YEAR = 365 * DAY;

/** Stripe's scheme: hex HMAC-SHA256 of the timestamp, a period, and the body, keyed with the secret as written. */
export function sign(secret, timestamp, body) {
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), Buffer.from(body)]))
    .digest("hex");
}

/**
 * A `Stripe-Signature` header for `body`, signed now (or at `timestamp`) with
 * each of `secrets`, as Stripe writes it for a sandbox event: a `v1` for each
 * secret in use, a fake `v0`, and its debugging entries, which a server must
 * ignore.
 */
export function stripeSignature(secrets, body, timestamp = Math.floor(Date.now() / 1000)) {
  return [
    `t=${timestamp}`,
    ...secrets.map((secret) => `v1=${sign(secret, timestamp, body)}`),
    `v0=${randomBytes(32).toString("hex")}`,
    "secret=whsec_****************************made",
    "destination=we_standin",
    `payload=${randomBytes(4).toString("hex")}`,
  ].join(",");
}

/** A certificate for the pages, made for this run and thrown away after. */
function throwawayCertificate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-stripe-standin-"));
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-keyout", key, "-out", cert, "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"],
    { stdio: "ignore" },
  );
  const pair = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  fs.rmSync(dir, { recursive: true, force: true });
  return pair;
}

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const now = () => Math.floor(Date.now() / 1000);

/** Starts the stand-in, with its pages on `pagesPort`. Resolves once both listen. */
export async function startStripeStandin({ port, pagesPort, apiKey, webhookSecrets, version, prices }) {
  const base = `http://127.0.0.1:${port}`;
  const pages = `https://127.0.0.1:${pagesPort}`;
  /** id -> customer object */
  const customers = new Map();
  /** id -> Checkout Session object */
  const sessions = new Map();
  /** id -> portal session object */
  const portals = new Map();
  /** id -> subscription object */
  const subscriptions = new Map();
  /** id -> SetupIntent object, made when a setup page's button is pressed */
  const setupIntents = new Map();
  /** id -> PaymentMethod object (a card) */
  const paymentMethods = new Map();
  /** id -> invoice item object */
  const invoiceItems = new Map();
  /** id -> invoice object */
  const invoices = new Map();
  /** Idempotency-Key -> { method, path, form, status, body }, the first answer for that key. */
  const idempotent = new Map();
  /** Calls to fail: { method, path, when: "before" | "after", times, forget }. */
  let failures = [];
  /** Every API call: { method, path, query, form, version, bearer, contentType }. */
  const calls = [];
  /**
   * Where each customer's webhooks go: the server that asked for its pages,
   * as if each server had its own endpoint set in Stripe's dashboard.
   */
  const hooks = new Map();
  const hookFor = (address) => `${new URL(address).origin}/api/keykeeper/billing/events/stripe`;
  let refuse = false;
  let next = 0;
  const id = (prefix) => `${prefix}_${(next += 1).toString(36)}${randomBytes(6).toString("hex")}`;

  const json = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Request-Id": id("req") });
    res.end(JSON.stringify(body));
  };
  /** Stripe's error shape. */
  const error = (res, status, type, message, extra = {}) => json(res, status, { error: { type, message, ...extra } });
  const missing = (res, what, value) =>
    error(res, 404, "invalid_request_error", `No such ${what}: '${value}'`, { code: "resource_missing", param: "id" });

  async function readBody(req) {
    let text = "";
    for await (const chunk of req) text += chunk;
    return text;
  }

  function subscriptionItem(subscription, price, start, end) {
    return {
      id: id("si"),
      object: "subscription_item",
      created: start,
      current_period_end: end,
      current_period_start: start,
      current_trial: null,
      metadata: {},
      price: { id: price, object: "price", active: true, currency: "usd", livemode: false, recurring: { interval: "year", interval_count: 1, usage_type: "licensed" }, type: "recurring" },
      quantity: 1,
      subscription,
      tax_rates: [],
    };
  }

  /** A subscription, as Stripe's reference shows the object. */
  function makeSubscription({ customer, price, status = "active", start = now(), end = start + YEAR, metadata = {} }) {
    const subscriptionId = id("sub");
    const subscription = {
      id: subscriptionId,
      object: "subscription",
      billing_cycle_anchor: start,
      cancel_at: null,
      cancel_at_period_end: false,
      canceled_at: null,
      cancellation_details: { comment: null, feedback: null, reason: null },
      collection_method: "charge_automatically",
      created: start,
      currency: "usd",
      customer,
      ended_at: null,
      items: {
        object: "list",
        data: [subscriptionItem(subscriptionId, price, start, end)],
        has_more: false,
        total_count: 1,
        url: `/v1/subscription_items?subscription=${subscriptionId}`,
      },
      latest_invoice: id("in"),
      livemode: false,
      metadata,
      start_date: start,
      status,
      trial_end: null,
      trial_start: null,
    };
    subscriptions.set(subscriptionId, subscription);
    return subscription;
  }

  function makeCustomer(metadata = {}) {
    const customer = {
      id: id("cus"),
      object: "customer",
      created: now(),
      email: null,
      invoice_settings: { custom_fields: null, default_payment_method: null, footer: null, rendering_options: null },
      livemode: false,
      metadata,
    };
    customers.set(customer.id, customer);
    return customer;
  }

  /** A snapshot event about `object`, as Stripe's reference shows the Event object. */
  function event(type, object, livemode = false) {
    return {
      id: id("evt"),
      object: "event",
      api_version: version,
      created: now(),
      data: { object },
      livemode,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type,
    };
  }

  /** Sends a webhook to the server, signed with `secrets` (the run's, unless a test says otherwise). */
  function send(url, body, secrets = webhookSecrets, timestamp = now()) {
    return new Promise((resolve, reject) => {
      const request = https.request(
        url,
        {
          method: "POST",
          rejectUnauthorized: false,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": Buffer.byteLength(body),
            "User-Agent": "Stripe/1.0 (+https://stripe.com/docs/webhooks)",
            "Stripe-Signature": stripeSignature(secrets, body, timestamp),
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve({ status: response.statusCode, id: JSON.parse(body).id }));
        },
      );
      request.on("error", reject);
      request.end(body);
    });
  }

  /** Sends the server that pays for `customer` an event, as Stripe would. */
  async function sendEvent(type, object, customer) {
    const url = hooks.get(customer);
    if (url === undefined) {
      return null;
    }
    return send(url, JSON.stringify(event(type, object)));
  }

  /** Changes a subscription the way a test asks: its status, dates, cancellation, or price. */
  function change(subscription, changes) {
    for (const field of ["status", "cancel_at", "cancel_at_period_end", "canceled_at", "ended_at", "metadata"]) {
      if (field in changes) {
        subscription[field] = changes[field];
      }
    }
    const item = subscription.items.data[0];
    if ("current_period_start" in changes) item.current_period_start = changes.current_period_start;
    if ("current_period_end" in changes) item.current_period_end = changes.current_period_end;
    if ("price" in changes) item.price.id = changes.price;
    return subscription;
  }

  async function control(req, res, url) {
    const path = url.pathname;
    const read = async () => {
      const text = await readBody(req);
      return text ? JSON.parse(text) : {};
    };
    if (path === "/control/reset" && req.method === "POST") {
      customers.clear();
      hooks.clear();
      sessions.clear();
      portals.clear();
      subscriptions.clear();
      setupIntents.clear();
      paymentMethods.clear();
      invoiceItems.clear();
      invoices.clear();
      idempotent.clear();
      failures = [];
      calls.length = 0;
      refuse = false;
      return json(res, 200, {});
    }
    if (path === "/control/fail" && req.method === "POST") {
      // The next `times` calls of this method and path fail with a 500: before
      // anything is done, or after it's done (as an answer lost on the way
      // back). With `forget`, failing after also forgets the idempotency keys,
      // as a day passing would, so only what the adapter looks up finds it.
      const { method, path: failing, when, times, forget, clear } = await read();
      if (clear) {
        failures = [];
      } else {
        failures.push({ method, path: failing, when: when ?? "before", times: times ?? 1, forget: !!forget });
      }
      return json(res, 200, { failures });
    }
    if (path === "/control/forget-keys" && req.method === "POST") {
      idempotent.clear();
      return json(res, 200, {});
    }
    if (path === "/control/invoiceitems" && req.method === "GET") {
      const customer = url.searchParams.get("customer");
      return json(res, 200, [...invoiceItems.values()].filter((i) => customer === null || i.customer === customer));
    }
    if (path === "/control/invoices" && req.method === "GET") {
      const customer = url.searchParams.get("customer");
      return json(res, 200, [...invoices.values()].filter((i) => customer === null || i.customer === customer).map(invoiceLines));
    }
    if (path === "/control/collect" && req.method === "POST") {
      // Stripe's automatic collection of an invoice: finalized (if it's a
      // draft) and an attempt on the customer's default card, which pays it,
      // or fails when `fail` is set or there's no card; with webhooks.
      const { invoice: invoiceId, fail } = await read();
      const invoice = invoices.get(invoiceId);
      if (!invoice) {
        return json(res, 404, { error: "no such invoice" });
      }
      return json(res, 200, await collect(invoice, !!fail));
    }
    if (path === "/control/detach" && req.method === "POST") {
      // The card taken off its customer, as in the customer portal.
      const { payment_method: pm } = await read();
      const card = paymentMethods.get(pm);
      if (!card || !card.customer) {
        return json(res, 404, { error: "no such card on a customer" });
      }
      const customer = customers.get(card.customer);
      card.customer = null;
      if (customer.invoice_settings.default_payment_method === pm) {
        customer.invoice_settings.default_payment_method = null;
        await sendEvent("customer.updated", customer, customer.id);
      }
      return json(res, 200, card);
    }
    if (path === "/control/refuse" && req.method === "POST") {
      refuse = !!(await read()).refuse;
      return json(res, 200, { refuse });
    }
    if (path === "/control/calls" && req.method === "GET") {
      return json(res, 200, calls);
    }
    if (path === "/control/customers" && req.method === "GET") {
      return json(res, 200, [...customers.values()]);
    }
    if (path === "/control/subscriptions" && req.method === "GET") {
      const customer = url.searchParams.get("customer");
      return json(res, 200, [...subscriptions.values()].filter((s) => customer === null || s.customer === customer));
    }
    if (path === "/control/subscription" && req.method === "POST") {
      const { id: subscriptionId, ...changes } = await read();
      const subscription = subscriptions.get(subscriptionId);
      if (!subscription) {
        return json(res, 404, { error: "no such subscription" });
      }
      return json(res, 200, change(subscription, changes));
    }
    if (path === "/control/make" && req.method === "POST") {
      // A customer (or the one named), and a subscription for it, made as if in
      // Stripe's dashboard, with no webhook sent; the customer's webhooks go to
      // `server` from then on.
      const { metadata, subscription, server: origin, customer: existing } = await read();
      const customer = existing === undefined ? makeCustomer(metadata ?? {}) : customers.get(existing);
      if (!customer) {
        return json(res, 404, { error: "no such customer" });
      }
      if (origin) {
        hooks.set(customer.id, hookFor(origin));
      }
      const made = subscription ? makeSubscription({ customer: customer.id, ...subscription }) : null;
      return json(res, 200, { customer, subscription: made });
    }
    if (path === "/control/send" && req.method === "POST") {
      // A webhook: an event of `type` about a subscription, a Checkout Session, or a
      // customer the stand-in has, or about `object` as given, to `url` (by
      // default the server that pays for that customer), signed with `secrets`
      // at `timestamp`, in `livemode`.
      const { url: to, type, subscription, session, customer, object, secrets, timestamp, livemode } = await read();
      const kept = subscriptions.get(subscription) ?? (sessions.has(session) ? publicSession(sessions.get(session)) : undefined) ?? customers.get(customer);
      const about = object ?? kept;
      if (!about) {
        return json(res, 404, { error: "nothing to send an event about" });
      }
      const target = to ?? hooks.get(about.object === "customer" ? about.id : about.customer);
      if (!target) {
        return json(res, 400, { error: "no webhook address yet" });
      }
      const body = JSON.stringify(event(type ?? "customer.subscription.updated", about, livemode ?? false));
      return json(res, 200, await send(target, body, secrets ?? webhookSecrets, timestamp ?? now()));
    }
    return json(res, 404, { error: "no such control" });
  }

  /** The parameters a call takes, as Stripe's reference lists the ones the adapter uses. */
  const allowed = {
    customers: [/^metadata\[[a-z_]+\]$/, /^email$/, /^name$/],
    customerUpdate: [/^metadata\[[a-z_]+\]$/, /^invoice_settings\[default_payment_method\]$/],
    sessions: [
      /^mode$/,
      /^currency$/,
      /^customer$/,
      /^client_reference_id$/,
      /^line_items\[\d+\]\[(price|quantity)\]$/,
      /^subscription_data\[metadata\]\[[a-z_]+\]$/,
      /^setup_intent_data\[metadata\]\[[a-z_]+\]$/,
      /^success_url$/,
      /^cancel_url$/,
      /^metadata\[[a-z_]+\]$/,
    ],
    portal: [/^customer$/, /^return_url$/],
    list: [/^customer$/, /^status$/, /^limit$/, /^starting_after$/, /^ending_before$/],
    sessionList: [/^customer$/, /^status$/, /^limit$/, /^starting_after$/, /^expand\[\]$/],
    itemList: [/^customer$/, /^pending$/, /^limit$/, /^starting_after$/],
    invoiceList: [/^customer$/, /^status$/, /^limit$/, /^starting_after$/],
    item: [
      /^customer$/,
      /^amount$/,
      /^currency$/,
      /^description$/,
      /^period\[(start|end)\]$/,
      /^metadata\[[a-z_]+\]$/,
      /^invoice$/,
    ],
    invoice: [
      /^customer$/,
      /^collection_method$/,
      /^auto_advance$/,
      /^pending_invoice_items_behavior$/,
      /^description$/,
      /^metadata\[[a-z_]+\]$/,
    ],
  };
  /** The metadata a form sets, from its `metadata[...]` fields. */
  const metadataOf = (form, prefix = "metadata") => {
    const metadata = {};
    for (const [name, value] of Object.entries(form)) {
      const key = new RegExp(`^${prefix.replace(/[[\]]/g, "\\$&")}\\[([a-z_]+)\\]$`).exec(name)?.[1];
      if (key) metadata[key] = value;
    }
    return metadata;
  };
  /** One page of `list` (newest first), after `starting_after`, as Stripe pages a list. */
  const listPage = (res, list, query, url) => {
    const limit = Number(query.limit ?? 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return error(res, 400, "invalid_request_error", "Limit must be between 1 and 100.", { param: "limit" });
    }
    let rest = [...list].sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1));
    if (query.starting_after) {
      const at = rest.findIndex((o) => o.id === query.starting_after);
      if (at < 0) return missing(res, "object", query.starting_after);
      rest = rest.slice(at + 1);
    }
    return json(res, 200, { object: "list", url, has_more: rest.length > limit, data: rest.slice(0, limit) });
  };
  /** An invoice as Stripe answers it, its lines the items it took. */
  function invoiceLines(invoice) {
    const lines = [...invoiceItems.values()].filter((item) => item.invoice === invoice.id);
    invoice.lines = {
      object: "list",
      data: lines.map((item) => ({
        id: `il_${item.id}`,
        object: "line_item",
        amount: item.amount,
        currency: item.currency,
        description: item.description,
        metadata: item.metadata,
        period: item.period,
        parent: { type: "invoice_item_details", invoice_item_details: { invoice_item: item.id } },
      })),
      has_more: false,
      total_count: lines.length,
      url: `/v1/invoices/${invoice.id}/lines`,
    };
    const total = lines.reduce((sum, item) => sum + item.amount, 0);
    Object.assign(invoice, { subtotal: total, total, amount_due: total - invoice.amount_paid, amount_remaining: total - invoice.amount_paid });
    return invoice;
  }
  /** Stripe's automatic collection of `invoice`: finalized, then one attempt on the default card. */
  async function collect(invoice, fail) {
    if (invoice.status === "draft") {
      Object.assign(invoice, { status: "open", number: `STANDIN-${(next += 1).toString().padStart(4, "0")}` });
      invoice.status_transitions.finalized_at = now();
    }
    if (!["open", "uncollectible"].includes(invoice.status)) {
      return invoice;
    }
    const card = customers.get(invoice.customer)?.invoice_settings.default_payment_method;
    invoice.attempted = true;
    invoice.attempt_count += 1;
    if (fail || !card) {
      invoice.next_payment_attempt = now() + 3 * DAY;
      await sendEvent("invoice.payment_failed", invoiceLines(invoice), invoice.customer);
    } else {
      Object.assign(invoice, { status: "paid", amount_paid: invoice.total, next_payment_attempt: null });
      invoice.status_transitions.paid_at = now();
      await sendEvent("invoice.paid", invoiceLines(invoice), invoice.customer);
    }
    return invoiceLines(invoice);
  }
  const unknownParameter = (res, params, rules) => {
    for (const name of Object.keys(params)) {
      if (!rules.some((rule) => rule.test(name))) {
        error(res, 400, "invalid_request_error", `Received unknown parameter: ${name}`, { param: name });
        return true;
      }
    }
    return false;
  };

  async function api(req, res, url) {
    const path = url.pathname;
    const text = req.method === "POST" ? await readBody(req) : "";
    const contentType = req.headers["content-type"] ?? null;
    const form = Object.fromEntries(new URLSearchParams(text));
    const query = Object.fromEntries(url.searchParams);
    const bearer = req.headers.authorization === `Bearer ${apiKey}`;
    calls.push({
      method: req.method,
      path,
      query,
      form,
      version: req.headers["stripe-version"] ?? null,
      bearer,
      contentType,
      idempotencyKey: req.headers["idempotency-key"] ?? null,
    });
    if (!bearer) {
      return error(res, 401, "invalid_request_error", "Invalid API Key provided.");
    }
    if (req.headers["stripe-version"] !== version) {
      return error(res, 400, "invalid_request_error", "Invalid Stripe API version.");
    }
    if (refuse) {
      return error(res, 503, "api_error", "The stand-in is refusing every call.");
    }
    if (req.method === "POST" && contentType !== "application/x-www-form-urlencoded") {
      return error(res, 400, "invalid_request_error", "Requests are form-encoded.");
    }
    const failing = failures.find((f) => f.times > 0 && f.method === req.method && f.path === path);
    if (failing?.when === "before") {
      failing.times -= 1;
      return error(res, 500, "api_error", "The stand-in failed this call before doing it.");
    }
    // An idempotent request answered before is answered the same, while its key is kept.
    const key = req.method === "POST" ? req.headers["idempotency-key"] : undefined;
    if (key !== undefined && idempotent.has(key)) {
      const first = idempotent.get(key);
      if (first.method !== req.method || first.path !== path || JSON.stringify(first.form) !== JSON.stringify(form)) {
        return error(res, 400, "idempotency_error", "Keys for idempotent requests can only be used with the same parameters they were first used with.");
      }
      res.writeHead(first.status, { "Content-Type": "application/json", "Idempotent-Replayed": "true" });
      return res.end(first.body);
    }
    if (key !== undefined || failing?.when === "after") {
      // Done, then kept for the key, and with a failure after it, lost on the way back.
      const answer = { status: 200, body: "" };
      const shadow = {
        writeHead(status) {
          answer.status = status;
        },
        end(body) {
          answer.body = body ?? "";
        },
      };
      await route(req, shadow, path, form, query);
      if (key !== undefined && answer.status < 500) {
        idempotent.set(key, { method: req.method, path, form, status: answer.status, body: answer.body });
      }
      if (failing?.when === "after") {
        failing.times -= 1;
        if (failing.forget) idempotent.clear();
        return error(res, 500, "api_error", "The stand-in did this call and then failed to answer.");
      }
      res.writeHead(answer.status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(answer.body);
    }
    return route(req, res, path, form, query);
  }

  /** The endpoints, once a call has passed the checks every call gets. */
  async function route(req, res, path, form, query) {

    if (path === "/v1/customers" && req.method === "POST") {
      if (unknownParameter(res, form, allowed.customers)) return;
      const metadata = {};
      for (const [name, value] of Object.entries(form)) {
        const key = /^metadata\[([a-z_]+)\]$/.exec(name)?.[1];
        if (key) metadata[key] = value;
      }
      const customer = makeCustomer(metadata);
      if (form.email) customer.email = form.email;
      return json(res, 200, customer);
    }

    const customerPath = /^\/v1\/customers\/([A-Za-z0-9_]+)$/.exec(path);
    if (customerPath && req.method === "GET") {
      if (unknownParameter(res, query, [])) return;
      const customer = customers.get(customerPath[1]);
      return customer ? json(res, 200, customer) : missing(res, "customer", customerPath[1]);
    }
    if (customerPath && req.method === "POST") {
      if (unknownParameter(res, form, allowed.customerUpdate)) return;
      const customer = customers.get(customerPath[1]);
      if (!customer) {
        return missing(res, "customer", customerPath[1]);
      }
      const card = form["invoice_settings[default_payment_method]"];
      if (card !== undefined) {
        if (paymentMethods.get(card)?.customer !== customer.id) {
          return error(res, 400, "invalid_request_error", `The payment method \`${card}\` doesn't belong to the Customer you're updating.`, {
            param: "invoice_settings[default_payment_method]",
          });
        }
        customer.invoice_settings.default_payment_method = card;
      }
      Object.assign(customer.metadata, metadataOf(form));
      return json(res, 200, customer);
    }

    if (path === "/v1/checkout/sessions" && req.method === "GET") {
      if (unknownParameter(res, query, allowed.sessionList)) return;
      const expand = query["expand[]"];
      if (expand !== undefined && !["data.setup_intent", "data.setup_intent.payment_method"].includes(expand)) {
        return error(res, 400, "invalid_request_error", `This property cannot be expanded (${expand}).`, { param: "expand" });
      }
      const listed = [...sessions.values()]
        .filter((s) => query.customer === undefined || s.customer === query.customer)
        .filter((s) => query.status === undefined || s.status === query.status)
        .map((session) => {
          const shown = publicSession(session);
          if (expand && shown.setup_intent) {
            const intent = { ...setupIntents.get(shown.setup_intent) };
            if (expand.endsWith(".payment_method") && intent.payment_method) {
              intent.payment_method = { ...paymentMethods.get(intent.payment_method) };
            }
            shown.setup_intent = intent;
          }
          return shown;
        });
      return listPage(res, listed, query, "/v1/checkout/sessions");
    }

    if (path === "/v1/checkout/sessions" && req.method === "POST") {
      if (unknownParameter(res, form, allowed.sessions)) return;
      if (form.mode !== "subscription" && form.mode !== "setup") {
        return error(res, 400, "invalid_request_error", "The stand-in takes mode=subscription or mode=setup.", { param: "mode" });
      }
      if (!form.success_url) {
        return error(res, 400, "invalid_request_error", "Missing required param: success_url.", { param: "success_url" });
      }
      if (!customers.has(form.customer)) {
        return missing(res, "customer", form.customer);
      }
      if (form.mode === "setup") {
        // Setup mode saves a card and charges nothing: no line items, and the
        // currency, which dynamic payment methods need.
        if (Object.keys(form).some((name) => name.startsWith("line_items") || name.startsWith("subscription_data"))) {
          return error(res, 400, "invalid_request_error", "line_items and subscription_data can't be used in setup mode.", { param: "line_items" });
        }
        if (form.currency !== "usd") {
          return error(res, 400, "invalid_request_error", "Missing required param: currency.", { param: "currency" });
        }
        const sessionId = `cs_test_${randomBytes(24).toString("hex")}`;
        const session = {
          id: sessionId,
          object: "checkout.session",
          cancel_url: form.cancel_url ?? null,
          client_reference_id: form.client_reference_id ?? null,
          created: now(),
          currency: "usd",
          customer: form.customer,
          expires_at: now() + DAY,
          livemode: false,
          metadata: metadataOf(form),
          mode: "setup",
          payment_status: "no_payment_required",
          setup_intent: null,
          status: "open",
          subscription: null,
          success_url: form.success_url,
          ui_mode: "hosted_page",
          url: `${pages}/c/pay/${sessionId}`,
          _intentMetadata: metadataOf(form, "setup_intent_data[metadata]"),
        };
        sessions.set(sessionId, session);
        hooks.set(form.customer, hookFor(form.success_url));
        return json(res, 200, publicSession(session));
      }
      const price = form["line_items[0][price]"];
      if (!prices.includes(price)) {
        return missing(res, "price", price);
      }
      if ((form.client_reference_id ?? "").length > 200) {
        return error(res, 400, "invalid_request_error", "client_reference_id is too long.", { param: "client_reference_id" });
      }
      const metadata = {};
      for (const [name, value] of Object.entries(form)) {
        const key = /^subscription_data\[metadata\]\[([a-z_]+)\]$/.exec(name)?.[1];
        if (key) metadata[key] = value;
      }
      const sessionId = `cs_test_${randomBytes(24).toString("hex")}`;
      const session = {
        id: sessionId,
        object: "checkout.session",
        cancel_url: form.cancel_url ?? null,
        client_reference_id: form.client_reference_id ?? null,
        created: now(),
        customer: form.customer,
        expires_at: now() + DAY,
        livemode: false,
        metadata: {},
        mode: "subscription",
        payment_status: "unpaid",
        status: "open",
        subscription: null,
        success_url: form.success_url,
        ui_mode: "hosted_page",
        url: `${pages}/c/pay/${sessionId}`,
        // Kept for the page; Stripe keeps these on the session's line items and subscription.
        _price: price,
        _quantity: form["line_items[0][quantity]"],
        _metadata: metadata,
      };
      sessions.set(sessionId, session);
      hooks.set(form.customer, hookFor(form.success_url));
      return json(res, 200, publicSession(session));
    }

    if (path === "/v1/billing_portal/sessions" && req.method === "POST") {
      if (unknownParameter(res, form, allowed.portal)) return;
      if (!customers.has(form.customer)) {
        return missing(res, "customer", form.customer);
      }
      const portalId = id("bps");
      const secret = randomBytes(16).toString("hex");
      const portal = {
        id: portalId,
        object: "billing_portal.session",
        configuration: "bpc_standin",
        created: now(),
        customer: form.customer,
        flow: null,
        livemode: false,
        locale: null,
        on_behalf_of: null,
        return_url: form.return_url ?? null,
        url: `${pages}/p/session/${secret}`,
      };
      portals.set(secret, portal);
      if (form.return_url) {
        hooks.set(form.customer, hookFor(form.return_url));
      }
      return json(res, 200, portal);
    }

    if (path === "/v1/subscriptions" && req.method === "GET") {
      if (unknownParameter(res, query, allowed.list)) return;
      const limit = Number(query.limit ?? 10);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return error(res, 400, "invalid_request_error", "Limit must be between 1 and 100.", { param: "limit" });
      }
      const status = query.status;
      const matches = (s) =>
        status === "all" ||
        (status === undefined && s.status !== "canceled") ||
        (status === "ended" && ["canceled", "incomplete_expired"].includes(s.status)) ||
        s.status === status;
      // Newest first, as Stripe lists them.
      let list = [...subscriptions.values()]
        .filter((s) => query.customer === undefined || s.customer === query.customer)
        .filter(matches)
        .sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1));
      if (query.starting_after) {
        const at = list.findIndex((s) => s.id === query.starting_after);
        if (at < 0) return missing(res, "subscription", query.starting_after);
        list = list.slice(at + 1);
      }
      return json(res, 200, { object: "list", url: "/v1/subscriptions", has_more: list.length > limit, data: list.slice(0, limit) });
    }

    if (path === "/v1/invoiceitems" && req.method === "GET") {
      if (unknownParameter(res, query, allowed.itemList)) return;
      const listed = [...invoiceItems.values()]
        .filter((item) => query.customer === undefined || item.customer === query.customer)
        .filter((item) => query.pending === undefined || (query.pending === "true") === (item.invoice === null));
      return listPage(res, listed, query, "/v1/invoiceitems");
    }
    if (path === "/v1/invoiceitems" && req.method === "POST") {
      if (unknownParameter(res, form, allowed.item)) return;
      if (!customers.has(form.customer)) {
        return missing(res, "customer", form.customer);
      }
      if (!/^-?\d+$/.test(form.amount ?? "") || form.currency !== "usd") {
        return error(res, 400, "invalid_request_error", "An invoice item needs an amount in cents and its currency.", { param: "amount" });
      }
      const start = Number(form["period[start]"]);
      const end = Number(form["period[end]"]);
      if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
        return error(res, 400, "invalid_request_error", "The period's end must be at or after its start.", { param: "period" });
      }
      const item = {
        id: id("ii"),
        object: "invoiceitem",
        amount: Number(form.amount),
        currency: form.currency,
        customer: form.customer,
        created: now(),
        date: now(),
        description: form.description ?? null,
        discountable: true,
        invoice: null,
        livemode: false,
        metadata: metadataOf(form),
        parent: null,
        period: { start, end },
        proration: false,
        quantity: 1,
      };
      invoiceItems.set(item.id, item);
      return json(res, 200, item);
    }

    if (path === "/v1/invoices" && req.method === "GET") {
      if (unknownParameter(res, query, allowed.invoiceList)) return;
      const listed = [...invoices.values()]
        .filter((invoice) => query.customer === undefined || invoice.customer === query.customer)
        .filter((invoice) => query.status === undefined || invoice.status === query.status)
        .map(invoiceLines);
      return listPage(res, listed, query, "/v1/invoices");
    }
    if (path === "/v1/invoices" && req.method === "POST") {
      if (unknownParameter(res, form, allowed.invoice)) return;
      const customer = customers.get(form.customer);
      if (!customer) {
        return missing(res, "customer", form.customer);
      }
      if (!["charge_automatically", "send_invoice", undefined].includes(form.collection_method)) {
        return error(res, 400, "invalid_request_error", "Invalid collection_method.", { param: "collection_method" });
      }
      const invoice = {
        id: id("in"),
        object: "invoice",
        amount_due: 0,
        amount_paid: 0,
        amount_remaining: 0,
        attempt_count: 0,
        attempted: false,
        auto_advance: form.auto_advance === "true",
        billing_reason: "manual",
        collection_method: form.collection_method ?? "charge_automatically",
        created: now(),
        currency: "usd",
        customer: customer.id,
        default_payment_method: null,
        description: form.description ?? null,
        livemode: false,
        metadata: metadataOf(form),
        next_payment_attempt: null,
        number: null,
        status: "draft",
        status_transitions: { finalized_at: null, marked_uncollectible_at: null, paid_at: null, voided_at: null },
        subtotal: 0,
        total: 0,
      };
      invoices.set(invoice.id, invoice);
      // Pending items go on it only when asked: Stripe's default is to leave them.
      if (form.pending_invoice_items_behavior === "include") {
        for (const item of invoiceItems.values()) {
          if (item.customer === customer.id && item.invoice === null) item.invoice = invoice.id;
        }
      }
      return json(res, 200, invoiceLines(invoice));
    }

    const cancel = /^\/v1\/subscriptions\/([A-Za-z0-9_]+)$/.exec(path);
    if (cancel && req.method === "DELETE") {
      const subscription = subscriptions.get(cancel[1]);
      if (!subscription) {
        return missing(res, "subscription", cancel[1]);
      }
      if (subscription.status === "canceled") {
        return error(res, 400, "invalid_request_error", "This subscription has already been canceled.");
      }
      change(subscription, { status: "canceled", canceled_at: now(), ended_at: now() });
      subscription.cancellation_details = { comment: null, feedback: null, reason: "cancellation_requested" };
      // Sent after the answer, as Stripe sends its events: the server may be
      // in the middle of deleting whoever this customer was.
      setImmediate(() => sendEvent("customer.subscription.deleted", subscription, subscription.customer).catch(() => {}));
      return json(res, 200, subscription);
    }

    return error(res, 404, "invalid_request_error", `Unrecognized request URL (${req.method}: ${path}).`);
  }

  /** A session as Stripe answers it, without what the stand-in keeps for itself. */
  const publicSession = (session) => Object.fromEntries(Object.entries(session).filter(([key]) => !key.startsWith("_")));

  const page = (res, title, body) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title></head><body><h1>${escape(title)}</h1>${body}</body></html>`);
  };
  const back = (res, to) => {
    res.writeHead(303, { Location: to });
    res.end();
  };

  /** The pages people are sent to. */
  async function provider(req, res, url) {
    const checkout = /^\/c\/pay\/(cs_test_[0-9a-f]+)(\/pay)?$/.exec(url.pathname);
    if (checkout && sessions.has(checkout[1])) {
      const session = sessions.get(checkout[1]);
      if (session.mode === "setup") {
        if (checkout[2] && req.method === "POST") {
          if (session.status === "open") {
            // A card saved to the customer, as Checkout's setup mode does.
            const card = {
              id: id("pm"),
              object: "payment_method",
              card: { brand: "visa", exp_month: 12, exp_year: 2030, last4: "4242" },
              created: now(),
              customer: session.customer,
              livemode: false,
              metadata: {},
              type: "card",
            };
            paymentMethods.set(card.id, card);
            const intent = {
              id: id("seti"),
              object: "setup_intent",
              created: now(),
              customer: session.customer,
              livemode: false,
              metadata: session._intentMetadata,
              payment_method: card.id,
              status: "succeeded",
              usage: "off_session",
            };
            setupIntents.set(intent.id, intent);
            Object.assign(session, { status: "complete", setup_intent: intent.id });
            await sendEvent("checkout.session.completed", publicSession(session), session.customer);
          }
          return back(res, session.success_url);
        }
        return page(
          res,
          "Stand-in Stripe Checkout",
          `<p>Save a card for ${escape(session.client_reference_id)}. Nothing is charged now.</p><form method="post" action="/c/pay/${escape(session.id)}/pay"><button type="submit">Save card</button></form>${session.cancel_url ? `<p><a href="${escape(session.cancel_url)}">Back</a></p>` : ""}`,
        );
      }
      if (checkout[2] && req.method === "POST") {
        if (session.status === "open") {
          const subscription = makeSubscription({ customer: session.customer, price: session._price, metadata: session._metadata });
          Object.assign(session, { status: "complete", payment_status: "paid", subscription: subscription.id });
          await sendEvent("checkout.session.completed", publicSession(session), session.customer);
          await sendEvent("customer.subscription.created", subscription, session.customer);
        }
        return back(res, session.success_url);
      }
      return page(
        res,
        "Stand-in Stripe Checkout",
        `<p>A year of ${escape(session._metadata.plan ?? session._price)}, for ${escape(session.client_reference_id)}.</p><form method="post" action="/c/pay/${escape(session.id)}/pay"><button type="submit">Subscribe</button></form>${session.cancel_url ? `<p><a href="${escape(session.cancel_url)}">Back</a></p>` : ""}`,
      );
    }
    const portal = /^\/p\/session\/([0-9a-f]+)(\/cancel)?$/.exec(url.pathname);
    if (portal && portals.has(portal[1])) {
      const session = portals.get(portal[1]);
      const theirs = [...subscriptions.values()].filter((s) => s.customer === session.customer);
      if (portal[2] && req.method === "POST") {
        for (const subscription of theirs.filter((s) => ["active", "trialing", "past_due"].includes(s.status))) {
          subscription.cancel_at_period_end = true;
          subscription.canceled_at = now();
          await sendEvent("customer.subscription.updated", subscription, session.customer);
        }
        return back(res, session.return_url);
      }
      return page(
        res,
        "Stand-in Stripe customer portal",
        `<ul>${theirs.map((s) => `<li>${escape(s.status)}${s.cancel_at_period_end ? ", cancels at the period's end" : ""}</li>`).join("") || "<li>Nothing yet</li>"}</ul><form method="post" action="/p/session/${escape(portal[1])}/cancel"><button type="submit">Cancel plan</button></form><p><a href="${escape(session.return_url ?? "")}">Return</a></p>`,
      );
    }
    return page(res, "Not found", "<p>There's no such page.</p>");
  }

  const pagesServer = https.createServer(throwawayCertificate(), async (req, res) => {
    try {
      return await provider(req, res, new URL(req.url, pages));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      return res.end(String(e));
    }
  });
  await new Promise((resolve) => pagesServer.listen(Number(pagesPort), "127.0.0.1", resolve));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    try {
      if (url.pathname === "/alive") {
        return json(res, 200, {});
      }
      if (url.pathname.startsWith("/control/")) {
        return await control(req, res, url);
      }
      return await api(req, res, url);
    } catch (e) {
      return error(res, 500, "api_error", String(e));
    }
  });
  return new Promise((resolve) => server.listen(Number(port), "127.0.0.1", () => resolve(server)));
}

// Run on its own: node stripe-standin.mjs, with KK_STRIPE_STANDIN_PORT,
// KK_STRIPE_STANDIN_PAGES_PORT, KK_STRIPE_API_KEY, KK_STRIPE_WEBHOOK_SECRETS
// (separated by commas, newest first, as Stripe signs with each while one is
// rolled), KK_STRIPE_VERSION, and KK_STRIPE_PRICES (the price ids it knows,
// separated by commas), which the tests make up.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const {
    KK_STRIPE_STANDIN_PORT: port,
    KK_STRIPE_STANDIN_PAGES_PORT: pagesPort,
    KK_STRIPE_API_KEY: apiKey,
    KK_STRIPE_WEBHOOK_SECRETS: secrets,
    KK_STRIPE_VERSION: version,
    KK_STRIPE_PRICES: prices,
  } = process.env;
  if (!port || !pagesPort || !apiKey || !secrets || !version || !prices) {
    console.error(
      "stripe-standin: KK_STRIPE_STANDIN_PORT, KK_STRIPE_STANDIN_PAGES_PORT, KK_STRIPE_API_KEY, KK_STRIPE_WEBHOOK_SECRETS, KK_STRIPE_VERSION, and KK_STRIPE_PRICES are needed",
    );
    process.exit(1);
  }
  await startStripeStandin({
    port,
    pagesPort,
    apiKey,
    webhookSecrets: secrets.split(","),
    version,
    prices: prices.split(","),
  });
  // Stop with whatever started us.
  const parent = process.ppid;
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      process.exit(0);
    }
  }, 1000).unref();
}
