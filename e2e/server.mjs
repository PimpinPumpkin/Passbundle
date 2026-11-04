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
// KK_DATA_DIR keeps the data in that folder, and keeps it when the server
// stops, so a test can start the same server again (reload-key.spec.ts: the
// server forgets reload keys when it restarts). Such a server is a side one.
const keptData = process.env.KK_DATA_DIR;
const side = withMail || withLimits || withGroups || !!keptData;

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
    ...(!withMail && !withLimits ? { INVITE_JOINS_WITHOUT_EMAIL: "true" } : {}),
    SIGNUPS_ALLOWED: "true",
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
            withMail
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
