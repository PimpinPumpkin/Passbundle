// Starts the server for one test run with a throwaway data folder,
// no outbound network features, and our built web vault.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { dnsPort, entraPort, paths, port, siemPort, smtpPort } from "./paths.mjs";

// KK_MAIL=1 starts the server that sends email to the mail catcher. KK_LIMITS=1
// starts one with the real login limits, which the others relax. KK_GROUPS=1
// starts one with groups turned on. Each always keeps its own SQLite file, so
// they never share a database with the main one.
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
// KK_DATA_DIR keeps the data in that folder, and keeps it when the server
// stops, so a test can start the same server again (reload-key.spec.ts: the
// server forgets reload keys when it restarts). Such a server is a side one.
const keptData = process.env.KK_DATA_DIR;
const side = withMail || withLimits || withGroups || withNewDevice || likeTestServer || !!keptData;

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
    // Set KK_DATABASE_URL to use PostgreSQL instead of a fresh SQLite file.
    ...(process.env.KK_DATABASE_URL && !side
      ? { DATABASE_URL: process.env.KK_DATABASE_URL }
      : {}),
    ...(withGroups ? { ORG_GROUPS_ENABLED: "true" } : {}),
    // KK_SINGLE_ORG_FOR_RECOVERY=1: account recovery needs single organization
    // first, as Bitwarden always does (tests/api/msp-required-policies.spec.ts).
    ...(process.env.KK_SINGLE_ORG_FOR_RECOVERY === "1"
      ? { ENFORCE_SINGLE_ORG_WITH_RESET_PW_POLICY: "true" }
      : {}),
    // Event streaming (tests/api/event-streaming.spec.ts): the main and
    // mail servers may send to receivers on 127.0.0.1 (and nothing else
    // private), and the main one sends Sentinel's sign-in and uploads to the
    // stand-in there, trusting its certificate. The others keep the
    // defaults, so the refusal of private addresses is tested too.
    ...(!withLimits && !withGroups && !keptData
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
    ...(keptData && process.env.KK_ADMIN_TOKEN ? { ADMIN_TOKEN: process.env.KK_ADMIN_TOKEN } : {}),
    ...(likeTestServer
      ? {
          SIGNUPS_ALLOWED: "false",
          SIGNUPS_DOMAINS_WHITELIST: process.env.KK_SIGNUPS_DOMAINS ?? "",
          // The server's own hashing of the hash the apps send, at its
          // least: in a debug build it takes most of the time of seeding
          // 31 people and taking them down, and nothing tested depends on it.
          PASSWORD_ITERATIONS: "100000",
        }
      : { SIGNUPS_ALLOWED: "true" }),
    SIGNUPS_VERIFY: "false",
    MSP_SIGNUPS_ALLOWED: "true",
    DISABLE_ICON_DOWNLOAD: "true",
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
              : withMail
              ? "-mail$1"
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
  process.exit(code ?? 0);
});
