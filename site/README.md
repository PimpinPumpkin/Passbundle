# passbundle.com

The PassBundle website: the home page (with the demo and the questions), Features, Personal, Business, MSPs, Pricing, Download, Switch to PassBundle, Security, Help, the privacy policy and terms, and the pages the apps link to (`/download/`, `/contact/`, and `/browser-start/`, which the extension opens after it's installed). Plain HTML, one stylesheet, and the apps' typeface, Google Sans Flex: no cookies, nothing loaded from anyone else, which the privacy policy promises, and two scripts of our own: the light or dark switch, inline in every page (`theme.mjs`), and the demo (`static/tour.js`), on the home page.

Light or dark like the visitor's device: a near-white neutral ground (`#FAFAF8`) with the logo's emerald as the one accent in light mode, a near-black neutral ground (`#0B0D0E`) with mint in dark mode and no color washes, deep green bands where a page changes the subject, flat tinted tiles (each kind of item keeps its color as a soft tint, with the glyph in that color), and the logo's emerald tile, the one glossy tile (as the app icon), with "passbundle" in two tones. Every text passes WCAG AA in both themes. The site moved to this look in November 2026, and the apps' item tiles are flat too (DESIGN.md, "The look"), as the screenshots show.

- `pages/`: one file per page, with a title and description at the top. `index.html` is `/`, `help.html` is `/help/`. `layout: wide` is for marketing pages built from sections; the rest are reading pages on one panel. `parts/` holds pieces of pages kept in their own file (`<x-part name="tour"></x-part>`). `script: tour` loads `/tour.js`, deferred: only our own files, by name, and the CSP (`script-src 'self'`) refuses anything else.
- `site.json`: prices and links, used in pages as `{{prices.premium}}` or `{{links.apps}}`, so a price changes in one place. An empty link isn't live yet: pages fall back to `/download/` until it's filled in, and the header's Log in shows only once `links.vault` is. `links.apps` is the apps' test releases on GitHub; the Download page links there, never to one version. `{{links.extensionZip|links.extension}}` is the first of the two that's filled in: the Download button for the extension goes to the newest release's zip, or to the list of extension releases until the first one is out.
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

On GitHub, the **Site screenshots** workflow (`.github/workflows/site-shots.yml`) does all of this: start it from the Actions tab after the apps' look changes (it also runs on the first of each month). It builds both from their `keykeeper` branches with Tier 1, without its tests, takes the shots, and when they changed, pushes them to the branch `site-shots-update` with a link in the run's summary to open the pull request. Open it, merge it, and deploy.

To take them on your own computer, build the server from passbundle-server's `keykeeper` branch and the web vault and extension from passbundle-clients' `keykeeper` branch (see `e2e/README.md`), never from a branch that isn't merged, so every shot shows the look people get. Then run it, and commit the images:

```sh
cd e2e && npx playwright test -c playwright.site.config.ts
```

It writes 2x WebP images, light and dark, to `site/static/shots/`. It takes about five minutes.

## Before launch

Until launch, `site/deploy.sh` deploys to the preview address, https://preview.passbundle.pages.dev, never the live site. `site/deploy.sh --production` deploys passbundle.com, and refuses until `node site/check.mjs --launch` passes: no highlighted placeholders left (`<mark class="todo">`, such as the company's legal name and the payment processor in the privacy policy and terms, and screenshots not made yet) and every link in `site.json` filled in (the hosted web vault and sign-up, and the store listings). `node site/check.mjs` lists what's left.

The site says what's true today, and says plainly what waits for launch (every page was checked against the code on November 6, 2026). As each piece arrives, change the words that wait on it:

- **The hosted service** at vault.passbundle.com: fill in `links.vault` and `links.signup`, and take out "opens at launch" and "a server you run yourself": Download's testing note and Web card (whose button goes to Run your own server until then), the homepage's last section, Help's "How do I start?", Switch's first step, and the "once it opens at launch" lines on the homepage, Business, and MSPs.
- **Paid plans and billing** (Free, Premium, Families, Business, pooled MSP seats, the trial): the "start at launch" notes on the homepage, Personal, Pricing, Business, MSPs, and Help, and the plan buttons (Try the demo, Talk to us) back to sign-up and the trial. Today every account gets Premium's features, and Families isn't limited to its number of people.
- **The browser store listings:** fill in `links.chrome`, `links.edge`, and `links.firefox`, put Add to buttons on Download's Browser card (the zip to install by hand can stay, under them), and drop "once it's in their stores" from the install command's words (the homepage, Features, Business, MSPs, Help, and the demo's MSP console). The installer's extension IDs, placeholders until then, change too.
- **Email** (hello@, privacy@, and security@) and GitHub's private vulnerability reporting: Contact, Security, `static/.well-known/security.txt`, and the Talk to us buttons, which go to Contact.
- **Signing:** the offline update key (Security, "No remote control"), Touch ID with Apple's signing (Download's "Opening a test build", Business's Macs question), and code signing for the script module (Features).
- **Checks for real:** Windows Hello on a real device (Download, Personal, Pricing), Sign in with Entra and provisioning with a real Microsoft 365 tenant ("Not yet checked" on Business, MSPs, Pricing, and Features), and events with Sentinel, Huntress, and Blumira (Business, Features, MSPs).
- **The command-line tool's first release:** Download's card links its guide until then (`links.cli` is its releases).
- **The extension's first release:** start **Extension release** (`.github/workflows/extension-release.yml`) from the Actions tab, on main. It builds the branded extension for Chrome, Edge, and other Chromium browsers from passbundle-clients' `keykeeper` branch, and publishes it as a release tagged `extension-v*`, with its SHA-256, marked as this repository's latest. Then fill in `links.extensionZip` with `https://github.com/PimpinPumpkin/Passbundle/releases/latest/download/passbundle-extension-chromium.zip`, which stays the newest zip from then on. Until then, Download's button goes to the list of extension releases (`links.extension`).
- **Firefox:** release Firefox installs only extensions Mozilla has signed, which needs the owner's Mozilla add-on keys. Download's Browser card says it's coming until then.
- **A paid Have I Been Pwned key:** Pricing's data breach report says it's a link to check by hand for now, and Premium's list leaves it out.
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

## Light or dark

The site follows the device until the visitor presses the moon or sun at the top (on a phone, Dark mode in the menu), and then remembers the pick in their browser (`localStorage`, never sent anywhere; the privacy policy says so). Pressing it back to the device's mode forgets the pick. `theme.mjs` has the script, inline at the top of every page's `<head>` so nothing flashes the wrong theme and it costs no request; `build.mjs` adds its hash to the CSP in `dist/_headers`, and `check.mjs` refuses any other inline script. Write dark-mode CSS as usual, inside `@media (prefers-color-scheme: dark)`: `build.mjs` scopes every such block so it answers to the device and to the button (no at-rules or nested rules inside those blocks). The script also points the screenshots' dark `<source>` and the `theme-color` tags at the theme showing. Without scripts, the button stays hidden and the site follows the device.

## The demo

The homepage's demo (`parts/tour.html`, `static/tour.js`), right under the headline, is six small apps with made-up data, each one you can play with as you would the real thing, with tips on top that point at what to try next. "Demo" in the menu opens it from any page, `/#family` and the like open a part (so do old `/tour/#family` links: `_redirects` sends `/tour/` to `/`, and the browser keeps the `#family`), and choosing a part puts it in the address. Without scripts the page shows the first part's screen and its steps as a list, or the part a link names (`:target`).

- **Extension:** a browser with two tabs. Hometown Credit Union's sign-in offers the login under the field (PassBundle's mark on the menu), then the two-step code, then shows the signed-in account; Juniper Bakery signs in with a passkey and shows the order. The toolbar icon opens and closes PassBundle's popup at any time: Vault (search, Fill or Sign in for the site, Copy on every item), Generator (password or passphrase, length, Make another, Copy), Send (Copy link, New Send), and Settings (switches; turning off the menu in sign-in fields stops it showing). The sites refuse Sign in and Verify with nothing filled in, and Sign out starts over.
- **Web vault:** search; All items, Favorites, Health, kinds, and folders; an item with Show, Copy, a two-step code that counts down, Version history with Restore, and who it's shared with; and Health's Make a new one, which takes the item off the list (fixing one of two reused passwords fixes both).
- **Desktop:** unlock with Windows Hello or the master password (clicking the field types a made-up one), open items, Lock now, and a sign-in request that arrives a few seconds after unlocking: Approve (it checks it's you first), Deny, or Later.
- **Phone:** PassBundle's Turn on autofill card, Android's list of services and its OK, a home screen (the bar at the bottom), the bank's app that PassBundle fills after the fingerprint, and the bakery's app with a passkey. Items open in PassBundle, and with autofill off, apps get nothing.
- **Family:** Invite someone (any email; up to the plan's number of people, `prices.familiesPeople` in `site.json`) with access to each shared folder, and each folder's Access to change who reaches it.
- **MSP console:** the clients (`e2e/site-shots/data.ts`'s, with their people, weak, reused, and expiring items), a client's passwords to fix by name, its people, Admin console (it says what the real one opens), the install command with Copy, and Add client.

How it's built:

- **Screens:** the extension, desktop, phone, and family screens are drawn in `parts/tour.html`. Each part's app in `tour.js` keeps its state and turns it into words: an element shows when its `data-show` has one of them and hides when its `data-hide` has one, `data-pressed` sets `aria-pressed`, and a click runs the element's `data-act`. Elements that aren't on the first screen start with `hidden`. The web vault and the MSP console are drawn by `tour.js` from its data (createElement and textContent, never innerHTML); what `tour.html` has for them is what shows without scripts.
- **Steps:** each is an `<li>` in its part's `<ol class="tour-steps">` with `data-target` (the `[data-x]` to ring), `data-state` (its scene: words the part's app reads to put the screen where the step is about when the visitor goes to it with Back or Next; each app's `scene()` says what its words mean), `data-advance="click"` (doing it, clicking the target, moves on), `data-pick` (the click is PassBundle's), `data-place` (top, bottom, left, right), and optionally `data-anchor` (the `[data-x]` the tip sits beside).
- **Playing:** clicking anything does what it would in the app. Doing what the tip says moves on; so does doing what another step says (Sign in signs in, the toolbar icon opens PassBundle, from any step). Anything else means the visitor is playing on their own, so the tip and ring step aside, leaving Back, Next, and "Show tip" under the screen; clicking the tip itself moves it aside too. An app refuses a click (Sign in with nothing filled in) with `preventDefault`, and the tip stays.
- **Fitting the screen:** a tip never covers what it points at, or what the next step points at when that's on screen, or the phone; with no room, and on screens narrower than 960 pixels, it sits under the screen. A tip whose target isn't on screen sits there too. A ring that a screen's clipped edge would cut off is drawn inside its element, a target in a strip that scrolls sideways is scrolled into view first, and on a phone the tabs are one row that scrolls to the part showing, and the MSP console's client table leaves out Members (each client's panel has it) so it fits without scrolling sideways.
- **Plays itself:** a part with `data-autoplay` (the extension: the bank's login and code, the bank's account, the bakery's passkey, and the cake) plays once when it's half on screen: a pointer moves to each target and clicks it, with a few seconds to read each tip, up to the step marked `data-autoplay-end`, and PassBundle's own clicks land with a ring. It pauses off screen, stops for good the moment the visitor clicks or types in it, and never starts by itself when the device asks for less motion. "Watch it work" and the Pause / Play / Replay button beside the tabs control it.
- **Tips:** the switch beside the tabs hides the tips and rings and leaves Back and Next under each screen; turning it off is remembered in `localStorage` (`tourTips`), which the privacy policy mentions.

Everything is made up, and nothing is stored or sent: Copy puts a made-up value on the clipboard (only when the visitor clicks it), and two-step codes are a stand-in that changes every 30 seconds. Its people and clients match `e2e/site-shots/data.ts`'s made-up family and MSP; the bank and the bakery are the demo's own.

## Motion

The "Motion" part of `styles.css`: pages cross-fade under a header that stays put (a cross-document view transition), the light/dark button spreads the new theme out from itself (a view transition started in `theme.mjs`), rows and lists rise into place as they scroll into view (a scroll-driven animation), and the demo's tip glides between steps. Only transform and opacity, all of it skipped when the device asks for less motion, and browsers without view transitions or scroll-driven animations just don't animate.
