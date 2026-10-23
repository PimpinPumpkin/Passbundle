// Starts the server for one test run with a throwaway data folder,
// no outbound network features, and our built web vault.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { paths, port, smtpPort } from "./paths.mjs";

// KK_MAIL=1 starts the server that sends email to the mail catcher. KK_LIMITS=1
// starts one with the real login limits, which the others relax. KK_GROUPS=1
// starts one with groups turned on. Each always keeps its own SQLite file, so
// they never share a database with the main one.
const withMail = process.env.KK_MAIL === "1";
const withLimits = process.env.KK_LIMITS === "1";
const withGroups = process.env.KK_GROUPS === "1";

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

const data = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-e2e-"));

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
const child = spawn(paths.serverBin, [], {
  stdio: "inherit",
  env: {
    PATH: process.env.PATH,
    DATA_FOLDER: data,
    // Set KK_DATABASE_URL to use PostgreSQL instead of a fresh SQLite file.
    ...(process.env.KK_DATABASE_URL && !withMail && !withLimits && !withGroups
      ? { DATABASE_URL: process.env.KK_DATABASE_URL }
      : {}),
    ...(withGroups ? { ORG_GROUPS_ENABLED: "true" } : {}),
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
    DOMAIN: `https://127.0.0.1:${port}`,
    SIGNUPS_ALLOWED: "true",
    SIGNUPS_VERIFY: "false",
    MSP_SIGNUPS_ALLOWED: "true",
    DISABLE_ICON_DOWNLOAD: "true",
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
            withMail ? "-mail$1" : withLimits ? "-limits$1" : withGroups ? "-groups$1" : "$1",
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
  fs.rmSync(data, { recursive: true, force: true });
  process.exit(code ?? 0);
});
