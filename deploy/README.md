# The PassBundle image

PassBundle's server and branded web vault in one container image, for the hosted service and for anyone who runs their own.

- **What's in it:** the server built for production (`cargo build --release`, SQLite and PostgreSQL in one binary, and S3-compatible storage for files) and the branded web vault, on Debian 13 slim. It runs as an unprivileged user (uid 10001) on port 8080, keeps its data in `/data`, and has a health check on `/alive`.
- **How it's made:** the Release workflow (`.github/workflows/release.yml`) builds both from the `keykeeper` branches, or from the branches, tags, or commits you give it when you run it by hand. A pull request whose branch name also exists in the server or clients repo uses that branch there. It builds the image from `deploy/Dockerfile` and runs `deploy/smoke.sh`, then keeps the image as the `image` artifact for 14 days. It runs for every push to main and for pull requests that change this folder. The smoke test starts the image on SQLite and on PostgreSQL, checks it serves PassBundle's web vault, makes an account, signs in, and signs in again after a restart. Then it checks the client's address as the hosted service sets it up (below): the server refuses to start on a public address without `IP_HEADER`, believes `CF-Connecting-IP` only from the tunnel's address, and ignores the same headers sent from anywhere else.
- **Labels** record the commit of each repo it was built from (`com.passbundle.server-commit`, `com.passbundle.clients-commit`).

## Running it

```sh
gunzip -c passbundle-image.tar.gz | docker load
docker network create --subnet 172.30.53.0/24 --ip-range 172.30.53.128/25 passbundle
docker run -d --name passbundle --network passbundle -v passbundle-data:/data \
  -e DOMAIN=https://vault.example.com -e IP_HEADER=X-Real-IP -e IP_HEADER_TRUSTED_PROXIES=172.30.53.2 \
  passbundle:release
```

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
| `PLANS_ENFORCED` | Off by default, and a self-hosted server leaves it off: every account and organization gets everything, as before. On, what each gets follows the plan recorded for it, the apps are told in the sync, and Free can't attach or send files, or get the data breach report where the server has a key for it (see "Plans"). Set only in the environment. Its figures: `PLAN_GRACE_DAYS` (14), `PLAN_PREMIUM_STORAGE_GB` (5), `PLAN_FAMILIES_PEOPLE` (6), `PLAN_ORG_STORAGE_GB_PER_PERSON` (1), and `PLAN_ORG_STORAGE_MIN_GB` (5). |
| `SITE_FIXES_NEED_APPROVAL` | Whether a shared site fix fills for everyone only once you approve it on the admin page's Sites list, as well as once three people with verified email addresses shared it. |
| `ATTACHMENTS_FOLDER`, `SENDS_FOLDER` | Where file attachments and Send files go. A folder in `/data` by default, or object storage: `s3://bucket/attachments?endpoint=https://...&region=auto&default_storage_class=STANDARD`, with `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. They're encrypted by the apps before upload, like everything else. |

## The admin page

`ADMIN_TOKEN` turns on the server's admin page at `/admin`, which can delete accounts and organizations and change settings. Someone who gets the token can do all of that, so leave it unset in production: set it, use the page, and unset it again (restart the container both times). Use an Argon2 hash (`passbundle-server hash`), never the token itself.

Settings that could quietly send people's secrets somewhere else are set only in the environment, so the admin page can't change them: `DOMAIN` (links in emails and passkeys), every `SMTP_*` setting (sign-in codes and links go by email), `IP_HEADER` and `IP_HEADER_TRUSTED_PROXIES`, `EVENT_STREAMING_ALLOWED_NETWORKS`, `HTTP_REQUEST_BLOCK_REGEX` and `HTTP_REQUEST_BLOCK_NON_GLOBAL_IPS`, `YUBICO_SERVER`, and `DUO_HOST`. A value for one of them saved on the admin page before is ignored.

## Plans

The server keeps at most one plan for each person, organization, and MSP: which plan, a date it's free until (a trial or an offer), a date it's paid through or that it's paid for as it goes, and whether it renews. With `PLANS_ENFORCED` off, the default, a recorded plan changes nothing. With it on, a person gets Premium's features while their own plan is in effect, or while they hold a place in an organization, or are on the staff of an MSP, whose plan is; an MSP's plan covers each of its clients, whatever plan a client has of its own. A plan that's paid through a date and renews stays in effect for `PLAN_GRACE_DAYS` after that date; one that doesn't renew ends on it. No trial starts by itself yet, and nothing is billed.

With `PLANS_ENFORCED` on, the server refuses only adding, each time with one sentence the apps show:

- Attaching a file to a person's own item goes by their plan: none on Free ("Attaching files is part of Premium."), and `PLAN_PREMIUM_STORAGE_GB` with Premium ("Your 5 GB for attachments is full. Delete some to make room."). A shared item goes by its organization's plan: `PLAN_ORG_STORAGE_GB_PER_PERSON` for each person in it, and never less than `PLAN_ORG_STORAGE_MIN_GB`. The sentences name the organization, and once its plan has ended nothing new can be attached.
- Creating a file Send needs Premium ("Sending files is part of Premium. Sending text is free."). How much a person may keep in Send files stays `USER_SEND_LIMIT`, on every plan.
- The data breach report needs Premium ("The data breach report is part of Premium."), where the server has an `HIBP_API_KEY`. Without one, the report is a link to that site's own free page, for everyone.
- `USER_ATTACHMENT_LIMIT` and `ORG_ATTACHMENT_LIMIT` have no default on a public server while plans are enforced. Set one, and no plan gives more than it; the sentence then says that figure.

Downloading and removing files never look at a plan: a file attached with Premium downloads and can be removed on Free, and storage that's over its limit refuses new files and nothing else. A file Send made with Premium works until it expires or is deleted.

Only the admin page sets a plan, so only someone with `ADMIN_TOKEN` can, and each change is written to the server's log with what the plan was before. Signed in to `/admin`:

- `GET /admin/plans/<users|organizations|msps>/<id>` reads the plan recorded for that person, organization, or MSP, and what applies to it now.
- `POST /admin/plans/<users|organizations|msps>/<id>` sets it, with a JSON body: `plan` (`premium` for a person; `families` or `business` for an organization; `msp` for an MSP), `standing` (`none`, `until`, or `open`), `until` (a time, with `standing` `until`), `renews`, and optionally `freeUntil` with `freeWhy` (`trial` or `offer`) and `billed` (`prepaid`, `by_the_day`, or `by_hand`, the default). Times are UTC, like `2027-01-31T00:00:00Z`.
- `POST /admin/plans/<users|organizations|msps>/<id>/remove` removes it.

The people a changed plan reaches are told to sync. People read their own plan, and the plan of an organization or MSP they manage, at `GET /api/keykeeper/plan`; nobody sets one there.

## What the server fetches

The server fetches websites' icons and change-password pages, and sends events to the destinations organizations choose. It never reaches cloud metadata services (169.254.169.254, Azure's 168.63.129.16, and the like), link-local addresses, or IPv4 written as IPv6 (NAT64, 6to4, Teredo), whatever the settings say, and by default no private address either (`HTTP_REQUEST_BLOCK_NON_GLOBAL_IPS`). It checks each address a name resolves to before connecting. With `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY` set, the proxy looks up names instead, so those checks see only addresses written in URLs: the proxy has to refuse the rest. Event streaming never uses a proxy.

## Not yet

- Pushing the image to a registry (GitHub's container registry) and signing it, which comes with the hosted service.
- Push notifications for the mobile apps, which come with the apps.
