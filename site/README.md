# passbundle.com

The PassBundle website: a home page, help, security, the privacy policy and terms, and the pages the apps link to (`/download/`, `/contact/`, and `/browser-start/`, which the extension opens after it's installed). Plain HTML and one stylesheet: no scripts, no cookies, nothing loaded from anyone else, which the privacy policy promises.

- `pages/`: one file per page, with a title and description at the top. `index.html` is `/`, `help.html` is `/help/`.
- `static/`: copied as is: the stylesheet, favicon, `security.txt`, and Cloudflare Pages' `_headers` (security headers) and `_redirects` (the apps' old help-article and product links).
- `build.mjs` wraps each page in the shared header and footer into `dist/`. `check.mjs` fails on a broken internal link, a missing page the apps link to, a script, or an em dash.

```sh
node site/build.mjs && node site/check.mjs   # build and check
site/deploy.sh                                 # build, check, and deploy to Cloudflare Pages
```

CI runs the build and check on every change to `site/`.

## Hosting

Cloudflare Pages, project `passbundle`. `deploy.sh` uses whichever Cloudflare account wrangler is logged in to (`npx wrangler login`), or `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.

### Moving to PassBundle's own Cloudflare account, with passbundle.com

1. In the new account: `npx wrangler login` (or set the two variables above), then `site/deploy.sh`. It creates the `passbundle` project the first time.
2. Add `passbundle.com` to the account as a site (the free plan is enough). At Namecheap, set the domain's nameservers to the two Cloudflare gives you.
3. In Pages, project `passbundle`, Custom domains: add `passbundle.com` and `www.passbundle.com`.
4. Email Routing: create `hello@`, `privacy@`, and `security@passbundle.com`, forwarding to your inbox. The site and SECURITY.md files use them.
5. For `passbundle.io` and `passbundle.app`: add them as sites too, and a redirect rule sending every request to `https://passbundle.com`.
6. Delete the `passbundle` project from the old account.
