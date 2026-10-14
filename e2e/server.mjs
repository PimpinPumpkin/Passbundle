// Starts keykeeper-server for one test run with a throwaway data folder,
// no outbound network features, and our built web vault.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { paths, port } from "./paths.mjs";

for (const [name, p] of Object.entries({ server: paths.serverBin, webVault: paths.webVault })) {
  if (!fs.existsSync(p)) {
    console.error(`e2e: ${name} not found at ${p}. Build it first (see e2e/README.md).`);
    process.exit(1);
  }
}

const data = fs.mkdtempSync(path.join(os.tmpdir(), "keykeeper-e2e-"));

// Release builds of the clients refuse plain HTTP, so serve HTTPS with a
// throwaway certificate. Browsers in the tests are told to accept it.
const cert = path.join(data, "cert.pem");
const key = path.join(data, "key.pem");
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
  "-keyout", key, "-out", cert,
  "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
], { stdio: "ignore" });
const child = spawn(paths.serverBin, [], {
  stdio: "inherit",
  env: {
    PATH: process.env.PATH,
    DATA_FOLDER: data,
    WEB_VAULT_FOLDER: paths.webVault,
    WEB_VAULT_ENABLED: "true",
    ROCKET_ADDRESS: "127.0.0.1",
    ROCKET_PORT: port,
    ROCKET_TLS: `{certs="${cert}",key="${key}"}`,
    DOMAIN: `https://127.0.0.1:${port}`,
    SIGNUPS_ALLOWED: "true",
    SIGNUPS_VERIFY: "false",
    DISABLE_ICON_DOWNLOAD: "true",
    // Every test logs in from 127.0.0.1. The default (a burst of 10, then one
    // per minute per IP) would fail tests depending on how many ran before.
    LOGIN_RATELIMIT_SECONDS: "1",
    LOGIN_RATELIMIT_MAX_BURST: "1000",
    LOG_LEVEL: "warn",
  },
});

const stop = () => child.kill("SIGTERM");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => {
  fs.rmSync(data, { recursive: true, force: true });
  process.exit(code ?? 0);
});
