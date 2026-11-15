# passbundle.com

The PassBundle website: the home page (with the demo and the questions), Features, Personal, Business, MSPs, Pricing, Download, Switch to PassBundle, Security, Help, the privacy policy and terms, and the pages the apps link to (`/download/`, `/contact/`, and `/browser-start/`, which the extension opens after it's installed). Plain HTML, one stylesheet, and the apps' typeface, Google Sans Flex: no cookies, nothing loaded from anyone else, which the privacy policy promises, and two scripts of our own: the light or dark switch, inline in every page (`theme.mjs`), and the demo (`static/tour.js`), on the home page.

Light or dark like the visitor's device: a near-white neutral ground (`#FAFAF8`) with the logo's emerald as the one accent in light mode, a near-black neutral ground (`#0B0D0E`) with mint in dark mode and no color washes, deep green bands where a page changes the subject, flat tinted tiles (each kind of item keeps its color as a soft tint, with the glyph in that color), and the logo's emerald tile, the one glossy tile (as the app icon), with "passbundle" in two tones. Every text passes WCAG AA in both themes. The site moved to this look in November 2026, and the apps' item tiles are flat too (DESIGN.md, "The look"), as the screenshots show.

- `pages/`: one file per page, with a title and description at the top (and `index: no` on a page search engines shouldn't list, "Search engines"). `index.html` is `/`, `help.html` is `/help/`. `layout: wide` is for marketing pages built from sections; the rest are reading pages on one panel. `parts/` holds pieces of pages kept in their own file (`<x-part name="tour"></x-part>`). `script: tour` loads `/tour.js`, deferred: only our own files, by name, and the CSP (`script-src 'self'`) refuses anything else.
- `site.json`: prices and links, used in pages as `{{prices.premium}}` or `{{links.apps}}`, so a price changes in one place. An empty link isn't live yet: pages fall back to `/download/` until it's filled in. The header's Sign in goes to `links.vault`, and until that's filled in, to Download's Web card (`/download/#web`), which says when sign-in opens. `links.vault` and `links.signup` also decide what the pages say about the hosted service and new accounts ("Going live"). `"indexed"` says whether search engines may index the built site ("Search engines"). `links.apps` is the apps' test releases on GitHub; the Download page links there, never to one version. `{{links.extensionZip|links.extension}}` is the first of the two that's filled in: the Download button for the extension goes to the newest release's zip, or to the list of extension releases until the first one is out.
- `<x-shot name="msp-console" alt="..." frame="desktop">`: a screenshot from `static/shots`, with its dark version in dark mode. Until `e2e/site-shots/` has made it, it's a placeholder the size of its `frame` (`desktop`, `popup`, or `panel`), and `check.mjs --launch` refuses it.
- `<x-tile icon="console" tone="sapphire">`: a tile tinted with its tone and its glyph in that tone, as the apps show each kind of item, with a glyph from `icons.mjs` (the apps' own glyphs, and some drawn for the site). Tones: brand, sapphire, topaz, amethyst, turquoise, onyx, aquamarine, garnet, emerald, ruby, gold.
- `<x-art name="LockIcon">`: one of the apps' drawings from `art/`, inline so it takes the page's colors.
- `<x-if link="vault">...</x-if>`: kept only when that link in `site.json` is filled in. `<x-if not link="vault">` is kept only while it's empty. `<x-if link="vault" until="signup">` is kept only once the first is filled in and while the second is empty: the hosted vault open for signing in before new accounts are. Download's Web card shows one of three things this way: a sentence saying when sign-in opens, then a Sign in button with a line saying new accounts aren't open yet, then Sign in and Create an account (`<x-if link="signup">`; the build refuses `links.signup` without `links.vault`). One `<x-if>` can't go inside another, and a page's title and description at the top don't take them.
- `static/`: copied as is: the stylesheet, fonts (with their license), screenshots, the browsers' logos (`browsers/`, see below), favicon, `security.txt`, and Cloudflare Pages' `_headers` (security headers) and `_redirects` (the apps' old help-article and product links). `robots.txt` and `sitemap.xml` aren't here: the build writes them ("Search engines").
- `art/`: drawings copied from passbundle-clients `brand/artwork/` (made by `draw.mjs` there). Copy again when they change.
- `build.mjs` wraps each page in the shared header and footer into `dist/`, and lists the screenshots still to make. `check.mjs` fails on a broken link or image, a missing page, a script that isn't one of our own files (inline, or from anyone else), an inline style or event handler (the CSP blocks them), an em dash, a placeholder the build didn't fill in, or files for search engines that don't agree with `"indexed"`. Then it says whether search engines are told to index the site, and lists what isn't filled in yet, in two groups: what blocks going live on passbundle.com, and what doesn't.

```sh
node site/build.mjs && node site/check.mjs   # build and check
site/deploy.sh                                 # build, check, and deploy the preview
```

CI runs the build and check on every change to `site/`.

Download shows its four kinds (browser, phone, computer, web) side by side, two by two below 960 pixels. On a phone they're a switcher under the title instead, and only one kind's card shows, so none is a scroll away. No tab is picked when the page opens: until someone picks one, the card named in the address shows (`/download/#web`, where the header's Sign in leads until `links.vault` is filled in), and Phone shows when the address names none. The switcher is radio buttons, `:has()`, and `:target` in `styles.css`, no script; a browser without `:has()` shows the four cards one under another.

## Browser logos

Download's Browser card shows the logo and name of each browser the extension works in: Chrome, Edge, and Brave, and Firefox marked as coming until its build is signed. Safari isn't shown, because there is no Safari build. The logos are the SVG files from the `@browser-logos` packages on npm (source: https://github.com/alrra/browser-logos), copied to `static/browsers/` on November 9, 2026:

| File | Package | Version |
| --- | --- | --- |
| `chrome.svg` | `@browser-logos/chrome` | 2.0.0 |
| `edge.svg` | `@browser-logos/edge` | 2.0.7 |
| `brave.svg` | `@browser-logos/brave` | 3.0.13 |
| `firefox.svg` | `@browser-logos/firefox` | 3.0.10 |

They're used as they come, in an `<img>` with its width and height: not recolored, cropped, or edited. The logos are their owners' trademarks, and the fine print at the foot of Download says whose each one is, so a logo added to another page needs that line there too. To update one, get the exact version with `npm pack --ignore-scripts @browser-logos/chrome@2.0.0` in an empty folder outside the repository, unpack it without running anything from it, read the SVG to confirm it has no `<script>`, no event handlers, and no references to other files or addresses, copy it over, and change the version and date here.

## Screenshots

Every screenshot is made from the real apps by `e2e/site-shots/`, with made-up people and data (`e2e/site-shots/data.ts`), on a local test server that sends email to the test mail catcher (as the hosted service does, so account recovery shows) and answers as vault.passbundle.com, so no local address shows on screen. The list, and the page each one is on, is at the top of `site-shots.spec.ts`: a person's vault in the web vault and the extension, signing in to one's own server, an MSP with five clients (the console, a client's passwords to fix, default policies, an install command, Entra provisioning, and an item's history), and a company with its own IT (members, policies, install command, and a shared folder's permissions).

On GitHub, the **Site screenshots** workflow (`.github/workflows/site-shots.yml`) does all of this: start it from the Actions tab after the apps' look changes (it also runs on the first of each month). It builds both from their `keykeeper` branches with Tier 1, without its tests, takes the shots, and when they changed, pushes them to the branch `site-shots-update` with a link in the run's summary to open the pull request. Open it, merge it, and deploy.

To take them on your own computer, build the server from passbundle-server's `keykeeper` branch and the web vault and extension from passbundle-clients' `keykeeper` branch (see `e2e/README.md`), never from a branch that isn't merged, so every shot shows the look people get. Then run it, and commit the images:

```sh
cd e2e && npx playwright test -c playwright.site.config.ts
```

It writes 2x WebP images, light and dark, to `site/static/shots/`. It takes about five minutes.

## Going live

`site/deploy.sh` deploys to the preview address, https://preview.passbundle.pages.dev, never the live site. `site/deploy.sh --production` deploys passbundle.com, and refuses until `node site/check.mjs --launch` passes. That check refuses three things: a highlighted placeholder (`<mark class="todo">`: the legal ones in the privacy policy and terms, and a screenshot not made yet), an empty `links.vault`, and an empty `links.extensionZip`. It doesn't refuse an empty `links.signup` or an empty store listing (`links.chrome`, `links.edge`, `links.firefox`): the pages read true without them.

On the day:

1. In `site.json`, set `links.vault` to the hosted web vault's address, `https://vault.passbundle.com`.
2. In `site.json`, set `links.extensionZip` to `https://github.com/PimpinPumpkin/Passbundle/releases/latest/download/passbundle-extension-chromium.zip`. The extension's first release has to be out first ("The extension's first release", below).
3. In `pages/privacy.html` and `pages/terms.html`, replace each highlighted placeholder: the company's legal name, the payment processor, the server host, the storage provider, refunds, and the governing law.
4. Run `site/deploy.sh --production`, and commit what you changed.

`node site/build.mjs && node site/check.mjs` says at any time what's left, under "blocks going live on passbundle.com".

Two more values in `site.json` change when you're ready, each followed by the same command:

- `links.signup`, when new accounts open: `https://vault.passbundle.com/#/signup` (the web vault's sign-up page).
- `"indexed": true`, when search engines should list the site ("Search engines").

No page has to be edited for any of these. What the pages show follows the two links:

| `links.vault` | `links.signup` | What the pages show |
| --- | --- | --- |
| empty | empty | Before launch. The hosted service "opens at launch", the apps sign in to a server you run yourself, and the header's Sign in goes to Download's Web card, which says when sign-in opens. |
| filled in | empty | The hosted vault is open and new accounts aren't. Sign in goes to the vault, and the "opens at launch" wording is gone. Where a page would send someone to make an account, it says new accounts aren't open yet and to see Contact: Download's testing note and Web card, the homepage's last section, Help's "How do I start?", and `/browser-start/`. Contact gains a line on how to ask. |
| filled in | filled in | New accounts are open. Download's Web card, the homepage's last section, and Help's "How do I start?" have Create an account, and the lines about asking for one are gone. |

The places that follow `links.vault` alone: Download's testing note, the homepage's last section and its two "use our hosted service" lines, Help's "How do I start?", Switch's first step, and the hosted-service lines on Business and MSPs. The notes about paid plans don't follow it ("Paid plans and billing", below).

While new accounts aren't open, the server has to refuse them too (`SIGNUPS_ALLOWED=false`, `deploy/README.md`): the web vault, the extension and the apps each have their own way to make an account, and the site isn't in front of any of them. Where Create account would be, the web vault and the extension then say new accounts aren't open yet (DESIGN.md, "New accounts on a closed server").

## Search engines

`"indexed"` in `site.json` is `false` for now. While it is, `build.mjs` adds `X-Robots-Tag: noindex` to the block for every path in `dist/_headers`, writes a `robots.txt` that allows everything, and writes no sitemap. Once it's `true`, the header is left out, `robots.txt` also names `https://passbundle.com/sitemap.xml`, and the build writes that sitemap with every page but the 404 and the pages that keep themselves out (below). `check.mjs` says which of the two a build is, and fails when the three files don't agree with `site.json`. A `robots.txt` or `sitemap.xml` put in `static/` stops the build.

`robots.txt` never turns crawlers away. A crawler that's turned away never fetches a page, so it never sees the header, and a search engine can still list an address it found linked somewhere else, without anything from the page. Let in, it fetches the page, sees `noindex`, and leaves it out. `check.mjs` fails on a `robots.txt` that disallows everything.

`index: no` at the top of a page keeps that one page out of search engines whatever `"indexed"` says: the build gives it `<meta name="robots" content="noindex">` and leaves it out of the sitemap. `/browser-start/` has it, because that page only means something right after installing the extension.

## Before launch

The site says what's true today, and says plainly what waits for launch. Every page was checked against the code on November 6, 2026. On November 9, these were checked again: where the apps and the extension sign in, two-step login in the apps, the automated tests on Security, the privacy policy's scope, the desktop app's import from browsers on Features, and Touch ID in the Mac app on Download and Business. As each piece arrives, change the words that wait on it:

- **The hosted service** at vault.passbundle.com: nothing to edit. Fill in `links.vault`, and later `links.signup` ("Going live").
- **Paid plans and billing** (Free, Premium, Families, Business, pooled MSP seats, the trial): the "start at launch" notes on the homepage, Personal, Pricing, Business, MSPs, and Help, and the plan buttons (Try the demo, Talk to us) back to sign-up and the trial. These stay as they are when `links.vault` is filled in, because billing isn't built; they're edited by hand when it is. Today every account gets Premium's features, and Families isn't limited to its number of people.
- **The browser store listings:** fill in `links.chrome`, `links.edge`, and `links.firefox`, put Add to buttons on Download's Browser card (the zip to install by hand can stay, under them), drop "once it's in their stores" from the install command's words (the homepage, Features, Business, MSPs, Help, and the demo's MSP console), and take out "isn't in the browsers' stores yet" (the homepage's last section, Help's "How do I start?", Personal's list under the headline and "Which devices does it work on?", and Download's Browser card). A store lists the extension when it approves it, which can be after passbundle.com is live, so none of these lines names a date. The installer's store extension IDs, placeholders until then, change too.
- **Email** (hello@, privacy@, and security@) and GitHub's private vulnerability reporting: Contact, Security, `static/.well-known/security.txt`, and the Talk to us buttons, which go to Contact. Contact's line on asking for an account, which shows while new accounts aren't open, sends people to a GitHub issue until hello@ works.
- **Signing:** the offline update key (Security, "No remote control"), Touch ID in the browser extension on a Mac with Apple's signing (Download's "Opening a test build", Business's Macs question), and code signing for the script module (Features).
- **Checks for real:** Windows Hello on a real device (Download, Personal, Pricing), Touch ID in the Mac app on a real Mac (Download, Business), Sign in with Entra and provisioning with a real Microsoft 365 tenant ("Not yet checked" on Business, MSPs, Pricing, and Features), and events with Sentinel, Huntress, and Blumira (Business, Features, MSPs).
- **The command-line tool's first release:** Download's card links its guide until then (`links.cli` is its releases).
- **The extension's first release:** start **Extension release** (`.github/workflows/extension-release.yml`) from the Actions tab, on main. It builds the branded extension for Chrome, Edge, and other Chromium browsers from passbundle-clients' `keykeeper` branch, and publishes it as a release tagged `extension-v*`, with its SHA-256, marked as this repository's latest. Then fill in `links.extensionZip` with `https://github.com/PimpinPumpkin/Passbundle/releases/latest/download/passbundle-extension-chromium.zip`, which stays the newest zip from then on. Until then, Download's button goes to the list of extension releases (`links.extension`).
- **Firefox:** release Firefox installs only extensions Mozilla has signed, which needs the owner's Mozilla add-on keys. Download's Browser card says it's coming until then.
- **Firefox's password manager in the install scripts:** the scripts turn off only Chrome's and Edge's own password managers today, so the install command's words name those two (the homepage, Features, Business, MSPs, Help's two install command answers, and the demo's MSP console). Once the scripts turn off Firefox's too, those lines can say "the browsers' own password saving" again.
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
