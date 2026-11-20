// Starts the server for one test run with a throwaway data folder,
// no outbound network features, and our built web vault.
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { dnsPort, entraPort, paths, port, siemPort, smtpPort } from "./paths.mjs";

// KK_MAIL=1 starts the server that sends email to the mail catcher. KK_LIMITS=1
// starts one with the real login limits, which the others relax. KK_GROUPS=1
// starts one with groups turned on. Each keeps a database of its own, never
// the main one's: a SQLite file, or on PostgreSQL one of its own when a test
// starts it itself (KK_DATA_DIR; see databaseUrl below).
const withMail = process.env.KK_MAIL === "1";
const withLimits = process.env.KK_LIMITS === "1";
const withGroups = process.env.KK_GROUPS === "1";
// KK_NEW_DEVICE=1 turns the new-device check on (DESIGN.md, "New-device
// check"), with a tiny location database of made-up places
// (fixtures/location/make.mjs), for the tests of the check, which start such a
// server themselves. Every other server turns the check off: their tests sign
// in from fresh browsers and API calls, each a new device.
const withNewDevice = process.env.KK_NEW_DEVICE === "1";
// KK_LIKE_TEST_SERVER=1 starts one set up as the hosted test server is
// (ops, passbundle-test/setup-vps.sh) while the test tenants tool seeds it
// (tools/test-tenants/README.md): no email, the new-device check on, sign-up
// only at the domains in KK_SIGNUPS_DOMAINS, invitations that don't let anyone
// in without approval, and MSPs allowed (tests/api/test-tenants.spec.ts).
const likeTestServer = process.env.KK_LIKE_TEST_SERVER === "1";
// KK_SIGNUPS=closed starts one that isn't taking new accounts, or takes them
// only at the email domains in KK_SIGNUPS_DOMAINS; KK_SIGNUPS=open is the
// same server while it still takes them. KK_SIGNUPS_VERIFY=1 has the sign-up
// form's first step send its link by email (on a server that sends email),
// where the others hand the link's token straight back. The tests of what a
// closed server says start such a server themselves, and start it again with
// other settings over the same data (tests/support/closed-server.ts;
// DESIGN.md, "New accounts on a closed server").
const signUps = process.env.KK_SIGNUPS;
// KK_DATA_DIR keeps the data in that folder, and keeps it when the server
// stops, so a test can start the same server again (reload-key.spec.ts: the
// server forgets reload keys when it restarts). Such a server is a side one.
const keptData = process.env.KK_DATA_DIR;
// KK_EVENT_STREAMING=1: a server that keeps its data, and still sends events
// to receivers on 127.0.0.1 as the main one does, which the tests of event
// streaming across restarts stop, kill, and start again
// (tests/api/event-streaming-servers.spec.ts).
const withStreaming = process.env.KK_EVENT_STREAMING === "1";
// KK_SHARES_DATABASE_OF=<port>: a second server on the database of the
// server on that port, as two servers behind one address would be (the same
// tests): its PostgreSQL database (the main one, KK_DATABASE_URL, or its own)
// or its SQLite file, and its RSA key, which signs logins and seals event
// streaming's secrets. This server's own data folder holds the rest, its
// certificate among them.
const sharesWith = process.env.KK_SHARES_DATABASE_OF;
// KK_SITE_RULES_FEED=<url> with KK_SITE_RULES_FEED_KEY: a server that mirrors
// that site rules feed as an operator's own (SITE_RULES_FEED), from this
// machine, which the site rules tests start themselves (tests/site-rules.spec.ts).
// Every other server mirrors none, so no test server fetches PassBundle's
// feed from the internet.
const siteRulesFeed = process.env.KK_SITE_RULES_FEED;
const side =
  withMail ||
  withLimits ||
  withGroups ||
  withNewDevice ||
  likeTestServer ||
  !!signUps ||
  !!keptData ||
  !!sharesWith ||
  !!siteRulesFeed;

for (const [name, p] of Object.entries({
  server: paths.serverBin,
  webVault: paths.webVault,
})) {
  if (!fs.existsSync(p)) {
    console.error(
      `e2e: ${name} not found at ${p}. Build it first (see e2e/README.md).`,
    );
    process.exit(1);
  }
}

const data = keptData
  ? (fs.mkdirSync(keptData, { recursive: true }), keptData)
  : fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-e2e-"));
// Where this server keeps its data, by port, for the few tests that check
// what a SQLite database holds after a request (tests/api/support.ts,
// serverDatabase).
const dataNote = path.join(os.tmpdir(), `keykeeper-e2e-data-${port}`);
fs.writeFileSync(dataNote, data);
const sharedData = sharesWith
  ? fs.readFileSync(path.join(os.tmpdir(), `keykeeper-e2e-data-${sharesWith}`), "utf8")
  : null;

// KK_DATABASE_URL (the PostgreSQL job): the main server uses that database.
// A server a test starts itself (KK_DATA_DIR) uses a database of its own on
// the same PostgreSQL server, made when it first starts and named in its data
// folder, so it starts again on the same data. KK_SQLITE=1 keeps such a
// server on a SQLite file in its data folder, for a test that reads or
// changes that file itself. The other servers the run starts (mail, limits,
// groups) keep a SQLite file of their own, as every server does without
// KK_DATABASE_URL.
function databaseUrl() {
  const postgres = process.env.KK_DATABASE_URL;
  // A database on the same PostgreSQL server as the main one.
  const named = (name) => {
    const url = new URL(postgres);
    url.pathname = `/${name}`;
    return url.toString();
  };
  if (sharedData) {
    if (!postgres) {
      return `sqlite://${path.join(sharedData, "db.sqlite3")}`;
    }
    const theirs = path.join(sharedData, "postgresql-database");
    return fs.existsSync(theirs) ? named(fs.readFileSync(theirs, "utf8").trim()) : postgres;
  }
  if (!postgres) {
    return null;
  }
  if (!side) {
    return postgres;
  }
  if (!keptData || process.env.KK_SQLITE === "1") {
    return null;
  }
  const note = path.join(data, "postgresql-database");
  if (!fs.existsSync(note)) {
    const name = `keykeeper_e2e_${crypto.randomBytes(8).toString("hex")}`;
    try {
      execFileSync(
        "psql",
        ["--no-psqlrc", "--quiet", "--set", "ON_ERROR_STOP=1", "--dbname", postgres, "--command", `CREATE DATABASE ${name}`],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
    } catch (e) {
      noteDatabase(`couldn't make ${name}: ${e.stderr?.toString().trim() || e.message}`);
      throw e;
    }
    noteDatabase(`made ${name}`);
    fs.writeFileSync(note, name);
  }
  return named(fs.readFileSync(note, "utf8").trim());
}
// Which database each server a test starts got, or why it got none, beside
// the servers' logs when they're kept (KK_SERVER_LOG, as CI keeps them): the
// test itself sees only a server that never answers.
function noteDatabase(line) {
  if (!process.env.KK_SERVER_LOG) {
    return;
  }
  try {
    fs.appendFileSync(
      path.join(path.dirname(process.env.KK_SERVER_LOG), "postgresql-databases.log"),
      `${new Date().toISOString()} port ${port}: ${line}\n`,
    );
  } catch {
    // Only a note: the server starts without it.
  }
}
const database = databaseUrl();

// The made-up places, for the server with the new-device check on.
const locationDatabase = path.join(data, "ip-location.mmdb");
if (withNewDevice) {
  const { build } = await import("./fixtures/location/make.mjs");
  fs.writeFileSync(locationDatabase, build());
}

// Release builds of the clients refuse plain HTTP, so serve HTTPS with a
// throwaway certificate. Browsers in the tests are told to accept it.
const cert = path.join(data, "cert.pem");
const key = path.join(data, "key.pem");
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-keyout",
    key,
    "-out",
    cert,
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    // A server's certificate, not a CA's, so strict TLS checks (the core's
    // rustls) accept it as the one certificate they're told to trust.
    "-addext",
    "basicConstraints=critical,CA:FALSE",
    "-addext",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "-addext",
    "extendedKeyUsage=serverAuth",
  ],
  { stdio: "ignore" },
);
// The Sentinel stand-in's certificate (tests/api/siem.ts reads it from the
// same place), for the main server only: Sentinel destinations can't choose
// a certificate authority, so the server is told to trust this one.
const siemDir = path.join(os.tmpdir(), `keykeeper-e2e-siem-${siemPort}`);
let siemCert = null;
if (!side) {
  fs.mkdirSync(siemDir, { recursive: true });
  siemCert = path.join(siemDir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "2",
      "-keyout",
      path.join(siemDir, "key.pem"),
      "-out",
      siemCert,
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-addext",
      "basicConstraints=critical,CA:FALSE",
      "-addext",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "-addext",
      "extendedKeyUsage=serverAuth",
    ],
    { stdio: "ignore" },
  );
}

const child = spawn(paths.serverBin, [], {
  stdio: "inherit",
  env: {
    PATH: process.env.PATH,
    DATA_FOLDER: data,
    // PostgreSQL, or another server's SQLite file, instead of a fresh SQLite
    // file in this server's data folder (databaseUrl, above).
    ...(database ? { DATABASE_URL: database } : {}),
    ...(sharedData ? { RSA_KEY_FILENAME: path.join(sharedData, "rsa_key") } : {}),
    ...(withGroups ? { ORG_GROUPS_ENABLED: "true" } : {}),
    // KK_EVENTS=1: the event log on, said outright, for a server a test
    // starts itself (tests/api/plans-families.spec.ts). Every other server has
    // it on too, since that's the server's default (ORG_EVENTS_ENABLED): the
    // events a test's requests log are kept, and sent to any event
    // destination the test sets up.
    ...(process.env.KK_EVENTS === "1" ? { ORG_EVENTS_ENABLED: "true" } : {}),
    // KK_SINGLE_ORG_FOR_RECOVERY=1: account recovery needs single organization
    // first, as Bitwarden always does (tests/api/msp-required-policies.spec.ts).
    ...(process.env.KK_SINGLE_ORG_FOR_RECOVERY === "1"
      ? { ENFORCE_SINGLE_ORG_WITH_RESET_PW_POLICY: "true" }
      : {}),
    // Event streaming (tests/api/event-streaming.spec.ts): the main and
    // mail servers may send to receivers on 127.0.0.1 (and nothing else
    // private), and the main one sends Sentinel's sign-in and uploads to the
    // stand-in there, trusting its certificate. So do the servers of the
    // tests across restarts and servers. The others keep the defaults, so
    // the refusal of private addresses is tested too.
    ...((!withLimits && !withGroups && !keptData) || withStreaming
      ? { EVENT_STREAMING_ALLOWED_NETWORKS: "127.0.0.1" }
      : {}),
    ...(siemCert
      ? {
          // A test stand-in, which only this setting allows: any https
          // host for Sentinel, and a certificate authority of its own.
          EVENT_STREAMING_AZURE_TEST: "true",
          EVENT_STREAMING_AZURE_LOGIN_URL: `https://127.0.0.1:${siemPort}`,
          EVENT_STREAMING_AZURE_INGEST_SUFFIX: "127.0.0.1",
          EVENT_STREAMING_AZURE_CA_FILE: siemCert,
        }
      : {}),
    ...(withMail
      ? {
          SMTP_HOST: "127.0.0.1",
          SMTP_PORT: smtpPort,
          SMTP_SECURITY: "off",
          SMTP_FROM: "no-reply@example.test",
          SMTP_TIMEOUT: "5",
        }
      : {}),
    NEW_DEVICE_CHECK: withNewDevice || likeTestServer ? "true" : "false",
    ...(withNewDevice ? { IP_LOCATION_DATABASE: locationDatabase } : {}),
    WEB_VAULT_FOLDER: paths.webVault,
    WEB_VAULT_ENABLED: "true",
    ROCKET_ADDRESS: "127.0.0.1",
    ROCKET_PORT: port,
    ROCKET_TLS: `{certs="${cert}",key="${key}"}`,
    // The website's screenshots (site-shots/) give the hosted service's
    // name, so the addresses the server writes into screens show it.
    DOMAIN: process.env.KK_DOMAIN ?? `https://127.0.0.1:${port}`,
    // The client's address: chosen, as a public DOMAIN requires (the site
    // screenshots give the hosted service's), and taken from X-Real-IP only
    // where the request comes from this machine. The limits server trusts
    // no proxy at all, so a forged header there changes nothing
    // (tests/api/client-address.spec.ts).
    IP_HEADER: "X-Real-IP",
    IP_HEADER_TRUSTED_PROXIES: withLimits ? "192.0.2.10" : "127.0.0.1",
    // These servers send no email, so nothing proves who owns an invited
    // address; tests run on this machine alone, so invitations still let
    // people in, as most tests expect. The limits server keeps the default,
    // where an owner or admin approves those joins (tests/api/joining.spec.ts).
    ...(!withMail && !withLimits && !likeTestServer ? { INVITE_JOINS_WITHOUT_EMAIL: "true" } : {}),
    // KK_SEATS_SCHEDULE: when the job that records MSP clients' seats runs
    // (DESIGN.md, "Seats by client"), for a side server whose test needs it
    // to run now and again (tests/api/msp-seats.spec.ts), so the scheduler
    // checks four times a second there. Others keep the default, once a day.
    ...(keptData && process.env.KK_SEATS_SCHEDULE
      ? { MSP_SEATS_SCHEDULE: process.env.KK_SEATS_SCHEDULE, JOB_POLL_INTERVAL_MS: "250" }
      : {}),
    // KK_PLANS_ENFORCED=1: what an account or an organization gets depends on
    // its plan (DESIGN.md, "Plans and billing"). KK_ADMIN_TOKEN turns the admin
    // page on with that token, which is where the operator sets a plan by
    // hand. Both only for a side server a test starts itself
    // (tests/api/plans.spec.ts makes up the token for the run). Every other
    // server keeps the defaults: plans not enforced, and no admin page.
    ...(keptData && process.env.KK_PLANS_ENFORCED === "1" ? { PLANS_ENFORCED: "true" } : {}),
    // KK_PLAN_REMINDERS_SCHEDULE: when the plans' clock runs (trials for
    // whatever has no plan, sync notices, and the reminder emails), for a side
    // server whose test needs it to run now and again (tests/mail/plans.spec.ts),
    // so the scheduler checks four times a second there. Every other server
    // turns it off, so a run at 20 past the hour never moves a test's plans.
    ...(keptData && process.env.KK_PLAN_REMINDERS_SCHEDULE
      ? { PLAN_REMINDERS_SCHEDULE: process.env.KK_PLAN_REMINDERS_SCHEDULE, JOB_POLL_INTERVAL_MS: "250" }
      : { PLAN_REMINDERS_SCHEDULE: "" }),
    ...(keptData && process.env.KK_ADMIN_TOKEN ? { ADMIN_TOKEN: process.env.KK_ADMIN_TOKEN } : {}),
    // KK_BILLING_PROVIDER: the payment provider the server learns who has
    // paid from (DESIGN.md, "Learning who has paid"), with its API address and
    // the secrets a test makes up for the run (KK_BILLING_API_KEY,
    // KK_BILLING_WEBHOOK_SECRET, and KK_BILLING_WEBHOOK_SECRET_OLD while one is
    // replaced), and for Stripe its made-up prices (KK_BILLING_PRICE_PREMIUM,
    // KK_BILLING_PRICE_FAMILIES). KK_BILLING_LOOK_SCHEDULE runs the job that
    // asks it again that often, so the scheduler checks four times a second.
    // Only for a side server a test starts itself (tests/api/billing.spec.ts,
    // against billing-standin.mjs, and tests/api/stripe.spec.ts, against
    // stripe-standin.mjs); every other server has no provider.
    ...(keptData && process.env.KK_BILLING_PROVIDER
      ? {
          BILLING_PROVIDER: process.env.KK_BILLING_PROVIDER,
          BILLING_API_BASE: process.env.KK_BILLING_API_BASE ?? "",
          BILLING_API_KEY: process.env.KK_BILLING_API_KEY ?? "",
          BILLING_WEBHOOK_SECRET: process.env.KK_BILLING_WEBHOOK_SECRET ?? "",
          ...(process.env.KK_BILLING_WEBHOOK_SECRET_OLD
            ? { BILLING_WEBHOOK_SECRET_OLD: process.env.KK_BILLING_WEBHOOK_SECRET_OLD }
            : {}),
          ...(process.env.KK_BILLING_PRICE_PREMIUM !== undefined
            ? { BILLING_PRICE_PREMIUM: process.env.KK_BILLING_PRICE_PREMIUM }
            : {}),
          ...(process.env.KK_BILLING_PRICE_FAMILIES !== undefined
            ? { BILLING_PRICE_FAMILIES: process.env.KK_BILLING_PRICE_FAMILIES }
            : {}),
        }
      : {}),
    ...(keptData && process.env.KK_BILLING_LOOK_SCHEDULE
      ? { BILLING_LOOK_SCHEDULE: process.env.KK_BILLING_LOOK_SCHEDULE, JOB_POLL_INTERVAL_MS: "250" }
      : {}),
    // KK_BILLING_INVOICE_SCHEDULE: when the job that bills MSPs' pools and
    // Business by the day runs, with a seat's prices made up for the run
    // (KK_BILLING_SEAT_PRICES_MSP, KK_BILLING_SEAT_PRICES_BUSINESS), for a side
    // server a test starts itself (tests/api/invoices.spec.ts). Every other
    // server turns billing by the day off, so Stripe's servers there need no
    // seat prices and take no card for Business or a pool.
    ...(keptData && process.env.KK_BILLING_INVOICE_SCHEDULE
      ? {
          BILLING_INVOICE_SCHEDULE: process.env.KK_BILLING_INVOICE_SCHEDULE,
          JOB_POLL_INTERVAL_MS: "250",
          ...(process.env.KK_BILLING_SEAT_PRICES_MSP !== undefined
            ? { BILLING_SEAT_PRICES_MSP: process.env.KK_BILLING_SEAT_PRICES_MSP }
            : {}),
          ...(process.env.KK_BILLING_SEAT_PRICES_BUSINESS !== undefined
            ? { BILLING_SEAT_PRICES_BUSINESS: process.env.KK_BILLING_SEAT_PRICES_BUSINESS }
            : {}),
        }
      : { BILLING_INVOICE_SCHEDULE: "" }),
    // KK_PLANS_CAPS=1, for the plans tests' third server: the operator's own
    // caps, below what any plan gives (2 MB of attachments for a person, 3 MB
    // for an organization, and 1 MB of Send files), and a made-up key for the
    // data breach report, whose lookups the server is told never to make
    // (HTTP_REQUEST_BLOCK_REGEX), so nothing leaves this machine.
    ...(keptData && process.env.KK_PLANS_CAPS === "1"
      ? {
          USER_ATTACHMENT_LIMIT: "2048",
          ORG_ATTACHMENT_LIMIT: "3072",
          USER_SEND_LIMIT: "1024",
          HIBP_API_KEY: "made-up-for-tests",
          HTTP_REQUEST_BLOCK_REGEX: "haveibeenpwned\\.com",
        }
      : {}),
    ...(likeTestServer
      ? {
          SIGNUPS_ALLOWED: "false",
          SIGNUPS_DOMAINS_WHITELIST: process.env.KK_SIGNUPS_DOMAINS ?? "",
          // The server's own hashing of the hash the apps send, at its
          // least: in a debug build it takes most of the time of seeding
          // 31 people and taking them down, and nothing tested depends on it.
          PASSWORD_ITERATIONS: "100000",
        }
      : signUps === "closed"
        ? {
            SIGNUPS_ALLOWED: "false",
            SIGNUPS_DOMAINS_WHITELIST: process.env.KK_SIGNUPS_DOMAINS ?? "",
          }
        : { SIGNUPS_ALLOWED: "true" }),
    SIGNUPS_VERIFY: process.env.KK_SIGNUPS_VERIFY === "1" ? "true" : "false",
    // KK_MSP_SIGNUPS=off: nobody may set up an MSP, the default on a server
    // someone runs for themselves, for a side server the tests of MSPs signing
    // up by themselves start (tests/support/msp-signups-off.ts). Every other
    // server allows it, as the hosted service does.
    MSP_SIGNUPS_ALLOWED: process.env.KK_MSP_SIGNUPS === "off" ? "false" : "true",
    DISABLE_ICON_DOWNLOAD: "true",
    ...(siteRulesFeed
      ? {
          SITE_RULES_FEED: siteRulesFeed,
          SITE_RULES_FEED_KEY: process.env.KK_SITE_RULES_FEED_KEY ?? "",
          // The feed is on 127.0.0.1, which the server's fetch guard refuses
          // unless the operator allows private addresses.
          HTTP_REQUEST_BLOCK_NON_GLOBAL_IPS: "false",
        }
      : { SITE_RULES_FEED: "none" }),
    // Single sign-on goes to the local stand-in for Microsoft Entra ID, and
    // domain checks ask its DNS server (entra-standin.mjs).
    SSO_ENTRA_AUTHORITY: `http://127.0.0.1:${entraPort}`,
    SSO_DOMAIN_DNS_SERVER: `127.0.0.1:${dnsPort}`,
    // Every test logs in from 127.0.0.1, and some accounts many times. The
    // real limits (tests/api/login-limits.spec.ts) would fail tests depending
    // on how many ran before.
    // The same goes for signup and the other unauthenticated endpoints.
    ...(withLimits
      ? {}
      : {
          LOGIN_RATELIMIT_SECONDS: "1",
          LOGIN_RATELIMIT_MAX_BURST: "1000",
          LOGIN_RATELIMIT_ACCOUNT_SECONDS: "1",
          LOGIN_RATELIMIT_ACCOUNT_MAX_BURST: "1000",
          LOGIN_RATELIMIT_ACCOUNT_ANYWHERE_SECONDS: "1",
          LOGIN_RATELIMIT_ACCOUNT_ANYWHERE_MAX_BURST: "1000",
          UNAUTHENTICATED_RATELIMIT_SECONDS: "1",
          UNAUTHENTICATED_RATELIMIT_MAX_BURST: "1000",
        }),
    LOG_LEVEL: "warn",
    // Set KK_SERVER_LOG to keep the server's log, for example as a CI artifact.
    ...(process.env.KK_SERVER_LOG
      ? {
          LOG_FILE: process.env.KK_SERVER_LOG.replace(
            /(\.log)?$/,
            withNewDevice
              ? "-new-device$1"
              : likeTestServer
              ? "-test-tenants$1"
              : signUps
              ? "-sign-ups$1"
              : withMail
              ? "-mail$1"
              : sharesWith
              ? "-second$1"
              : siteRulesFeed
              ? `-site-rules-${port}$1`
              : withLimits
                ? "-limits$1"
                : withGroups
                  ? "-groups$1"
                  : keptData
                    ? "-restart$1"
                    : "$1",
          ),
          LOG_LEVEL: "info",
        }
      : {}),
  },
});

// The server's own process, by port, for a test that freezes or kills it
// as a crash would (tests/api/event-streaming-servers.spec.ts).
const pidNote = path.join(os.tmpdir(), `keykeeper-e2e-pid-${port}`);
fs.writeFileSync(pidNote, String(child.pid));

const stop = () => child.kill("SIGTERM");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// If whatever started us dies without stopping us, don't leave a server
// running on the test port for the next run to talk to by mistake.
const parent = process.ppid;
setInterval(() => {
  try {
    process.kill(parent, 0);
  } catch {
    stop();
  }
}, 1000).unref();
child.on("exit", (code) => {
  if (!keptData) {
    fs.rmSync(data, { recursive: true, force: true });
  }
  if (siemCert) {
    fs.rmSync(siemDir, { recursive: true, force: true });
  }
  fs.rmSync(dataNote, { force: true });
  fs.rmSync(pidNote, { force: true });
  process.exit(code ?? 0);
});
