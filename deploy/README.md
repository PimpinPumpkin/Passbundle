# The PassBundle image

PassBundle's server and branded web vault in one container image, for the hosted service and for anyone who runs their own.

- **What's in it:** the server built for production (`cargo build --release`, SQLite and PostgreSQL in one binary) and the branded web vault, on Debian 13 slim. It runs as an unprivileged user (uid 10001) on port 8080, keeps its data in `/data`, and has a health check on `/alive`.
- **How it's made:** the Release workflow (`.github/workflows/release.yml`) builds both from the `keykeeper` branches, or from the branches, tags, or commits you give it when you run it by hand. It builds the image from `deploy/Dockerfile` and runs `deploy/smoke.sh`, then keeps the image as the `image` artifact for 14 days. It runs for every push to main and for pull requests that change this folder. The smoke test starts the image on SQLite and on PostgreSQL, checks it serves PassBundle's web vault, makes an account, signs in, and signs in again after a restart.
- **Labels** record the commit of each repo it was built from (`com.passbundle.server-commit`, `com.passbundle.clients-commit`).

## Running it

```sh
gunzip -c passbundle-image.tar.gz | docker load
docker run -d --name passbundle -p 8080:8080 -v passbundle-data:/data \
  -e DOMAIN=https://vault.example.com passbundle:release
```

The apps refuse a server that isn't HTTPS, so put it behind something that serves HTTPS: a reverse proxy, or a Cloudflare tunnel, as the hosted service does.

The settings are the server's environment variables, as in Vaultwarden. The ones that matter most:

| Variable | What it does |
|---|---|
| `DOMAIN` | The address people use, with `https://`. Links in emails and passkeys depend on it. |
| `DATABASE_URL` | `postgresql://user:password@host/db` for PostgreSQL. Without it, SQLite in `/data`. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM` | Email. Account recovery, emailed invitations, join emails, and email domain limits need it. |
| `SIGNUPS_ALLOWED` | Whether anyone can make an account. |
| `MSP_SIGNUPS_ALLOWED` | Whether anyone can set up an MSP. |
| `ADMIN_TOKEN` | Turns on the server's admin page. Leave it unset unless you need it. |

## Not yet

- Pushing the image to a registry (GitHub's container registry) and signing it, which comes with the hosted service.
- Push notifications for the mobile apps, which come with the apps.
