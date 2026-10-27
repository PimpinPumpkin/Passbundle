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
| `USER_ATTACHMENT_LIMIT`, `ORG_ATTACHMENT_LIMIT` | 1048576 (1 GB, in KB) of file attachments per person and per organization | no limit |
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
| `IP_HEADER`, `IP_HEADER_TRUSTED_PROXIES` | Where the visitor's address comes from (see "The client's address"). Required on a public `DOMAIN`. |
| `ORG_CREATION_USERS` | Who may make organizations: `all`, `none`, or a list of emails. |
| `ORG_ITEM_HISTORY_LIMIT` | The most an organization's item history may take, in KB (1048576, 1 GB, by default). Past it, an edit keeps a version only if it's 64 KB or less, as real items are. |
| `INVITE_JOINS_WITHOUT_EMAIL` | On a server that sends no email, whether an invitation still lets the person in without approval. Off by default: without email, nothing proves who owns the address, so whoever signs up with it first would get in. Only for a server nobody else can reach. |
| `SITE_FIXES_NEED_APPROVAL` | Whether a shared site fix fills for everyone only once you approve it on the admin page's Sites list, as well as once three people with verified email addresses shared it. |
| `ATTACHMENTS_FOLDER`, `SENDS_FOLDER` | Where file attachments and Send files go. A folder in `/data` by default, or object storage: `s3://bucket/attachments?endpoint=https://...&region=auto&default_storage_class=STANDARD`, with `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. They're encrypted by the apps before upload, like everything else. |

## The admin page

`ADMIN_TOKEN` turns on the server's admin page at `/admin`, which can delete accounts and organizations and change settings. Someone who gets the token can do all of that, so leave it unset in production: set it, use the page, and unset it again (restart the container both times). Use an Argon2 hash (`passbundle-server hash`), never the token itself.

Settings that could quietly send people's secrets somewhere else are set only in the environment, so the admin page can't change them: `DOMAIN` (links in emails and passkeys), every `SMTP_*` setting (sign-in codes and links go by email), `IP_HEADER` and `IP_HEADER_TRUSTED_PROXIES`, `EVENT_STREAMING_ALLOWED_NETWORKS`, `HTTP_REQUEST_BLOCK_REGEX` and `HTTP_REQUEST_BLOCK_NON_GLOBAL_IPS`, `YUBICO_SERVER`, and `DUO_HOST`. A value for one of them saved on the admin page before is ignored.

## What the server fetches

The server fetches websites' icons and change-password pages, and sends events to the destinations organizations choose. It never reaches cloud metadata services (169.254.169.254, Azure's 168.63.129.16, and the like), link-local addresses, or IPv4 written as IPv6 (NAT64, 6to4, Teredo), whatever the settings say, and by default no private address either (`HTTP_REQUEST_BLOCK_NON_GLOBAL_IPS`). It checks each address a name resolves to before connecting. With `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY` set, the proxy looks up names instead, so those checks see only addresses written in URLs: the proxy has to refuse the rest. Event streaming never uses a proxy.

## Not yet

- Pushing the image to a registry (GitHub's container registry) and signing it, which comes with the hosted service.
- Push notifications for the mobile apps, which come with the apps.
