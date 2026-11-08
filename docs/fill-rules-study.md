# Upstream's Fill Assist and our site rules: a study

Studied November 8, 2026, from the GPL client code in passbundle-clients (`keykeeper` at web-v2026.10.1) and passbundle-server (`keykeeper`). Nothing was fetched from Bitwarden's Fill Assist service or any other Bitwarden service, and no Bitwarden rule data was looked for or read: this is only what the client code does. The design that follows from it is in DESIGN.md, "Fill rules for everyone".

## Summary

- **What it is:** upstream's extension downloads a file of per-site CSS selectors ("targeting rules": where the sign-in fields are) from a feed, and on a site that has rules it uses them instead of its own field detection. Behind the `fill-assist-targeting-rules` feature flag, a per-browser setting, and an organization policy.
- **Where we stand:** the flag is off on our server, and since this change `FILL_ASSIST_RULES_URL` is empty by default, and the server keeps the flag off whenever it is, because upstream's clients use Bitwarden's feed when the server names none (see "Off on our server").
- **Compared with ours:** upstream's format describes hard pages better than our site fixes do (selectors, shadow roots, frames, split code inputs, paths, form kinds). Ours is safer and more personal: it fills alongside the generic matching instead of replacing it, keeps every limit our fill rules have, carries custom fields and never-fill per item, and has the crowd and MSP channels.
- **Recommendation:** keep upstream's Fill Assist off. Use upstream's file format for our own curated feed, so the rule lab and any tooling speak one format and switching later stays cheap, but apply the rules through our own fill-rules engine, with our limits, from a feed we sign. Reuse upstream's selector code without changing its files. Revisit when upstream's Fill Assist leaves its flag.

## 1. What upstream's Fill Assist client does

The files: `apps/browser/src/autofill/services/targeting-rules-data.service.ts` (the download), `libs/common/src/autofill/services/domain-settings.service.ts` (the gates, the feed address, and the cache), `libs/common/src/autofill/utils/targeting-rules.ts` (matching a page), `libs/common/src/autofill/types/index.ts` and `libs/common/src/autofill/constants/index.ts` (the format), `apps/browser/src/autofill/services/collect-autofill-content.service.ts` and `autofill.service.ts` (using rules on a page), and the policy, `apps/web/src/app/admin-console/organizations/policies/policy-edit-definitions/fill-assist.component.ts`.

### Where the feed is

The feed is a directory URL, not a file. The extension picks it in this order (`effectiveFillAssistRulesUrl$`):

1. **The organization policy's own URL,** when it's https and isn't the "Default" marker. The marker is the constant `DEFAULT_FILL_ASSIST_RULES_URL` (`https://fillassist.bitwarden.com`), plus one older default kept in `LEGACY_DEFAULT_FILL_ASSIST_RULES_URLS`. Any of the person's organizations with the policy on applies it to the whole account.
2. **The server's config answer,** `environment.fillAssistRules` in `/api/config`.
3. **The built-in default,** `https://fillassist.bitwarden.com`, when the server's value is missing or empty.

Point 3 matters for us: an empty value from the server doesn't mean off to upstream's clients; it means Bitwarden's feed. A trailing slash is added in every case.

The policy form shows the custom URL only on Bitwarden's cloud (`isCloud$`); on a self-hosted server it shows only the switch and saves the Default marker. But the client honors a policy's custom URL wherever it comes from, so an organization admin who sends the policy through the API can point every member's extension at a feed of their choosing. The server requires a URL when the policy is turned on (`organizations.rs`, which is how the Default marker gets saved) and requires the Single organization policy first, as upstream's server does.

### The format

- **The manifest:** `<feed>/manifest.json`, fetched with a cache-busting `?_=<time>`. The client reads only `maps.forms.v1`, an object with `filename` and `cid`. The filename must end in `.json` and contain no `/` or `\`, so the rules file sits next to the manifest. `cid` is a content hash: when it matches the one stored, nothing more is downloaded.
- **The rules file** (`FormsMapResource`): `{ "schemaVersion": "1.0.0", "hosts": { ... } }`. The client checks only that `hosts` is an object; it doesn't check `schemaVersion` or the entries.
- **A host's entry,** keyed by `URL.host` (the port only when it isn't the default; `example.com` and `example.com:8443` are separate):
  - `null`, or an entry with no forms and no paths: autofill is off on the whole host.
  - `forms`: a list of forms for every page on the host.
  - `pathnames`: `{ "/path": { "forms": [...] } }` for one page; `null` there turns autofill off on that page. Paths match exactly, after trailing slashes are trimmed; there are no patterns or prefixes.
- **A form** (`FormContent`) is the idea of a form, not necessarily a `<form>` element:
  - `category`: one of `account-login`, `account-creation`, `account-recovery`, `account-update`, `signup`, `address`, `identity`, `payment-card`, `search`.
  - `fields`: from a field key to a list of alternatives, tried in order. There are 46 keys (`AutofillTargetingRuleTypes`): `username`, `password`, `newPassword`, `oneTimeCode`, name parts, email and phone (with parts), organization, address lines and levels, birthdate parts, card fields, three consent boxes, and `searchTerm`. An alternative is a selector, or a list of selectors for one value spread over several inputs (a six-box code).
  - `container` and `actions` (`submit`, `save`, `next`, `previous`, `cancel`, `reset`): selectors too. Today only upstream's authoring tool writes them; the fill path doesn't read either.
- **Selectors** are CSS, with `>>>` to cross a boundary CSS can't: into a shadow root (`#host >>> input`) or into a frame (`iframe#login >>> input`).

### How often, and what's kept

- **Every 6 hours** (`UPDATE_INTERVAL`, a scheduled task), and also whenever the server's config answer changes (unlock, account switch, another server), the policy changes, or Fill Assist turns on. "Sync" in the extension's vault settings forces a check now, still skipping the download when `cid` matches.
- **On a failure** it tries twice more, 5 minutes apart. On the first failure it deletes the stored rules, on purpose: the code's comment prefers the generic matching over rules that might be stale. After the third failure it waits for the next scheduled check.
- **The download** is a plain `fetch` from the extension's background, with no account headers. The feed host sees the browser's address and user agent, and a check every 6 hours while Fill Assist is on. The whole file comes down at once, so the feed never learns which sites someone visits.
- **Storage:** the rules and the `cid` are kept unencrypted in the browser's extension storage, keyed by the server's API address and the feed address, so two accounts with different feeds don't mix. They're global, not per account, and aren't cleared at sign-out.
- **No signature.** What the client trusts is TLS to the feed's host, and whoever chooses the feed: the server's operator, or an organization admin through the policy.

### How rules are used on a page

1. **Asking:** when the content script collects a page's fields, it first asks the background for rules for its frame's address (`getUrlAutofillTargetingRules`; the frame's own address, not the tab's). The answer is `null` unless Fill Assist is on and the account is unlocked. The frame keeps the answer until it navigates, or until Fill Assist turns off (the background tells every tab).
2. **Replacing the generic matching:** with rules for the page, the generic field collection doesn't run at all; the code calls the two "mutually exclusive". An empty list (a host or path set to `null`) means no fields, so nothing fills there. Otherwise each field key's alternatives are tried in order and the first that finds an element wins; a selector into a frame is sent through the background to that frame's content script, hop by hop.
3. **What a found field becomes:** a minimal field marked `targeted`, with the rule's key and the form's category, and `viewable = true` whatever the page shows, because rules may point at fields that aren't visible yet (tabs, fields revealed by a click).
4. **Filling** (`generateTargetedFillScript`): when any field on the page is targeted, upstream's fill uses only the rules. A login's username goes to the first of `username`, `email`, `phone` the form has; the password to `password`; `newPassword` only for a generated password; cards and identities to their keys. `oneTimeCode` gets nothing (no codes from rules). It still asks before filling an http page and checks for an untrusted frame. It doesn't apply the generic path's other limits: only empty fields on page load, a username without a password on the page, the field types autofill skips, or the type of field a password goes into.
5. **The menu in a field:** a targeted field always gets the menu, with the fill type its form's category says.

### What turns it on

- **The feature flag** `fill-assist-targeting-rules` (off by default in the client) gates everything: the download, the setting, the policy's place in the admin console, and every use.
- **The setting** "Turn on fill assist" in the extension's Autofill settings. It's one setting for the whole browser, not per account. Until the person touches it, an organization policy turns it on; once they choose, their choice wins either way (`resolvedEnableFillAssist$`).
- **The policy** "Enable fill assist" turns it on by default for members.
- **Dev tools:** a right-click "Webmapper" for writing rules, and a field triage view, only in development builds (`fillAssistDevTools`).

### Off on our server

- The server has never sent the flag unless its operator lists it in `EXPERIMENTAL_CLIENT_FEATURE_FLAGS`.
- Since this change (passbundle-server branch `fill-rules-feed`), `FILL_ASSIST_RULES_URL` is empty by default instead of Bitwarden's address, and empty passes the config checks; a value someone sets keeps upstream's checks (https, a host, no credentials, query, fragment, or surrounding whitespace).
- Because an empty value means Bitwarden's feed to upstream's clients (above), the server also sends the flag as off whenever the URL is empty, even if the operator listed it, and warns at start when they did. So no PassBundle install sends people to Bitwarden's feed unless its operator sets that address on purpose.
- A client change could make an empty value mean off in the extension too. It isn't needed while the server keeps the flag off, and it would be one more change in upstream's files.

## 2. Compared with our fill rules and site fixes

What we have (DESIGN.md, "Autofill"):

- **Fill rules:** what someone picks with the fill picker, stored encrypted on the item (`keykeeper.fill`), synced. A field is known by its id, name, or label; a rule fills any of the item's values, custom fields included, or "never fill".
- **Site fixes:** fill-picker rules people chose to share (host, field id, name, or label, and username, password, code, or never), confirmed on a server by 3 people with verified email addresses, or approved by the operator, plus MSP site rules for an MSP's clients. Downloaded whole from the person's own server on unlock and daily.
- **Problem reports:** host and the shape of the sign-in fields, sent by a click, kept without an account.
- **Vendored site data:** Apple's MIT-licensed password rules (458 sites) and change-password pages (805), read on the device.
- **Password-change recipes** (designed in meta PR #182, none shipping): per-site selectors for the change-password page, its fields, its button, and how it says it worked.
- **The corpus and scoreboard** in tier 1.

### Where they overlap

- Both are per-site data about where the sign-in fields are, shipped as data (never code), downloaded whole, and matched on the device, so neither tells anyone which sites a person visits.
- Both cover username, password, and one-time code fields, and both can say "don't fill here".
- Both bind to a host: upstream's to `URL.host`, ours to scheme, host, and port.

### What upstream's has that ours lacks

- **Selectors,** so a field can be found by any attribute or position, inside a shadow root, or in another frame. Ours knows a field only by id, name, or label, and a label-only fix never fills without an id or name.
- **One value in several inputs** (a code split into six boxes).
- **Paths** within a host, and **form kinds** (a sign-in form and a sign-up form on one page).
- **Cards, identities, and consent boxes,** where ours covers logins.
- **A manifest with a content hash,** so a check that finds nothing new costs one small file.
- **An authoring tool** (dev builds only) and a selector generator that prefers stable attributes and warns about brittle ones (`apps/browser/src/autofill/webmapper/selector.ts`).

### What ours has that upstream's lacks

- **It adds to the generic matching instead of replacing it.** Our rules fill their fields first and the generic matching fills the rest. One rule for one awkward field doesn't take the page's other fields away; upstream's rules have to describe the whole form, or the fields they leave out get nothing.
- **Our limits** (security review, November 2026): only fields the person can see; upstream's exclusions (search boxes, captchas, newsletter forms, the field types autofill skips) and its page-load limits; https only, a password only into a password field, and only fills the person starts, for anything not from their own item. Upstream's rules can point at hidden fields on purpose and skip those limits, so a bad rule can put a password in a visible text field or a search box.
- **The person's own choices:** per-item rules, custom fields, and never-fill, synced and encrypted. With upstream's rules on a page, none of ours run: its fill returns before our fill rules, site fixes, and never-fill are applied (`generateFillScript`).
- **One-time codes** fill by rule; upstream's `oneTimeCode` key gets no value.
- **Where rules come from:** the crowd with a threshold, the server's operator, and MSPs for their clients, each with an audit trail. Upstream's has one feed per account.
- **Trust:** our site fixes come from the person's own server and its limits assume it may be hostile; upstream's trusts TLS to the feed and whoever chose it.

### Which is stronger where

- **Hard pages** (shadow DOM, frames, split codes, several forms on one page, path-specific pages, non-login forms): upstream's format.
- **Safety, privacy, and personal fixes:** ours.
- **Getting a list to everyone:** neither yet. Upstream's has the download machinery but no signature; ours has a download from the person's own server but no curated list from us.

### Could one feed the other?

- **Ours into upstream's format:** a fix with an id or name becomes a selector (`#id`, `input[name="..."]`) in a `fields` entry. But a single-field fix written as an upstream entry would switch the generic matching off for the page and leave the page's other fields empty; a label-only fix has no CSS form; and "never fill this field" has no upstream form short of turning autofill off for the whole page. So converting our fixes one by one would make filling worse.
- **Upstream's format into ours:** works well for logins. An `account-login` form's `username`, `email`, `phone`, `password`, `newPassword`, and `oneTimeCode` selectors map onto our fill rules' kinds; our engine would need to accept a selector as a way to know a field, and the content script would resolve it.
- **The rule lab** (DESIGN.md, "Fill rules for everyone") can write either. Writing upstream's format keeps both doors open.

## 3. Recommendation

Three ways were weighed:

1. **Serve our own feed in upstream's format and turn on upstream's client** (the flag, and `FILL_ASSIST_RULES_URL` pointing at our feed).
   - **For it:** upstream wrote and maintains the download, the cache, the selector engine, frame routing, the menu, and the authoring tool.
   - **Against it:**
     - Its fill path bypasses our fill rules, never-fill, site fixes, and the limits from the November security review. Keeping them means changing upstream's targeted path in several places (the early return in `generateFillScript`, `viewable = true` in `buildTargetedAutofillField`, the menu's qualification).
     - It has no signature. Adding one is another change in upstream's download service.
     - The policy lets any organization admin repoint members' extensions; the setting is per browser; the policy's words say "Bitwarden-reviewed". Each would be a change to keep.
     - Fill Assist is new and moving, behind an experimental flag: renamed strings (`V2`), a retired default address, and a format under a version key (`v1`). Upstream already moved policy checks into its SDK, which we can't read, and could move more.
     - Every change we keep sits in upstream's busiest autofill files, which DESIGN.md ("Keeping up with upstream") counts as close to the security core we keep near upstream. Each sync would mean resolving conflicts there.
2. **Keep ours only:** extend our site-fix format with what it lacks, in a format of our own. Safest, but the lab's output would be ours alone, and we would write a selector engine that already exists in the tree.
3. **Merge (recommended):** take upstream's file format and selector code, keep our engine and our feed.
   - **The format:** our curated feed is upstream's forms map (`hosts`, `pathnames`, `forms`, `fields`, deep selectors), with a manifest and content hash, a subset our engine applies (at first, `account-login` and `account-update` forms and the six login keys), and a signature of our own around it.
   - **The engine:** rules from it apply through `applyFillRules` like site fixes do: after the person's own rules and MSP rules, with the same limits, with the generic matching filling the rest.
   - **The selector code:** the content script resolves a rule's selector with upstream's `DomQueryService.queryDeepSelector` (shadow roots) and marks the field it already collected. A frame gets its own host's rules, so `>>>` into frames isn't needed. That's one hook in upstream's field collection, where option 1 needs several in the fill path; everything else lives in our own `keykeeper/` files.
   - **Upstream's Fill Assist stays off** (the flag, and the empty URL from this change).
   - **Revisit when** upstream's Fill Assist leaves its flag and gains a signature and per-field limits. Since our feed is already in its format, switching then is mostly configuration.

The cost of 3: we write a small fetcher with signature checks (about the size of `site-fixes.ts`), the selector hook in the content script, and the format reader. Against carrying changes to upstream's targeted fill path through every sync, that's the cheaper and safer side.

## Sources

- The client and server code named above, at the commits in passbundle-clients and passbundle-server `keykeeper` on November 8, 2026.
- Tranco's licensing, for the design's site list: the Tranco home page (https://tranco-list.eu/) and its methodology page (https://tranco-list.eu/methodology), read November 8, 2026.
