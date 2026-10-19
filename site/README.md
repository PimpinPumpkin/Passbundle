# passbundle.com

The PassBundle website: the home page (for people and families), Business, For MSPs, Pricing, Switch to PassBundle, Security, Help, Download, the privacy policy and terms, and the pages the apps link to (`/download/`, `/contact/`, and `/browser-start/`, which the extension opens after it's installed). Plain HTML, one stylesheet, and the Figtree font: no scripts, no cookies, nothing loaded from anyone else, which the privacy policy promises. It has the apps' look: Glass, light or dark like the visitor's device.

- `pages/`: one file per page, with a title and description at the top. `index.html` is `/`, `help.html` is `/help/`. `layout: wide` is for marketing pages built from sections; the rest are reading pages on a solid panel.
- `site.json`: prices and links, used in pages as `{{prices.premium}}` or `{{links.vault}}`, so a price changes in one place. An empty link isn't live yet: pages fall back to `/download/` until it's filled in.
- `<x-shot name="msp-console" alt="...">`: a screenshot from `static/shots`, with its dark version in dark mode. `<x-art name="LockIcon">`: one of the apps' drawings from `art/`, inline so it takes the page's colors.
- `static/`: copied as is: the stylesheet, fonts (with their license), screenshots, favicon, `security.txt`, and Cloudflare Pages' `_headers` (security headers) and `_redirects` (the apps' old help-article and product links).
- `art/`: drawings copied from passbundle-clients `brand/artwork/` (made by `draw.mjs` there). Copy again when they change.
- `build.mjs` wraps each page in the shared header and footer into `dist/`. `check.mjs` fails on a broken link or image, a missing page, a script, an inline style (the CSP blocks them), an em dash, or a placeholder the build didn't fill in.

```sh
node site/build.mjs && node site/check.mjs   # build and check
site/deploy.sh                                 # build, check, and deploy the preview
```

CI runs the build and check on every change to `site/`.

## Screenshots

Every screenshot is made from the real apps by `e2e/site-shots/`, on the same test server the tests use, with made-up people and data (`e2e/site-shots/data.ts`): a person's vault in the web vault and the extension, the three themes, an MSP with five clients, and a company with its own IT. Run it after the look or a screen the site shows changes, then commit the images:

```sh
cd e2e && npx playwright test -c playwright.site.config.ts
```

It writes 2x WebP images, light and dark, to `site/static/shots/`. It takes about three minutes.

## Before launch

Until launch, `site/deploy.sh` deploys to the preview address, https://preview.passbundle.pages.dev, never the live site. `site/deploy.sh --production` deploys passbundle.com, and refuses until `node site/check.mjs --launch` passes: no highlighted placeholders left (`<mark class="todo">`, such as the company's legal name and the payment processor in the privacy policy and terms) and every link in `site.json` filled in (the store listings and the Windows download). `node site/check.mjs` lists what's left.

The site describes the product as it will be at launch. What has to be true first:

- The hosted service at vault.passbundle.com, and paid plans with their limits (Free, Premium, Families, Business, pooled MSP seats).
- The browser store listings, and a signed Windows installer for Windows Hello unlock.
- Prices and offers on the site are proposals until decided: Premium, Families, Business, the MSP seat pool, the 30-day trial, and six months free for the first MSPs.

## Hosting

Cloudflare Pages, project `passbundle`. `deploy.sh` uses whichever Cloudflare account wrangler is logged in to (`npx wrangler login`), or `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.

### Moving to PassBundle's own Cloudflare account, with passbundle.com

1. In the new account: `npx wrangler login` (or set the two variables above), then `site/deploy.sh`. It creates the `passbundle` project the first time.
2. Add `passbundle.com` to the account as a site (the free plan is enough). At Namecheap, set the domain's nameservers to the two Cloudflare gives you.
3. In Pages, project `passbundle`, Custom domains: add `passbundle.com` and `www.passbundle.com`.
4. Email Routing: create `hello@`, `privacy@`, and `security@passbundle.com`, forwarding to your inbox. The site and SECURITY.md files use them.
5. For `passbundle.io` and `passbundle.app`: add them as sites too, and a redirect rule sending every request to `https://passbundle.com`.
6. Delete the `passbundle` project from the old account.
