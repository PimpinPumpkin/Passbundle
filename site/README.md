# passbundle.com

The PassBundle website: the home page, For MSPs, Business, Pricing, Download, Switch to PassBundle, Security, Help, the privacy policy and terms, and the pages the apps link to (`/download/`, `/contact/`, and `/browser-start/`, which the extension opens after it's installed). Plain HTML, one stylesheet, and the apps' typeface, Google Sans Flex: no cookies, nothing loaded from anyone else, which the privacy policy promises, and one script of our own, the home page's demo (`static/demo.js`).

Light or dark like the visitor's device: a near-white neutral ground (`#FAFAF8`) with the logo's emerald as the one accent in light mode, a near-black neutral ground (`#0B0D0E`) with mint in dark mode and no color washes, deep green bands where a page changes the subject, flat tinted tiles (each kind of item keeps its color as a soft tint, with the glyph in that color), and the logo's solid emerald tile with "passbundle" in two tones. Every text passes WCAG AA in both themes. The site moved to this look in November 2026; the apps still have DESIGN.md's ("The look": jewel tiles, graphite dark mode) until they move too, so the screenshots show that one.

- `pages/`: one file per page, with a title and description at the top. `index.html` is `/`, `help.html` is `/help/`. `layout: wide` is for marketing pages built from sections; the rest are reading pages on one panel. `script: demo` loads `/demo.js`, deferred: only our own files, by name, and the CSP (`script-src 'self'`) refuses anything else.
- `site.json`: prices and links, used in pages as `{{prices.premium}}` or `{{links.vault}}`, so a price changes in one place. An empty link isn't live yet: pages fall back to `/download/` until it's filled in. `links.apps` is the apps' test releases on GitHub; the Download page links there, never to one version.
- `<x-shot name="msp-console" alt="..." frame="desktop">`: a screenshot from `static/shots`, with its dark version in dark mode. Until `e2e/site-shots/` has made it, it's a placeholder the size of its `frame` (`desktop`, `popup`, or `panel`), and `check.mjs --launch` refuses it.
- `<x-tile icon="console" tone="sapphire">`: a tile tinted with its tone and its glyph in that tone, as the apps show each kind of item, with a glyph from `icons.mjs` (the apps' own glyphs, and some drawn for the site). Tones: brand, sapphire, topaz, amethyst, turquoise, onyx, aquamarine, garnet, emerald, ruby, gold.
- `<x-art name="LockIcon">`: one of the apps' drawings from `art/`, inline so it takes the page's colors.
- `static/`: copied as is: the stylesheet, fonts (with their license), screenshots, favicon, `security.txt`, and Cloudflare Pages' `_headers` (security headers) and `_redirects` (the apps' old help-article and product links).
- `art/`: drawings copied from passbundle-clients `brand/artwork/` (made by `draw.mjs` there). Copy again when they change.
- `build.mjs` wraps each page in the shared header and footer into `dist/`, and lists the screenshots still to make. `check.mjs` fails on a broken link or image, a missing page, a script that isn't one of our own files (inline, or from anyone else), an inline style or event handler (the CSP blocks them), an em dash, or a placeholder the build didn't fill in.

```sh
node site/build.mjs && node site/check.mjs   # build and check
site/deploy.sh                                 # build, check, and deploy the preview
```

CI runs the build and check on every change to `site/`.

## Screenshots

Every screenshot is made from the real apps by `e2e/site-shots/`, with made-up people and data (`e2e/site-shots/data.ts`), on a local test server that sends email to the test mail catcher (as the hosted service does, so account recovery shows) and answers as vault.passbundle.com, so no local address shows on screen. The list, and the page each one is on, is at the top of `site-shots.spec.ts`: a person's vault in the web vault and the extension, signing in to one's own server, an MSP with five clients (the console, a client's passwords to fix, default policies, an install command, Entra provisioning, and an item's history), and a company with its own IT (members, policies, install command, and a shared folder's permissions).

Build the server from passbundle-server's `keykeeper` branch and the web vault and extension from passbundle-clients' `keykeeper` branch (see `e2e/README.md`), never from a branch that isn't merged, so every shot shows the look people get. Then run it, and commit the images:

```sh
cd e2e && npx playwright test -c playwright.site.config.ts
```

It writes 2x WebP images, light and dark, to `site/static/shots/`. It takes about five minutes.

## Before launch

Until launch, `site/deploy.sh` deploys to the preview address, https://preview.passbundle.pages.dev, never the live site. `site/deploy.sh --production` deploys passbundle.com, and refuses until `node site/check.mjs --launch` passes: no highlighted placeholders left (`<mark class="todo">`, such as the company's legal name and the payment processor in the privacy policy and terms, and screenshots not made yet) and every link in `site.json` filled in (the store listings). `node site/check.mjs` lists what's left.

The site describes the product as it will be at launch. What has to be true first:

- The hosted service at vault.passbundle.com, and paid plans with their limits (Free, Premium, Families, Business, pooled MSP seats).
- The browser store listings, and the apps signed by Apple and Microsoft (their test builds on GitHub are signed with PassBundle's own test keys).
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

## The home page's demo

`static/demo.js` runs a vault and an MSP console with made-up people and data, all in the page: nothing is stored, and nothing is sent anywhere. Until it starts, or without scripts, the page shows the web vault's screenshot in its place. It makes every element with `createElement` and sets text with `textContent` (no `innerHTML`), keeps the keyboard's place when it redraws, and says what a button did to screen readers. Its items and clients match `e2e/site-shots/data.ts`'s made-up family and MSP.
