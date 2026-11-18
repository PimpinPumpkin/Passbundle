# The PassBundle image

PassBundle's server and branded web vault in one container image, for the hosted service and for anyone who runs their own.

- **What's in it:** the server built for production (`cargo build --release`, SQLite and PostgreSQL in one binary, and S3-compatible storage for files) and the branded web vault, on Debian 13 slim. It runs as an unprivileged user (uid 10001) on port 8080, keeps its data in `/data`, and has a health check on `/alive`.
- **How it's made:** the Release workflow (`.github/workflows/release.yml`) builds both from the `keykeeper` branches, or from the branches, tags, or commits you give it when you run it by hand. A pull request whose branch name also exists in the server or clients repo uses that branch there. It builds the image from `deploy/Dockerfile` and runs `deploy/smoke.sh`, then keeps the image as the `image` artifact for 14 days. It runs for every push to main, for pull requests that change this folder, and for a release tag, which also publishes the image ("Making a release"). The smoke test starts the image on SQLite and on PostgreSQL, checks it serves PassBundle's web vault, makes an account, signs in, and signs in again after a restart. Then it checks the client's address as the hosted service sets it up (below): the server refuses to start on a public address without `IP_HEADER`, believes `CF-Connecting-IP` only from the tunnel's address, and ignores the same headers sent from anywhere else.
- **Labels** say where it came from: this repository and its commit (`org.opencontainers.image.source`, `org.opencontainers.image.revision`), the commit of the server and the clients it was built from (`com.passbundle.server-commit`, `com.passbundle.clients-commit`), the license (`org.opencontainers.image.licenses`, `AGPL-3.0-only`), and for a release its version (`org.opencontainers.image.version`).

## Getting the image

Each release is published to GitHub's container registry as `ghcr.io/pimpinpumpkin/passbundle`, tagged with its version (like `0.1.0`), and the newest also as `latest`. There's no release yet: the first is the owner's to tag ("Making a release"), and until then there's no image to pull. Run the Release workflow instead and load its `image` artifact, which is `passbundle:release`:

```sh
gunzip -c passbundle-image.tar.gz | docker load
```

Once there's a release:

```sh
docker pull ghcr.io/pimpinpumpkin/passbundle:0.1.0
```

### Checking where it came from

A release's image is signed with cosign without a key: Sigstore gives the Release workflow a certificate for its identity on GitHub, good for a few minutes, and keeps the signature in its public log. Check it with cosign 3 or later. The identity is this repository's Release workflow running for the release's tag, and the issuer is GitHub's token service:

```sh
version=0.1.0
cosign verify ghcr.io/pimpinpumpkin/passbundle:$version \
  --certificate-identity "https://github.com/PimpinPumpkin/Passbundle/.github/workflows/release.yml@refs/tags/server-v$version" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

It also has GitHub's build provenance attestation, which says which workflow run built it, from which commit of this repository. Check it with the GitHub CLI, signed in to GitHub:

```sh
gh attestation verify oci://ghcr.io/pimpinpumpkin/passbundle:$version \
  --repo PimpinPumpkin/Passbundle \
  --signer-workflow PimpinPumpkin/Passbundle/.github/workflows/release.yml \
  --source-ref refs/tags/server-v$version
```

Both check the image the tag points to when you run them. A tag can be moved and a digest can't, so to run exactly what you checked, use its digest: after `docker pull`, `docker image inspect --format '{{index .RepoDigests 0}}' ghcr.io/pimpinpumpkin/passbundle:$version` prints `ghcr.io/pimpinpumpkin/passbundle@sha256:...`, which both checks and `docker run` take in place of the tag. The image's labels (above) name the server and clients commits in it, the same ones `deploy/release-commits.txt` names at the release's tag.

## Running it

```sh
docker network create --subnet 172.30.53.0/24 --ip-range 172.30.53.128/25 passbundle
docker run -d --name passbundle --network passbundle -v passbundle-data:/data \
  -e DOMAIN=https://vault.example.com -e IP_HEADER=X-Real-IP -e IP_HEADER_TRUSTED_PROXIES=172.30.53.2 \
  passbundle:release
```

With a release, use `ghcr.io/pimpinpumpkin/passbundle:<version>` in place of `passbundle:release`.

The apps refuse a server that isn't HTTPS, so put it behind something that serves HTTPS: a reverse proxy, or a Cloudflare tunnel, as the hosted service does. This example is for a reverse proxy that sets `X-Real-IP`, running as a container on the same network at the fixed address 172.30.53.2 (`--ip 172.30.53.2`), outside the range Docker hands out, and reaching the server at `http://passbundle:8080`. Requests that come in through a published port arrive from an address Docker chooses, so a proxy outside Docker is best trusted only if nothing else can reach the server. The hosted service runs its tunnel the same way, in its Compose stack (the private ops repo's `hosting/`).

### The client's address

Login limits, a script token's allowed networks, the address a sign-in request shows, and every log and event record the visitor's address. Behind a proxy, the server sees only the proxy's, so it reads the visitor's from a header the proxy sets. A header is only as good as the proxy that sets it: one a client sends itself must never get through.

- **`IP_HEADER`**: the header your proxy puts the visitor's address in. On a public `DOMAIN` the server doesn't start until it's set, because the default (`X-Real-IP`) passes through Cloudflare, and some proxies, as the client sent it.
  - Behind Cloudflare, a Cloudflare tunnel included: `CF-Connecting-IP`, which Cloudflare sets itself and a client can't.
  - Behind a reverse proxy that overwrites `X-Real-IP` with the address it got the request from (Caddy: `header_up X-Real-IP {remote_host}`; nginx: `proxy_set_header X-Real-IP $remote_addr`): `X-Real-IP`.
  - With nothing in front: `none`.
- **`IP_HEADER_TRUSTED_PROXIES`**: the proxy's exact address, so nothing else on the server's networks can set the header. `local` (the default) trusts any non-public address, which is fine only when nothing but the proxy can reach the server; `all` trusts anyone and is never right on a public server.
- Both are set only in the environment, never on the admin page.

### Defaults on a public server

A server whose `DOMAIN` is a public `https://` address (not localhost, a private address, or a name like `.local`, `.test`, or `.internal`) gets safer defaults for what you leave unset:

| Setting | Default there | Elsewhere |
|---|---|---|
| `SIGNUPS_VERIFY` | `true`: people verify their email address before they sign in (needs email) | `false` |
| `USER_ATTACHMENT_LIMIT`, `ORG_ATTACHMENT_LIMIT` | 1048576 (1 GB, in KB) of file attachments per person and per organization; none where `PLANS_ENFORCED` is on, since each plan says how much (see "Plans") | no limit |
| `USER_SEND_LIMIT` | 1048576 (1 GB, in KB) of Send files per person | no limit |

Set any of them to choose otherwise; `-1` means no limit. Set `SIGNUPS_ALLOWED` and `ORG_CREATION_USERS` on purpose too: whether anyone may make an account, and who may make organizations (`all`, `none`, or a list of emails).

The settings are the server's environment variables, as in Vaultwarden. The ones that matter most:

| Variable | What it does |
|---|---|
| `DOMAIN` | The address people use, with `https://`. Links in emails and passkeys depend on it. |
| `DATABASE_URL` | `postgresql://user:password@host/db` for PostgreSQL. Without it, SQLite in `/data`. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM` | Email. Account recovery, emailed invitations, join emails, and email domain limits need it. |
| `SIGNUPS_ALLOWED` | Whether anyone can make an account. |
| `MSP_SIGNUPS_ALLOWED` | Whether anyone can set up an MSP. |
| `ADMIN_TOKEN` | Turns on the server's admin page. Leave it unset in production; turn it on for a task, then off again (see "The admin page"). |
| `HSTS_INCLUDE_SUBDOMAINS` | `true` adds `includeSubDomains` to the HTTPS-only header (HSTS) the server sends when `DOMAIN` is https on a host name. Off by default; turn it on only when every name under `DOMAIN`'s host serves HTTPS. |
| `IP_HEADER`, `IP_HEADER_TRUSTED_PROXIES` | Where the visitor's address comes from (see "The client's address"). Required on a public `DOMAIN`. |
| `ORG_CREATION_USERS` | Who may make organizations: `all`, `none`, or a list of emails. |
| `ORG_ITEM_HISTORY_LIMIT` | The most an organization's item history may take, in KB (1048576, 1 GB, by default). Past it, an edit keeps a version only if it's 64 KB or less, as real items are. |
| `INVITE_JOINS_WITHOUT_EMAIL` | On a server that sends no email, whether an invitation still lets the person in without approval. Off by default: without email, nothing proves who owns the address, so whoever signs up with it first would get in. Only for a server nobody else can reach. |
| `NEW_DEVICE_CHECK` | On by default: an account without two-step login that signs in on a device it has never used waits until the person types the new device's number on one of their signed-in devices, or uses a code by email (DESIGN.md, "New-device check"). Turn it off only for a test server. |
| `IP_LOCATION_DATABASE` | An IP-to-location database (MaxMind DB format) for showing roughly where a sign-in comes from; `/data/ip-location.mmdb` by default. It isn't in the image: put DB-IP's free IP to City Lite there with passbundle-server's `tools/update-ip-location.sh` (on the host, against the folder mounted as `/data`), monthly. Without it, no location is shown. The server never asks another service. `IP_LOCATION_ATTRIBUTION` and `IP_LOCATION_ATTRIBUTION_URL` credit it (DB-IP's credit by default, as its CC BY 4.0 license asks); set them if you use another database. |
| `PLANS_ENFORCED` | Off by default, and a self-hosted server leaves it off: every account and organization gets everything, as before. On, what each gets follows the plan recorded for it, the apps are told in the sync, and Free can't attach or send files, or get the data breach report where the server has a key for it (see "Plans"). Set only in the environment. Its figures: `PLAN_TRIAL_DAYS` (30), `PLAN_GRACE_DAYS` (14), `PLAN_PREMIUM_STORAGE_GB` (5), `PLAN_FAMILIES_PEOPLE` (6), `PLAN_ORG_STORAGE_GB_PER_PERSON` (1), and `PLAN_ORG_STORAGE_MIN_GB` (5). The plans' clock runs on `PLAN_REMINDERS_SCHEDULE` (`0 20 * * * *`, hourly, 20 minutes past the hour; blank turns it off). |
| `BILLING_PROVIDER` | Empty by default, and it does nothing unless `PLANS_ENFORCED` is on: plans are then set only by hand. Set, the server learns who has paid from that payment provider (see "Plans"). Set only in the environment, with its secrets. |
| `SITE_FIXES_NEED_APPROVAL` | Whether a shared site fix fills for everyone only once you approve it on the admin page's Sites list, as well as once three people with verified email addresses shared it. |
| `ATTACHMENTS_FOLDER`, `SENDS_FOLDER` | Where file attachments and Send files go. A folder in `/data` by default, or object storage: `s3://bucket/attachments?endpoint=https://...&region=auto&default_storage_class=STANDARD`, with `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. They're encrypted by the apps before upload, like everything else. |

## The admin page

`ADMIN_TOKEN` turns on the server's admin page at `/admin`, which can delete accounts and organizations and change settings. Someone who gets the token can do all of that, so leave it unset in production: set it, use the page, and unset it again (restart the container both times). Use an Argon2 hash (`passbundle-server hash`), never the token itself.

Settings that could quietly send people's secrets somewhere else are set only in the environment, so the admin page can't change them: `DOMAIN` (links in emails and passkeys), every `SMTP_*` setting (sign-in codes and links go by email), `IP_HEADER` and `IP_HEADER_TRUSTED_PROXIES`, `EVENT_STREAMING_ALLOWED_NETWORKS`, `HTTP_REQUEST_BLOCK_REGEX` and `HTTP_REQUEST_BLOCK_NON_GLOBAL_IPS`, `YUBICO_SERVER`, and `DUO_HOST`. A value for one of them saved on the admin page before is ignored.

## Plans

The server keeps at most one plan for each person, organization, and MSP: which plan, a date it's free until (a trial or an offer), a date it's paid through or that it's paid for as it goes, and whether it renews. With `PLANS_ENFORCED` off, the default, a recorded plan changes nothing. With it on, a person gets Premium's features while their own plan is in effect, or while they hold a place in an organization, or are on the staff of an MSP, whose plan is; an MSP's plan covers each of its clients, whatever plan a client has of its own. A plan that's paid through a date and renews stays in effect for `PLAN_GRACE_DAYS` after that date; one that doesn't renew ends on it. Nothing is billed unless a payment provider is set (below).

Trials start by themselves where plans are enforced: a new organization (Business, for now) and a new MSP's pool get `PLAN_TRIAL_DAYS` free from the moment they're made, and a client that leaves its MSP gets them from that moment. An organization or an MSP found with no plan gets them from when it's found, so turning `PLANS_ENFORCED` on ends nothing at once. A person gets no trial. A trial ends on its date, with no grace after it.

The plans' clock (`PLAN_REMINDERS_SCHEDULE`) does nothing while plans aren't enforced. Where they are, it gives a trial to any organization or MSP with no plan, tells the people a plan reaches to sync when its state changes by the clock, and emails whoever manages the plan (an organization's owners, an MSP's admins, or the person), each email once: a trial ending in 7 days and in 1 day, and for a plan that renews, 3 days before its grace ends and when it has. They say the date, what stops, and that nothing is deleted. It needs the server to send email; without it, only the trials and the sync notices happen.

With `PLANS_ENFORCED` on, the server refuses only adding, each time with one sentence the apps show:

- Attaching a file to a person's own item goes by their plan: none on Free ("Attaching files is part of Premium."), and `PLAN_PREMIUM_STORAGE_GB` with Premium ("Your 5 GB for attachments is full. Delete some to make room."). A shared item goes by its organization's plan: `PLAN_ORG_STORAGE_GB_PER_PERSON` for each person in it, and never less than `PLAN_ORG_STORAGE_MIN_GB`. The sentences name the organization, and once its plan has ended nothing new can be attached.
- Creating a file Send needs Premium ("Sending files is part of Premium. Sending text is free."). How much a person may keep in Send files stays `USER_SEND_LIMIT`, on every plan.
- The data breach report needs Premium ("The data breach report is part of Premium."), where the server has an `HIBP_API_KEY`. Without one, the report is a link to that site's own free page, for everyone.
- `USER_ATTACHMENT_LIMIT` and `ORG_ATTACHMENT_LIMIT` have no default on a public server while plans are enforced. Set one, and no plan gives more than it; the sentence then says that figure.
- A family (an organization whose plan is `families`) covers `PLAN_FAMILIES_PEOPLE` people. Everyone invited or joined who isn't revoked counts, the owner included, at every way in: inviting one or several, resending an invitation, accepting, confirming, and restoring ("A Families plan covers 6 people, and this one has 6. Remove someone first."). Someone already counted is refused only while the family has more people than that, as one that had more before it was a family does. Invitations sent at once can't take the same place.
- A family has none of the company features. Where one would be added or turned on, the server says "That's part of the Business plan.": policies, groups, event destinations, single sign-on, provisioning and the directory's import, account recovery, custom roles, the install command, and the organization's API key. Turning one off and removing what's there go on, and the event log and the groups list answer empty. The sync and the organization itself say `seats` 6 and the company features off, so the web vault hides them.
- Once an organization's plan has ended (or the MSP's that covers it), nothing new is added to it: no new people by any route (inviting, resending an invitation, accepting, confirming, restoring, the install command, provisioning, the directory's import), no new shared items or items moved or imported into it, no new shared folders or groups, no new files on its items, and no new event destinations ("This organization's plan has ended, so nothing new can be added. Everything in it can still be opened, changed, exported, and deleted."). Its members' Premium features from it stop. Everything else goes on: signing in, sync, opening, editing, and deleting its items, exporting, downloading and removing files, leaving, removing and revoking people (provisioning and the directory still remove them), and deleting it. It stays enabled.
- An MSP whose plan has ended takes on no new client, invites nobody to its staff, and adds no event destination ("This MSP's plan has ended, so nothing new can be added to its clients. Everything in them can still be opened, changed, exported, and deleted."). Its console, its staff's access to its clients, removing staff, and handing a client back go on.

Downloading and removing files never look at a plan: a file attached with Premium downloads and can be removed on Free, and storage that's over its limit refuses new files and nothing else. A file Send made with Premium works until it expires or is deleted.

Only the admin page sets a plan, so only someone with `ADMIN_TOKEN` can, and each change is written to the server's log with what the plan was before. Signed in to `/admin`:

- `GET /admin/plans/<users|organizations|msps>/<id>` reads the plan recorded for that person, organization, or MSP, and what applies to it now.
- `POST /admin/plans/<users|organizations|msps>/<id>` sets it, with a JSON body: `plan` (`premium` for a person; `families` or `business` for an organization; `msp` for an MSP), `standing` (`none`, `until`, or `open`), `until` (a time, with `standing` `until`), `renews`, and optionally `freeUntil` with `freeWhy` (`trial` or `offer`) and `billed` (`prepaid`, `by_the_day`, or `by_hand`, the default). Times are UTC, like `2027-01-31T00:00:00Z`.
- `POST /admin/plans/<users|organizations|msps>/<id>/remove` removes it.

The people a changed plan reaches are told to sync. People read their own plan, and the plan of an organization or MSP they manage, at `GET /api/keykeeper/plan`; nobody sets one there.

### A payment provider

`BILLING_PROVIDER` names the provider the server learns who has paid from. It's empty by default, and does nothing unless `PLANS_ENFORCED` is on. `stripe` is Stripe (below); `standin` is the test stand-in in this repository's `e2e/billing-standin.mjs`. With both set:

- People pay and manage on the provider's own pages. `POST /api/keykeeper/plan/pay` (JSON: `plan`, and `organization` or `msp`, or neither for a person's own Premium) and `POST /api/keykeeper/plan/manage` (`organization` or `msp`, or neither) answer `{"url": ...}`, a page on the provider's site that sends them back to the Plan page. `POST /api/keykeeper/plan/look` (the same) asks the provider now, at most once a minute for each plan. They answer only whoever may pay for the plan, which the sync's `canPay` says: a person for their own Premium, an organization's owners for its plan, and an MSP's admins for the pool. Everyone else, and a client of an MSP, gets 404.
- The provider's webhooks go to `POST /api/keykeeper/billing/events/<provider>`. Before anything in one is believed: its body is at most 1 MiB, its signature is good with a signing secret in use, its timestamp is within five minutes of the server's clock (keep the clock right), its id hasn't come before (ids are kept 35 days), and it's for the provider's mode. A refusal is an empty 400, logged with why and the address it came from, never the body. Then it only makes the server ask the provider about that customer and write what the provider says: a webhook never sets a plan itself.
- The server asks again on its own (`BILLING_LOOK_SCHEDULE`, hourly by default): each plan the provider set whose last answer is a day old, each whose paid-through date has passed since, and each a webhook asked about whose look got no answer. When the provider can't be reached, the plan stays as the provider last said. After a day without an answer the log gets an error on each run, saying how many plans; each plan's `checkedAt` (`GET /admin/plans/...`) says when the provider last answered.
- A provider's answer that something is or was paid sets the plan (`setBy` `provider`). An answer that nothing is paid ends only a plan the provider set: a trial, or a plan you set by hand, stands.
- Someone the provider already bills for a plan that's in effect, in good standing or in grace, who asks to pay again gets the page to manage it instead of a second subscription. The server asks the provider first, so a payment whose webhook hasn't come yet counts.
- An MSP's pool and a Business organization with no MSP are billed by the day after each month, where `BILLING_INVOICE_SCHEDULE` isn't blank (hourly by default; set it blank to turn this off). Paying for one is putting a card on file, which charges nothing. After each month ends, the month job works out each such plan's month from the seats the server read each day, the same seat-days and prorated seats as the MSP console's Seats report for that month: the seat-days of the days that are billed (days that start before a trial or an offer ends aren't), divided by all of the month's days, to two decimals. The prorated seats, rounded up to whole seats, pick the price a seat (`BILLING_SEAT_PRICES_MSP`, `BILLING_SEAT_PRICES_BUSINESS`), and every prorated seat is billed at it, to the cent. It writes the month down first, then asks the provider to invoice the card on file, then notes the provider's id for the invoice: one invoice for each plan and month, ever, however often it runs or wherever it stopped. A month the provider couldn't be asked about is sent on the next run, as it was written down, and the log gets an error saying how many. Only a plan the provider has had a card for is invoiced: a trial with no card isn't. With the server reading seats each day (`MSP_SEATS_SCHEDULE`), it also reads each organization with a Business plan of its own (0 while it's an MSP's client, whose seats are its MSP's). `GET /api/keykeeper/plan/invoices` (`organization` or `msp`) answers the months the plan was invoiced for, to whoever may pay for it, and 404 to everyone else; the Plan page and the MSP console list them.
- Deleting an account or an organization (in the apps, by the emailed link, on the admin page, by its owner, or by its MSP) first asks the provider to cancel at once whatever it bills that customer for, with no refund. When the provider can't be reached, the deletion goes ahead and the log gets an error naming the provider's id for the customer: cancel it in the provider's dashboard.

Its secrets are read from the environment only, never the admin page or `config.json`, and never appear in a log, an error, or the admin page's diagnostics:

| Secret | What it is |
|---|---|
| `BILLING_API_KEY` | The key the server calls the provider's API with. For Stripe, a restricted key that can only do what the server asks. |
| `BILLING_WEBHOOK_SECRET` | The secret the provider signs its webhooks with. For Stripe, the endpoint's signing secret. |
| `BILLING_WEBHOOK_SECRET_OLD` | While you replace that secret: the old one, which the server also takes until you remove it. |

Each can also be read from a file named by the same setting with `_FILE` on the end, as the server's other settings can. `BILLING_API_BASE` is for tests only: the address the provider's adapter calls instead of the provider's own. The stand-in needs one, and won't start unless it's a loopback address written as one (`http://127.0.0.1:8124`), or with a key that looks like a live one.

### Stripe

`BILLING_PROVIDER=stripe` sends people to Stripe's pages: Stripe Checkout to pay for Premium (a person's) or Families (an organization's, for its owners), and Stripe's customer portal to manage what they pay for. Where billing by the day is on, Business (an organization's owners) and an MSP's pool (its admins) add a card instead, with Checkout in setup mode: it charges nothing, and the server then makes that card the customer's default for invoices. After each month, the month's invoice is an invoice item (the amount, a line saying what it comes from, and the month as its period) and an invoice that takes it and collects from the card on file by itself, each sent with an idempotency key from the server's record of the month and written with it in its metadata; before making either, the server looks for one it made with that key, so nothing is made twice even after Stripe forgets the key a day later. A pool with a card and no unpaid invoice is in good standing with no end; an unpaid invoice puts it in grace from the invoice's first failed attempt, which ends when it's paid. Where billing by the day is off (`BILLING_INVOICE_SCHEDULE` blank), asking to pay for Business or a pool says "Business can't be paid for online yet." or "An MSP's plan can't be paid for online yet.", and you set those plans by hand. The server reads each customer's subscriptions to learn their standing: `active` and `trialing` are paid through the period's end, `past_due` is in grace from the start of the unpaid period, and `canceled`, `unpaid`, `incomplete_expired`, and `paused` are over. Every call is pinned to Stripe's API version `2026-10-28.endive`, whatever the account's default is.

| Setting | Default | |
|---|---|---|
| `BILLING_PRICE_PREMIUM` | none | The id of the Stripe price people pay for Premium (`price_...`), a yearly price. Environment only. |
| `BILLING_PRICE_FAMILIES` | none | The id of the Stripe price for Families (`price_...`), a yearly price, not the same as Premium's. Environment only. |
| `BILLING_API_KEY` | none | A Stripe restricted key (`rk_live_...`, or `rk_test_...` in a sandbox). |
| `BILLING_WEBHOOK_SECRET` | none | The webhook endpoint's signing secret (`whsec_...`). |
| `BILLING_WEBHOOK_SECRET_OLD` | none | While you roll the signing secret in Stripe: the old one. Remove it when Stripe stops signing with it (at most 7 days). |
| `BILLING_API_BASE` | empty | Leave it empty: Stripe's own address. Tests set a loopback address, and the server won't start with it set beside a live key. |
| `BILLING_INVOICE_SCHEDULE` | `0 35 * * * *` | When the month job runs (hourly): it invoices the month just ended on its first run after the month ends, and a month Stripe couldn't take on the next. Blank turns billing by the day off. Only where `PLANS_ENFORCED` and `BILLING_PROVIDER` are set. |
| `BILLING_SEAT_PRICES_MSP` | none | An MSP's seat a month, at each pool size where the price changes: `1:1.50,500:1.25,2500:1.00` is $1.50 a seat from 1 seat, $1.25 from 500, and $1.00 from 2,500. Monthly prices: there are no one-year commitments until after launch. Environment only. Needed while `BILLING_INVOICE_SCHEDULE` isn't blank. |
| `BILLING_SEAT_PRICES_BUSINESS` | none | A Business organization's seat a month, the same way: `1:2.00,250:1.75`. Environment only. Needed while `BILLING_INVOICE_SCHEDULE` isn't blank. |

The server won't start with Stripe set and a price missing, with billing by the day on and a seat's prices missing or not written as above (the first tier from 1 seat, each from more seats than the last, each price in dollars and cents above 0), with the account's full secret key (`sk_live_` or `sk_test_`; give it a restricted key), with a key that isn't Stripe's restricted kind, or with a signing secret that doesn't start with `whsec_`.

The restricted key needs these permissions in Stripe's dashboard, and nothing else: Customers, Checkout Sessions, Customer portal, and Subscriptions, each Write (canceling a subscription is a write; Write includes Read); and for billing by the day, Invoices and Invoice items, each Write, and SetupIntents and PaymentMethods, each Read (the server reads which card a setup saved, and whose it is).

In Stripe's dashboard:

- **Webhook endpoint:** `https://<your domain>/api/keykeeper/billing/events/stripe`, payload **Snapshot** (the dashboard offers Thin first; the server refuses thin events), API version `2026-10-28.endive`, and these events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`, `invoice.paid`, and `invoice.payment_failed`, and for billing by the day `invoice.marked_uncollectible`, `invoice.voided`, and `customer.updated` (a default card changed or removed). Its signing secret is `BILLING_WEBHOOK_SECRET`.
- **Customer portal:** on, with updating the payment method, invoice history, and canceling, which keeps the plan until the end of the period paid for. Switching plans, updating quantities, and pausing stay off. The server sends people back to the Plan page itself, so no default redirect link is needed.
- **Retries:** Billing, Revenue recovery, Retries: a schedule that ends within `PLAN_GRACE_DAYS` (14 days by default), and when it ends, cancel the subscription. During it the plan is in grace, and once it's canceled the plan has ended.
- **Retries for the month's invoices** (billing by the day): Settings, Billing, Invoices, Advanced invoicing features: retries for one-off invoices that end within `PLAN_GRACE_DAYS` of the first failed attempt. Stripe's documentation says retrying a one-off invoice's card is part of Invoicing Plus; without it a failed payment isn't tried again, and the pool or the organization stays in grace until someone pays in the portal. It's in grace from that first attempt, and has ended when grace does unless the invoice is paid; marking it uncollectible changes nothing the server reads, and paying it later brings the plan back.
- **Invoice emails** (billing by the day): Settings, Business, Customer emails: Successful payments on, so whoever pays gets a receipt with the invoice. Settings, Billing, Subscriptions and emails: Send emails when card payments fail, with payment method updates in the customer portal. An invoice charged to the card on file isn't emailed before it's paid unless Send finalized invoices to customers is on; leave it off.
- **One subscription each:** Settings, Checkout and Payment Links: send customers who already have a subscription to the customer portal (this needs the portal's login link on). The server already does this for anyone it knows has paid; this covers two of Stripe's pages opened at once.

## What the server fetches

The server fetches websites' icons and change-password pages, and sends events to the destinations organizations choose. It never reaches cloud metadata services (169.254.169.254, Azure's 168.63.129.16, and the like), link-local addresses, or IPv4 written as IPv6 (NAT64, 6to4, Teredo), whatever the settings say, and by default no private address either (`HTTP_REQUEST_BLOCK_NON_GLOBAL_IPS`). It checks each address a name resolves to before connecting. With `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY` set, the proxy looks up names instead, so those checks see only addresses written in URLs: the proxy has to refuse the rest. Event streaming never uses a proxy.

## Making a release

A release is a tag on this repository, `server-v<major>.<minor>.<patch>`. The first is the owner's to tag.

1. In a pull request, put the commits to release in `deploy/release-commits.txt`: `server=` and `clients=`, each a full commit SHA on that repository's `keykeeper` branch (`git ls-remote https://github.com/PimpinPumpkin/passbundle-server.git refs/heads/keykeeper` prints the newest, and the same for `passbundle-clients`). Merge it.
2. On an up-to-date main, tag that merge and push the tag: `git tag server-v0.1.0 && git push origin server-v0.1.0`.
3. The Release workflow builds the server and the web vault from those commits and the image from the tag's `deploy/`, and runs the smoke test. Only then does it push that same image (it checks the image's ID, so it's never a rebuild) as `0.1.0`, sign it, add the attestation, and tag it `latest` if it's the highest version tagged. It stops, publishing nothing, for a tag that isn't on main, a commit that isn't on its repository's `keykeeper`, an empty `deploy/release-commits.txt`, or a tag that isn't `server-v` and three numbers.
4. The first push makes the package `passbundle` on GitHub, and a new package is private: anyone can pull it once it's made public in its settings (Package settings, Change visibility).

A tag whose run stopped before the push published nothing, so it can be deleted and made again. Once a release is published, don't move or reuse its tag: a run for it again pushes a new image under the same version.

What's recorded is enough to build a release again: the tag holds the Dockerfile, the smoke test, the workflow, and `deploy/release-commits.txt`; the image's labels name the same two commits, and its attestation the tag's commit and the run that built it. To build it again, run the Release workflow by hand from the tag, with those two commits. That's the same code, not the same image byte for byte: the Debian packages in it are whatever Debian has that day (`apt-get install` in `deploy/Dockerfile`).

## Not yet

- Push notifications for the mobile apps, which come with the apps.
