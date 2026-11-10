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
// A server whose seats job runs every second, which the seats tests start
// themselves (tests/api/msp-seats.spec.ts).
export const seatsServerPort = process.env.KK_SEATS_SERVER_PORT ?? "8105";
// A server with the new-device check on, email, and a tiny location database,
// which the new-device check's tests start themselves (tests/api/
// new-device-check.spec.ts and the others named for it).
export const newDeviceServerPort = process.env.KK_NEW_DEVICE_SERVER_PORT ?? "8106";
// A server set up as the hosted test server is while the test tenants tool
// seeds it (server.mjs, KK_LIKE_TEST_SERVER), which the tool's tests start
// themselves (tests/api/test-tenants.spec.ts).
export const testTenantsServerPort = process.env.KK_TEST_TENANTS_SERVER_PORT ?? "8107";
// Two servers with the admin page on, which the plans tests start themselves
// (tests/api/plans.spec.ts): one that enforces plans (server.mjs,
// KK_PLANS_ENFORCED), and one that doesn't, as every other server here.
export const plansServerPort = process.env.KK_PLANS_SERVER_PORT ?? "8108";
export const plansOffServerPort = process.env.KK_PLANS_OFF_SERVER_PORT ?? "8109";
// Two more of the same, which the tests of what the web vault and the
// extension show on each plan start themselves (tests/plans-ui.spec.ts).
export const plansUiServerPort = process.env.KK_PLANS_UI_SERVER_PORT ?? "8112";
export const plansUiOffServerPort = process.env.KK_PLANS_UI_OFF_SERVER_PORT ?? "8113";
// A stand-in for Microsoft Entra ID's sign-in (entra-standin.mjs), which
// every test server uses for single sign-on, and its DNS server (UDP) for
// domain checks.
export const entraPort = process.env.KK_ENTRA_PORT ?? "8101";
export const dnsPort = process.env.KK_DNS_PORT ?? "8102";
// A server named vault.connectors.test, which the security key tests start
// themselves: WebAuthn won't take an IP address as a site's name
// (tests/connector-origins.spec.ts).
export const connectorServerPort = process.env.KK_CONNECTOR_SERVER_PORT ?? "8103";
// A server that sends email and needs single organization before account
// recovery (ENFORCE_SINGLE_ORG_WITH_RESET_PW_POLICY), which the policy tests
// start themselves (tests/api/msp-required-policies.spec.ts).
export const singleOrgServerPort = process.env.KK_SINGLE_ORG_SERVER_PORT ?? "8104";
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
// So does *.elsewhere.test, a second site (another base domain), where a
// redirect from an example.test page lands (open-and-fill.spec.ts).
export const hostResolverRules = `--host-resolver-rules=MAP *.example.test 127.0.0.1:${fixturePort}, MAP *.elsewhere.test 127.0.0.1:${fixturePort}, MAP www.airfrance.com 127.0.0.1:${fixturePort}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`;

// Chromium flag for the website's screenshots (site-shots/): the hosted
// service's name goes to the local test server, so screens and install
// commands show vault.passbundle.com, and everything else fails to resolve.
export const siteHost = new URL(brand.urls.webVault).host;
export const siteHostRules = `--host-resolver-rules=MAP ${siteHost} 127.0.0.1:${port}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`;
