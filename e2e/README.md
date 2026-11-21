# End-to-end tests

Tier 1 runs on every commit (see [DESIGN.md](../DESIGN.md#testing)). The harness starts the server (`passbundle-server`) itself, over HTTPS with a throwaway certificate and an empty data folder, then drives the branded web vault and browser extension with Playwright.

## Run locally

The three repos sit side by side, in folders named `keykeeper`, `keykeeper-clients`, and `keykeeper-server` (or `passbundle-*`). Use Node 24.

```bash
cd ../keykeeper-server && cargo build --features sqlite
```

```bash
cd ../keykeeper-clients && npm ci && node brand/apply.mjs
```

```bash
cd ../keykeeper-clients/apps/web && npm run build:oss:selfhost:prod
```

```bash
cd ../keykeeper-clients/apps/browser && npm run build:prod:chrome
```

```bash
cd ../keykeeper-clients && node brand/apply.mjs --revert
```

```bash
npm ci && npx playwright install chromium && npx playwright test
```

Override any build location with `KK_SERVER_BIN`, `KK_WEB_VAULT`, `KK_EXTENSION`, or `KK_BRAND`, and the port with `KK_PORT` (default 8091).

`KK_DATABASE_URL` puts the main test server on that PostgreSQL database instead of a fresh SQLite file, as tier 1's PostgreSQL job does for the API tests. A server a test starts itself (`KK_DATA_DIR`) then gets a database of its own on the same PostgreSQL server, which `server.mjs` makes with `psql` when it first starts and names in the server's data folder, so the server starts again on the same data. A test that reads or changes its server's SQLite file itself keeps that file (`KK_SQLITE=1`: the billing, Stripe, invoices, seats, new-device check, and test tenants tests). The mail, limits, and groups servers keep SQLite files of their own.

The command-line tool's tests (`tests/cli`, project `cli`) run the packed program `KK_CLI` names, which `tools/cli/pack.sh` makes from the clients checkout (see docs/cli.md, "Building it yourself"); without it they skip, except in CI. They use `KK_BRAND`'s `cli` part for the command's name.

The autofill corpus (`tests/autofill-corpus.spec.ts`, project `corpus`) fills each page in `tests/fixtures/autofill` from the menu inside a field, with our extension and then with upstream's, and prints the two scores side by side; the summary, page by page, is `test-results/autofill-scoreboard.json`. Upstream's extension is the one `KK_UPSTREAM_EXTENSION` names, built by `upstream-extension.sh` from a checkout of upstream's release tag the clients are based on (their `.keykeeper-base`), made without `bitwarden_license/`; `KK_UPSTREAM_TAG` names that tag in the output. Without it, the corpus runs with ours only. `CORPUS_ONLY=<page>.html` runs one page.

Single sign-on tests use `entra-standin.mjs`, a local stand-in for Microsoft Entra ID's sign-in (an OpenID provider at Entra's per-tenant paths, with keys made when it starts) and a DNS server for domain checks, on `KK_ENTRA_PORT` (default 8101) and `KK_DNS_PORT` (UDP, default 8102). Every test server points at it.

The seats tests (`tests/api/msp-seats.spec.ts`) start a server of their own whose seats job runs every second (`KK_SEATS_SCHEDULE`), and write earlier days into its SQLite database, on `KK_SEATS_SERVER_PORT` (default 8105).

The new-device check's tests (`tests/api/new-device-check.spec.ts`, `tests/new-device-check.spec.ts`, `tests/cli/new-device-check.spec.ts`) start a server of their own with the check on (`KK_NEW_DEVICE=1`), email, and a tiny location database of made-up places (`fixtures/location/make.mjs`), on `KK_NEW_DEVICE_SERVER_PORT` (default 8106). Every other test server turns the check off, since its tests sign in from fresh browsers and API calls.

The tests of where a "Sign in with a device" request comes from (`tests/api/device-approval.spec.ts`) start a server of their own with the same location database and the check off (`KK_LOCATION=1`), on `KK_LOCATION_SERVER_PORT` (default 8114). The main test server has no location database, which is how the same tests see that nothing is shown without one.

The security key tests (`tests/connector-origins.spec.ts`) start a server of their own named `vault.connectors.test`, since WebAuthn won't take an IP address as a site's name, on `KK_CONNECTOR_SERVER_PORT` (default 8103).

The tests of what the web vault and the extension show on each plan (`tests/plans-ui.spec.ts`, `tests/plans-ui-extension.spec.ts`, and the Plan page and the plan banners in `tests/plans-page.spec.ts`) start two servers of their own with the admin page on, as the plans tests below do: one that enforces plans on `KK_PLANS_UI_SERVER_PORT` (default 8112), and one that doesn't on `KK_PLANS_UI_OFF_SERVER_PORT` (default 8113). They give and take away Premium the way the plans tests do.

The test tenants tests (`tests/api/test-tenants.spec.ts`, `tests/test-tenants-web.spec.ts`) run `tools/test-tenants` as a person would, against a server of their own set up as the hosted test server is while the tool seeds it (`KK_LIKE_TEST_SERVER=1`: no email, the new-device check on, and sign-up only at the tool's domains, `KK_SIGNUPS_DOMAINS`), on `KK_TEST_TENANTS_SERVER_PORT` (default 8107).

The closed sign-ups tests (`tests/mail/closed-sign-ups.spec.ts`, `tests/closed-sign-ups.spec.ts`) start a server of their own that isn't taking new accounts, or takes them only at some email domains (`KK_SIGNUPS=closed`, `KK_SIGNUPS_DOMAINS`), and start it again with other settings over the same data (`tests/support/closed-server.ts`): open first (`KK_SIGNUPS=open`), to make the accounts a closed server is then asked about, with and without email, and with the sign-up form's link sent by email (`KK_SIGNUPS_VERIFY=1`). It's on `KK_CLOSED_SERVER_PORT` (default 8108).

The tests of MSPs signing up by themselves (`tests/api/msp-signup.spec.ts`, `tests/msp-signup.spec.ts`) start a server of their own that doesn't let anyone set up an MSP (`KK_MSP_SIGNUPS=off`: `MSP_SIGNUPS_ALLOWED` off, as a server someone runs for themselves has it; every other test server allows it, as the hosted service does), on `KK_MSP_SIGNUPS_OFF_SERVER_PORT` (default 8115).

The required policy tests (`tests/api/msp-required-policies.spec.ts`) start a server of their own that sends email and needs single organization before account recovery (`KK_SINGLE_ORG_FOR_RECOVERY=1`, upstream's `ENFORCE_SINGLE_ORG_WITH_RESET_PW_POLICY`), on `KK_SINGLE_ORG_SERVER_PORT` (default 8104).

The plans tests (`tests/api/plans.spec.ts`) start three servers of their own with the admin page on (`KK_ADMIN_TOKEN`, a token made up for the run and kept in memory), since that's where the operator sets a plan by hand: one that enforces plans (`KK_PLANS_ENFORCED=1`) on `KK_PLANS_SERVER_PORT` (default 8108), one that doesn't on `KK_PLANS_OFF_SERVER_PORT` (default 8109), and one that enforces them under the operator's own storage caps, lower than any plan's, with a made-up key for the data breach report whose lookups it's told never to make (`KK_PLANS_CAPS=1`), on `KK_PLANS_CAPS_SERVER_PORT` (default 8111). They move a plan's dates, never the clock. The plans' emails (`tests/mail/plans.spec.ts`) start a fourth that enforces plans, sends email, and runs the plans' clock every second (`KK_PLAN_REMINDERS_SCHEDULE`), on `KK_PLANS_MAIL_SERVER_PORT` (default 8124). The tests of a family's limits (`tests/api/plans-families.spec.ts`) start two more with the admin page on, groups on (`KK_GROUPS=1`), and the event log on (`KK_EVENTS=1`, which no other server sets): one that enforces plans on `KK_FAMILIES_SERVER_PORT` (default 8140) and one that doesn't on `KK_FAMILIES_OFF_SERVER_PORT` (default 8141). Every other test server leaves plans unenforced and the admin page off, and turns the plans' clock off.

The tests of learning who has paid (`tests/api/billing.spec.ts`) start `billing-standin.mjs`, a stand-in for a payment provider, with an API key and a webhook signing secret made up for the run and kept in memory: its API, which the server's stand-in adapter calls, and the tests' controls on `KK_BILLING_STANDIN_PORT` (default 8127, plain HTTP on 127.0.0.1) and its pages, where people are sent to pay and manage, over HTTPS with a throwaway certificate on `KK_BILLING_STANDIN_PAGES_PORT` (default 8126). Its webhooks are signed with Stripe's published scheme. The tests start servers of their own with the admin page on: one with the stand-in as its provider (`KK_BILLING_PROVIDER=standin`) and the billing job running every second (`KK_BILLING_LOOK_SCHEDULE`), on `KK_BILLING_SERVER_PORT` (default 8120); one with two signing secrets, as while one is replaced, on `KK_BILLING_REPLACE_SERVER_PORT` (default 8121); one that enforces plans with no provider on `KK_BILLING_NO_PROVIDER_SERVER_PORT` (default 8122); one with a provider and plans not enforced on `KK_BILLING_OFF_SERVER_PORT` (default 8123); and servers set up wrong, which never start, on `KK_BILLING_REFUSED_SERVER_PORT` (default 8125). They read and age rows in those servers' SQLite databases, since the clock can't be moved.

The tests of the Stripe adapter (`tests/api/stripe.spec.ts`) start `stripe-standin.mjs`, a stand-in for Stripe's API, with a restricted key, signing secrets, and prices made up for the run and kept in memory. It answers only the endpoints the adapter calls, in the shapes Stripe's API reference shows, refuses a call without the run's key as a bearer or without the `Stripe-Version` the adapter pins, takes form-encoded requests only, and signs its webhooks as Stripe does (a `v1` for each signing secret, a fake `v0`, and Stripe's debugging entries). Its API and the tests' controls are on `KK_STRIPE_STANDIN_PORT` (default 8128, plain HTTP on 127.0.0.1), and its Checkout and portal pages on `KK_STRIPE_STANDIN_PAGES_PORT` (default 8129, HTTPS with a throwaway certificate). Nothing talks to Stripe. The tests start servers of their own with the admin page on: one with Stripe as its provider that sends email (for the emailed way to delete an account), on `KK_STRIPE_SERVER_PORT` (default 8130); one with two signing secrets, as while one is rolled, on `KK_STRIPE_REPLACE_SERVER_PORT` (default 8131); one with Stripe set and plans not enforced on `KK_STRIPE_OFF_SERVER_PORT` (default 8132); one that enforces plans with no provider on `KK_STRIPE_NO_PROVIDER_SERVER_PORT` (default 8133); and servers set up wrong, which never start, on `KK_STRIPE_REFUSED_SERVER_PORT` (default 8134).

The tests of billing by the day (`tests/api/invoices.spec.ts`) start `stripe-standin.mjs` again, on ports of their own: its API and controls on `KK_INVOICES_STANDIN_PORT` (default 8150) and its pages on `KK_INVOICES_STANDIN_PAGES_PORT` (default 8151). In setup mode its Checkout page saves a card to the customer, and an invoice waits for a test to say how Stripe's collection goes (paid, or the card declined). A test can also make one kind of call fail before it's done, or after it's done with its answer lost, and forget its idempotency keys, as a day passing does. The tests start servers of their own with the admin page on, a seat's prices made up for the run, and the seats job and the month job running every second (`KK_SEATS_SCHEDULE`, `KK_BILLING_INVOICE_SCHEDULE`): one with Stripe as its provider on `KK_INVOICES_SERVER_PORT` (default 8152), which one test stops and starts again on the same data, as a crash would; one with Stripe set and plans not enforced on `KK_INVOICES_OFF_SERVER_PORT` (default 8153); one that enforces plans with no provider on `KK_INVOICES_NO_PROVIDER_SERVER_PORT` (default 8154); and servers set up wrong, which never start, on `KK_INVOICES_REFUSED_SERVER_PORT` (default 8155). They write the month before this one's seats into those servers' SQLite databases, since the clock can't be moved, and that's the month the job invoices.

The tests of event streaming across restarts and servers (`tests/api/event-streaming-servers.spec.ts`) start a server of their own that keeps its data and may send to receivers on 127.0.0.1 (`KK_EVENT_STREAMING=1`), which they stop, freeze, kill, and start again on the same data, on `KK_STREAMING_SERVER_PORT` (default 8160). The one that kills it mid-send waits out the two-minute lease the killed server held; the one that stops it normally mid-send doesn't, since a server that stops normally gives its leases back. They also start a second server on the main test server's database and RSA key (`KK_SHARES_DATABASE_OF`: its SQLite file, or PostgreSQL in the PostgreSQL job), on `KK_STREAMING_SECOND_SERVER_PORT` (default 8161).

The site rules tests (`tests/site-rules.spec.ts`) sign the hand-made rules (`tools/site-rules/rules.json`) with the test vectors' key through `tools/site-rules/sign.mjs`, serve the feed over plain HTTP on 127.0.0.1 on `KK_SITE_RULES_FEED_PORT` (default 8190), and start two servers of their own that mirror it as an operator's feed (`KK_SITE_RULES_FEED`, `KK_SITE_RULES_FEED_KEY`): one as signed on `KK_SITE_RULES_SERVER_PORT` (default 8191), and one with a byte of its manifest changed on `KK_SITE_RULES_CHANGED_SERVER_PORT` (default 8192). Every other test server mirrors no feed (`SITE_RULES_FEED=none`), so none reaches PassBundle's feed on the internet.

## Website screenshots

`site-shots/` makes the website's screenshots from the real apps (`npx playwright test -c playwright.site.config.ts`). It isn't a test and CI doesn't run it. See `site/README.md`.

## Rules

- No retries. A flaky test gets fixed, not rerun.
- No sleeps. Wait on what the page shows.
- No live network beyond the local server.
- Timezone UTC, locale en-US.

## Google Chrome (tier 2)

`chrome/` runs the extension's passkeys in Google Chrome's stable channel as installed on the machine (Playwright's channel `chrome`, never its own Chromium), with the extension loaded unpacked as a person loads it, against the main test server and Harbor Books (`chrome/relying-party.mjs`), a site whose server is SimpleWebAuthn's library, at `https://www.harbor-books.test` on `KK_CHROME_SITE_PORT` (default 8170). The test makes a certificate authority for the site, which only its own Chrome trusts. See DESIGN.md, "Passkeys".

```bash
npx playwright test -c playwright.chrome.config.ts
```

It needs Google Chrome installed (it never downloads one) and the same builds as the rest. Chrome runs headless unless `KK_CHROME_HEADED=1`; CI runs it with a window, on a virtual display (`.github/workflows/tier2-chrome.yml`, nightly). Each Chrome gets a new profile in a temporary folder, never your own.

## Windows (tier 2)

`installer/windows/tests/Test-Install.ps1` applies the policies on a disposable Windows machine, then `npx playwright test -c playwright.windows.config.ts` checks that real Chrome and Edge report them. Between the two, `installer/windows/tests/Test-Rerun.ps1` runs the install script again, with the same build and with another, while the agent, its host, and the app run from Program Files, and `installer/windows/tests/Test-AgentUpdate.ps1` installs a test release of the agent, its host, and the app, and has the SYSTEM update task take it to the next one from a stand-in for the update site, signed with a throwaway key. CI runs them nightly, and for pull requests that change the Windows installer, on `windows-latest`.
