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
// Two servers with the admin page on, one that enforces plans and one that
// doesn't, which the tests of what the web vault and the extension show on
// each plan start themselves (tests/plans-ui.spec.ts).
export const plansUiServerPort = process.env.KK_PLANS_UI_SERVER_PORT ?? "8112";
export const plansUiOffServerPort = process.env.KK_PLANS_UI_OFF_SERVER_PORT ?? "8113";
// Two servers with the admin page on, which the plans tests start themselves
// (tests/api/plans.spec.ts): one that enforces plans (server.mjs,
// KK_PLANS_ENFORCED), and one that doesn't, as every other server here.
export const plansServerPort = process.env.KK_PLANS_SERVER_PORT ?? "8108";
export const plansOffServerPort = process.env.KK_PLANS_OFF_SERVER_PORT ?? "8109";
// A server that isn't taking new accounts, or takes them only at some email
// domains (server.mjs, KK_SIGNUPS), which the tests of what such a server
// says start themselves (tests/support/closed-server.ts).
export const closedServerPort = process.env.KK_CLOSED_SERVER_PORT ?? "8110";
// A server that doesn't let anyone set up an MSP (server.mjs,
// KK_MSP_SIGNUPS=off: MSP_SIGNUPS_ALLOWED as a self-hosted server has it),
// which the tests of MSPs signing up by themselves start themselves
// (tests/support/msp-signups-off.ts).
export const mspSignupsOffServerPort = process.env.KK_MSP_SIGNUPS_OFF_SERVER_PORT ?? "8115";
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
// A third plans server, which enforces plans with the operator's own caps on
// storage below what any plan gives, and a key for the data breach report
// (server.mjs, KK_PLANS_CAPS), which the plans tests start themselves.
export const plansCapsServerPort = process.env.KK_PLANS_CAPS_SERVER_PORT ?? "8111";
// A plans server that sends email and runs the plans' clock every second
// (server.mjs, KK_PLAN_REMINDERS_SCHEDULE), which the reminder emails' tests
// start themselves (tests/mail/plans.spec.ts).
export const plansMailServerPort = process.env.KK_PLANS_MAIL_SERVER_PORT ?? "8124";
// The servers the tests of learning who has paid start themselves
// (tests/api/billing.spec.ts): one with the payment provider's stand-in
// (billing-standin.mjs, on its own port), one while a signing secret is
// replaced, one that enforces plans with no provider, one with a provider and
// plans not enforced, and a port for servers that refuse to start.
export const billingServerPort = process.env.KK_BILLING_SERVER_PORT ?? "8120";
export const billingReplaceServerPort = process.env.KK_BILLING_REPLACE_SERVER_PORT ?? "8121";
export const billingNoProviderServerPort = process.env.KK_BILLING_NO_PROVIDER_SERVER_PORT ?? "8122";
export const billingOffServerPort = process.env.KK_BILLING_OFF_SERVER_PORT ?? "8123";
export const billingRefusedServerPort = process.env.KK_BILLING_REFUSED_SERVER_PORT ?? "8125";
export const billingStandinPort = process.env.KK_BILLING_STANDIN_PORT ?? "8127";
// The stand-in's pages, over HTTPS, where people are sent to pay or manage.
export const billingStandinPagesPort = process.env.KK_BILLING_STANDIN_PAGES_PORT ?? "8126";
// The tests of the Stripe adapter (tests/api/stripe.spec.ts): the stand-in for
// Stripe's API (stripe-standin.mjs) and its pages, over HTTPS; a server with
// Stripe as its provider, which sends email; one while a signing secret is
// rolled; one with Stripe set and plans not enforced; one that enforces plans
// with no provider; and a port for servers that refuse to start.
export const stripeStandinPort = process.env.KK_STRIPE_STANDIN_PORT ?? "8128";
export const stripeStandinPagesPort = process.env.KK_STRIPE_STANDIN_PAGES_PORT ?? "8129";
export const stripeServerPort = process.env.KK_STRIPE_SERVER_PORT ?? "8130";
export const stripeReplaceServerPort = process.env.KK_STRIPE_REPLACE_SERVER_PORT ?? "8131";
export const stripeOffServerPort = process.env.KK_STRIPE_OFF_SERVER_PORT ?? "8132";
export const stripeNoProviderServerPort = process.env.KK_STRIPE_NO_PROVIDER_SERVER_PORT ?? "8133";
export const stripeRefusedServerPort = process.env.KK_STRIPE_REFUSED_SERVER_PORT ?? "8134";
// The tests of a family's limits (tests/api/plans-families.spec.ts): a server
// that enforces plans, with groups and the event log on, and one that
// doesn't, each with the admin page on, which the tests start themselves.
export const familiesServerPort = process.env.KK_FAMILIES_SERVER_PORT ?? "8140";
export const familiesOffServerPort = process.env.KK_FAMILIES_OFF_SERVER_PORT ?? "8141";
// The tests of billing by the day (tests/api/invoices.spec.ts): a stand-in
// for Stripe's API (stripe-standin.mjs) and its pages of their own; a server
// with Stripe and billing by the day on, whose seats job and month job run
// every second; one with Stripe set and plans not enforced; one that enforces
// plans with no provider; and a port for servers that refuse to start.
export const invoicesStandinPort = process.env.KK_INVOICES_STANDIN_PORT ?? "8150";
export const invoicesStandinPagesPort = process.env.KK_INVOICES_STANDIN_PAGES_PORT ?? "8151";
export const invoicesServerPort = process.env.KK_INVOICES_SERVER_PORT ?? "8152";
export const invoicesOffServerPort = process.env.KK_INVOICES_OFF_SERVER_PORT ?? "8153";
export const invoicesNoProviderServerPort = process.env.KK_INVOICES_NO_PROVIDER_SERVER_PORT ?? "8154";
export const invoicesRefusedServerPort = process.env.KK_INVOICES_REFUSED_SERVER_PORT ?? "8155";
// The tests of event streaming across restarts and servers
// (tests/api/event-streaming-servers.spec.ts): a server that may send to
// receivers on 127.0.0.1, which they stop, kill, and start again on the same
// data; and a second server on the main test server's database.
export const streamingServerPort = process.env.KK_STREAMING_SERVER_PORT ?? "8160";
export const streamingSecondServerPort = process.env.KK_STREAMING_SECOND_SERVER_PORT ?? "8161";
// A server that may push to phones' endpoints on 127.0.0.1, trusting the
// stand-in push service's certificate, with the new-device check on, which
// the push tests start themselves (tests/api/unified-push.spec.ts).
export const unifiedPushServerPort = process.env.KK_UNIFIED_PUSH_SERVER_PORT ?? "8162";
// Tier 2 in Google Chrome (chrome/, playwright.chrome.config.ts): the site
// with passkeys whose checks we didn't write (chrome/relying-party.mjs),
// which Chrome reaches as www.harbor-books.test over HTTPS.
export const chromeSitePort = process.env.KK_CHROME_SITE_PORT ?? "8170";
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
