// Where the harness finds the builds. Defaults assume the three repos are
// checked out side by side; CI overrides them with environment variables.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sibling = (...p) => path.resolve(here, "../..", ...p);
// A sibling repo, under its PassBundle folder name or the code name.
const repo = (name, ...p) =>
  fs.existsSync(sibling(`passbundle-${name}`))
    ? sibling(`passbundle-${name}`, ...p)
    : sibling(`keykeeper-${name}`, ...p);

export const port = process.env.KK_PORT ?? "8091";
export const fixturePort = process.env.KK_FIXTURE_PORT ?? "8093";
// A second test server that sends email, to the mail catcher.
export const mailServerPort = process.env.KK_MAIL_SERVER_PORT ?? "8094";
export const smtpPort = process.env.KK_SMTP_PORT ?? "2525";
export const mailHttpPort = process.env.KK_MAIL_HTTP_PORT ?? "8096";
// A third test server with the real login limits (the others relax them).
export const limitsServerPort = process.env.KK_LIMITS_SERVER_PORT ?? "8097";
// A fourth with groups turned on explicitly (ORG_GROUPS_ENABLED), so the
// Access page's tests don't depend on the server's default.
export const groupsServerPort = process.env.KK_GROUPS_SERVER_PORT ?? "8098";
// Where the main test server sends Sentinel destinations' sign-in, for the
// stand-in in tests/api/siem.ts (event streaming).
export const siemPort = process.env.KK_SIEM_PORT ?? "8099";
// A server a test starts and stops itself, keeping its data, to show what a
// restart forgets (tests/reload-key.spec.ts).
export const restartServerPort = process.env.KK_RESTART_SERVER_PORT ?? "8100";
// A stand-in for Microsoft Entra ID's sign-in (entra-standin.mjs), which
// every test server uses for single sign-on, and its DNS server (UDP) for
// domain checks.
export const entraPort = process.env.KK_ENTRA_PORT ?? "8101";
export const dnsPort = process.env.KK_DNS_PORT ?? "8102";
export const paths = {
  serverBin:
    process.env.KK_SERVER_BIN ??
    repo("server", "target/debug/vaultwarden"),
  webVault:
    process.env.KK_WEB_VAULT ?? repo("clients", "apps/web/build"),
  extension:
    process.env.KK_EXTENSION ?? repo("clients", "apps/browser/build"),
  brand: process.env.KK_BRAND ?? repo("clients", "brand/brand.json"),
  // The desktop agent and its native-messaging host, built with the
  // stand-in authenticator: `cargo build --features test-authenticator`.
  agent: process.env.KK_AGENT ?? repo("apps", "agent/target/debug"),
};
export const brand = JSON.parse(fs.readFileSync(paths.brand, "utf8"));

// Chromium flag: *.example.test goes to the local fixture server, and every
// other hostname except the test server fails to resolve. No live network.
// airfrance.com goes to the fixture server too: it's a site with published
// password rules (site-password-rules.spec.ts), and nothing reaches the real one.
export const hostResolverRules = `--host-resolver-rules=MAP *.example.test 127.0.0.1:${fixturePort}, MAP www.airfrance.com 127.0.0.1:${fixturePort}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`;

// Chromium flag for the website's screenshots (site-shots/): the hosted
// service's name goes to the local test server, so screens and install
// commands show vault.passbundle.com, and everything else fails to resolve.
export const siteHost = new URL(brand.urls.webVault).host;
export const siteHostRules = `--host-resolver-rules=MAP ${siteHost} 127.0.0.1:${port}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`;
