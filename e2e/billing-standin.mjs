// A stand-in for a payment provider, for the tests of how the server learns
// who has paid (DESIGN.md, "Plans and billing", "Learning who has paid";
// tests/api/billing.spec.ts). It answers the few calls the server's stand-in
// adapter makes (passbundle-server, src/keykeeper_billing/standin.rs), from
// what a test tells it through /control, and sends webhooks signed with
// Stripe's published scheme (docs.stripe.com, "Verify webhook signatures
// manually") under a secret made up for the run. No real provider, account,
// or key is involved, and it listens on 127.0.0.1 only. No dependencies.
//
// The server's calls, each with `Authorization: Bearer <KK_BILLING_API_KEY>`:
//   POST /pay {whose, plan, customer, back}  -> {url, customer}, a page to pay
//   POST /manage {customer, back}            -> {url}, a page to manage
//   POST /invoices {customer, month, lines, key} -> {id}, once for each key
//   GET  /customers/<id>                     -> the customer's standing, or
//        {plan: null} for nothing, or 404 for a customer it never made
//
// The pages it answers are on a port of their own, over HTTPS with a
// throwaway certificate, since the apps open only https pages. The page to
// pay has a button that pays for a year (or for a pool, puts a card on file),
// and the page to manage one that cancels at the period's end; each sends
// the server a webhook and goes back where the server asked.
//
// A test's controls (/control/...): reset, refuse every call, read the
// customers and the calls made, set a customer's standing, and send a webhook.
import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Stripe's scheme: hex HMAC-SHA256 of the timestamp, a period, and the body, keyed with the secret as written. */
export function sign(secret, timestamp, body) {
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), Buffer.from(body)]))
    .digest("hex");
}

/** The header the stand-in's webhooks carry their signatures in. */
export const SIGNATURE_HEADER = "Standin-Signature";

/** The header for `body` signed now (or at `timestamp`) with each of `secrets`. */
export function signatureHeader(secrets, body, timestamp = Math.floor(Date.now() / 1000)) {
  return [`t=${timestamp}`, ...secrets.map((secret) => `v1=${sign(secret, timestamp, body)}`)].join(",");
}

/** A certificate for the pages, made for this run and thrown away after. */
function throwawayCertificate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-billing-standin-"));
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

/** What paying for a plan comes to at the stand-in: a year ahead, or a pool's card on file. */
export function paidStanding(plan) {
  return plan === "msp" || plan === "business"
    ? { plan, standing: "open", renews: true, billed: "by_the_day", subscription: `sub_${randomUUID().slice(0, 8)}` }
    : {
        plan,
        standing: "until",
        until: new Date(Math.floor(Date.now() / 1000 + 365 * 86400) * 1000).toISOString(),
        renews: true,
        billed: "prepaid",
        subscription: `sub_${randomUUID().slice(0, 8)}`,
      };
}

/** Starts the stand-in, with its pages on `pagesPort`. Resolves once both listen. */
export async function startStandin({ port, pagesPort, apiKey, webhookSecret }) {
  const base = `http://127.0.0.1:${port}`;
  const pages = `https://127.0.0.1:${pagesPort}`;
  /** id -> { whose, plan, standing } */
  const customers = new Map();
  /** Pages to pay: id -> { customer, back } */
  const checkouts = new Map();
  /** key -> invoice id */
  const invoices = new Map();
  /** Every call the server made: { method, path, customer }. */
  const calls = [];
  let refuse = false;
  let next = 0;
  const id = (prefix) => `${prefix}_${(next += 1)}${randomUUID().slice(0, 8)}`;

  const json = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };

  async function readJson(req) {
    let text = "";
    for await (const chunk of req) text += chunk;
    return text ? JSON.parse(text) : {};
  }

  /** Sends a webhook to the server, signed with the run's secret. */
  function send(url, event) {
    const body = JSON.stringify({ id: id("evt"), object: "event", livemode: false, type: "customer.subscription.updated", ...event });
    return new Promise((resolve, reject) => {
      const request = https.request(
        url,
        {
          method: "POST",
          rejectUnauthorized: false,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            [SIGNATURE_HEADER]: signatureHeader([webhookSecret], body),
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

  async function control(req, res, path) {
    if (path === "/control/reset" && req.method === "POST") {
      customers.clear();
      invoices.clear();
      calls.length = 0;
      refuse = false;
      return json(res, 200, {});
    }
    if (path === "/control/refuse" && req.method === "POST") {
      refuse = !!(await readJson(req)).refuse;
      return json(res, 200, { refuse });
    }
    if (path === "/control/customers" && req.method === "GET") {
      return json(res, 200, [...customers].map(([id, customer]) => ({ id, ...customer })));
    }
    if (path === "/control/calls" && req.method === "GET") {
      return json(res, 200, calls);
    }
    if (path === "/control/standing" && req.method === "POST") {
      const { customer, standing } = await readJson(req);
      if (!customers.has(customer)) {
        return json(res, 404, { error: "no such customer" });
      }
      customers.get(customer).standing = standing;
      return json(res, 200, {});
    }
    if (path === "/control/send" && req.method === "POST") {
      const { url, event } = await readJson(req);
      return json(res, 200, await send(url, event));
    }
    return json(res, 404, { error: "no such control" });
  }

  async function api(req, res, path) {
    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      return json(res, 401, { error: "wrong key" });
    }
    const body = req.method === "POST" ? await readJson(req) : {};
    const customerInPath = path.startsWith("/customers/") ? decodeURIComponent(path.slice("/customers/".length)) : null;
    calls.push({ method: req.method, path, customer: customerInPath ?? body.customer ?? null });
    if (refuse) {
      return json(res, 503, { error: "refusing every call" });
    }
    if (path === "/pay" && req.method === "POST") {
      let customer = body.customer;
      if (customer === null || customer === undefined) {
        customer = id("cus");
        customers.set(customer, { whose: body.whose, plan: body.plan, standing: null });
      } else if (!customers.has(customer)) {
        return json(res, 404, { error: "no such customer" });
      }
      customers.get(customer).plan = body.plan;
      const checkout = id("cs");
      checkouts.set(checkout, { customer, back: body.back });
      return json(res, 200, { url: `${pages}/checkout/${checkout}`, customer });
    }
    if (path === "/manage" && req.method === "POST") {
      if (!customers.has(body.customer)) {
        return json(res, 404, { error: "no such customer" });
      }
      return json(res, 200, { url: `${pages}/portal/${body.customer}?back=${encodeURIComponent(body.back)}` });
    }
    if (path === "/invoices" && req.method === "POST") {
      if (!customers.has(body.customer)) {
        return json(res, 404, { error: "no such customer" });
      }
      if (!invoices.has(body.key)) {
        invoices.set(body.key, id("in"));
      }
      return json(res, 200, { id: invoices.get(body.key) });
    }
    if (customerInPath !== null && req.method === "GET") {
      const customer = customers.get(customerInPath);
      if (!customer) {
        return json(res, 404, { error: "no such customer" });
      }
      return json(res, 200, customer.standing ?? { plan: null });
    }
    return json(res, 404, { error: "no such call" });
  }

  const page = (res, title, body) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title></head><body><h1>${escape(title)}</h1>${body}</body></html>`);
  };
  /** Goes back to the server, after telling it with a webhook that something changed. */
  async function backAfter(res, customer, back) {
    await send(`${new URL(back).origin}/api/keykeeper/billing/events/standin`, { customer });
    res.writeHead(303, { Location: back });
    res.end();
  }

  /** The pages people are sent to. */
  async function provider(req, res, url) {
    const [, kind, which, action] = url.pathname.split("/");
    if (kind === "checkout" && checkouts.has(which)) {
      const { customer, back } = checkouts.get(which);
      const plan = customers.get(customer).plan;
      if (action === "pay" && req.method === "POST") {
        customers.get(customer).standing = paidStanding(plan);
        return backAfter(res, customer, back);
      }
      return page(
        res,
        "Stand-in payment page",
        `<p>Paying for ${escape(plan)}, for ${escape(customers.get(customer).whose)}.</p><form method="post" action="/checkout/${escape(which)}/pay"><button type="submit">Pay</button></form><p><a href="${escape(back)}">Back without paying</a></p>`,
      );
    }
    if (kind === "portal" && customers.has(which)) {
      const back = url.searchParams.get("back") ?? "";
      const customer = customers.get(which);
      if (action === "cancel" && req.method === "POST") {
        if (customer.standing?.standing === "until") {
          customer.standing = { ...customer.standing, renews: false };
        } else if (customer.standing) {
          customer.standing = { plan: customer.standing.plan, standing: "none", renews: false, billed: customer.standing.billed };
        }
        return backAfter(res, which, back);
      }
      return page(
        res,
        "Stand-in billing portal",
        `<p>${escape(customer.standing ? `${customer.standing.plan}, ${customer.standing.standing}` : "Nothing paid yet")}.</p><form method="post" action="/portal/${escape(which)}/cancel?back=${encodeURIComponent(back)}"><button type="submit">Cancel</button></form><p><a href="${escape(back)}">Back</a></p>`,
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
    const path = new URL(req.url, base).pathname;
    try {
      if (path === "/alive") {
        return json(res, 200, {});
      }
      if (path.startsWith("/control/")) {
        return await control(req, res, path);
      }
      return await api(req, res, path);
    } catch (e) {
      return json(res, 500, { error: String(e) });
    }
  });
  return new Promise((resolve) => server.listen(Number(port), "127.0.0.1", () => resolve(server)));
}

// Run on its own: node billing-standin.mjs, with KK_BILLING_STANDIN_PORT,
// KK_BILLING_STANDIN_PAGES_PORT, KK_BILLING_API_KEY, and
// KK_BILLING_WEBHOOK_SECRET, which the tests make up.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const {
    KK_BILLING_STANDIN_PORT: port,
    KK_BILLING_STANDIN_PAGES_PORT: pagesPort,
    KK_BILLING_API_KEY: apiKey,
    KK_BILLING_WEBHOOK_SECRET: webhookSecret,
  } = process.env;
  if (!port || !pagesPort || !apiKey || !webhookSecret) {
    console.error(
      "billing-standin: KK_BILLING_STANDIN_PORT, KK_BILLING_STANDIN_PAGES_PORT, KK_BILLING_API_KEY, and KK_BILLING_WEBHOOK_SECRET are needed",
    );
    process.exit(1);
  }
  await startStandin({ port, pagesPort, apiKey, webhookSecret });
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
