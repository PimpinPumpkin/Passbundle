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
//   POST   /v1/checkout/sessions        -> a Checkout Session, with its page's url
//   POST   /v1/billing_portal/sessions  -> a portal session, with its page's url
//   GET    /v1/subscriptions            -> a page of a customer's subscriptions
//   DELETE /v1/subscriptions/<id>       -> the subscription, canceled at once
// Anything else, a parameter Stripe wouldn't take, a wrong key, or another
// version is answered with Stripe's error shape and status.
//
// The pages it answers are on a port of their own, over HTTPS with a
// throwaway certificate, since the apps open only https pages: a Checkout
// page whose button pays for a year (the subscription goes active, and Stripe's
// webhooks are sent: checkout.session.completed and
// customer.subscription.created), and a portal whose button cancels at the
// period's end (customer.subscription.updated). Each goes back where the
// server asked.
//
// A test's controls (/control/...): reset, refuse every call, read the calls
// made, the customers, and the subscriptions, change a subscription, make a
// customer and a subscription directly, and send a webhook.
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
    const customer = { id: id("cus"), object: "customer", created: now(), email: null, livemode: false, metadata };
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
      calls.length = 0;
      refuse = false;
      return json(res, 200, {});
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
    sessions: [
      /^mode$/,
      /^customer$/,
      /^client_reference_id$/,
      /^line_items\[\d+\]\[(price|quantity)\]$/,
      /^subscription_data\[metadata\]\[[a-z_]+\]$/,
      /^success_url$/,
      /^cancel_url$/,
      /^metadata\[[a-z_]+\]$/,
    ],
    portal: [/^customer$/, /^return_url$/],
    list: [/^customer$/, /^status$/, /^limit$/, /^starting_after$/, /^ending_before$/],
  };
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

    if (path === "/v1/checkout/sessions" && req.method === "POST") {
      if (unknownParameter(res, form, allowed.sessions)) return;
      if (form.mode !== "subscription") {
        return error(res, 400, "invalid_request_error", "The stand-in takes only mode=subscription.", { param: "mode" });
      }
      if (!form.success_url) {
        return error(res, 400, "invalid_request_error", "Missing required param: success_url.", { param: "success_url" });
      }
      if (!customers.has(form.customer)) {
        return missing(res, "customer", form.customer);
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
