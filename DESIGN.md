# Keykeeper design

Status: draft, 2026-10-14. Decisions here are made unless marked "open".

## Goals

1. Onboarding that needs nobody on the phone. Install, sign in, and the vault fills itself from the browsers already on the machine.
2. Sane defaults. Nothing a business expects should require building policies first.
3. Better autofill and passkeys than upstream, proven by numbers, not claims.
4. Managed by MSPs through the RMM they already have. Entra is optional.
5. Tested by machines. A person looks only at red builds.

## Architecture

### Server

- Fork of Vaultwarden (`keykeeper-server`), AGPL-3.0.
- Postgres in production. SQLite stays supported for self-hosters.
- Individuals and families share pooled instances. Each business org gets its own instance.
- Cloudflare in front: WAF, and rate limits on the login and identity endpoints.
- The server never holds a key that can decrypt a vault. Any feature that would need one is redesigned or dropped.

### Clients

- Open-source build of the Bitwarden clients (`keykeeper-clients`), rebranded: web vault, browser extension, desktop app, CLI.
- Mobile comes later, from `bitwarden/android` and `bitwarden/ios`, with our own push delivery (APNs, FCM, and UnifiedPush on Android).
- The SDK comes from the upstream open-source `sdk-internal` build. Fork it only when we need to change it.

### Installer and agent (Windows first)

- A signed MSI plus a bootstrap script per client org, copied from the admin portal with the org's enrollment token included.
- The MSP runs the script from its RMM. The script downloads the current MSI from a fixed URL, checks the Authenticode signer against a fingerprint written into the script, and installs silently.
- The install runs once with admin rights. It installs the desktop app, writes browser policies, installs the import helper, and enrolls the machine to the org.
- **No resident service that accepts remote commands.** A hacked server must not become remote code execution on every client machine.
- Our extension IDs are compiled into the installer. It can force-install only our extension, never one named by the server.
- To change targeting, the MSP reruns the script, which applies the org's current settings.

### Import helper

- A small component, installed with admin rights, that only decrypts the browser's password key (Chrome app-bound encryption) when our signed desktop app asks for it.
- Standard users get no UAC prompt.
- EDR products will flag it, because reading browser passwords looks like credential theft. We publish signed hashes and exclusion steps for Defender, SentinelOne, and Huntress.

### Updates

- The desktop app updates itself.
- Releases are signed with a separate update-signing key kept offline.
- Release rings: internal org, then early-access MSPs, then everyone.
- Every store publisher account (Chrome Web Store, Microsoft Edge Add-ons, Firefox Add-ons, Apple, Google Play) uses hardware security keys.

## Onboarding

A domain is never required. Each org picks a preset: Solo, Family, or Business.

- **Solo:** install, create an account, automatic import from local browsers, extension added to the default browser profile. Done.
- **Family or small team:** the owner creates an org and shares an invite link or QR code. Members join with any email address. The owner sets approval to automatic or one tap.
- **Business:** the admin adds emails (any domain), runs the RMM script, or connects Entra (optional). Users added any of these ways are pre-approved. The org-key confirmation runs silently on any admin device that is online.

The target is a working vault, with imported passwords, after zero decisions beyond the org name. Tier 2 tests this for every preset.

### Which browser profiles

In order:

1. The profile signed in with the invited email.
2. A profile whose signed-in email matches an org domain, if the admin set one.
3. The browser's default profile.
4. Ask once.

Personal profiles are never imported by default.

## Defaults (Business preset)

| Setting | Default |
|---|---|
| Account recovery by admin | On, with automatic enrollment. Disclosed at signup. Turning it on later enrolls users silently at their next unlock. |
| Members added by portal, RMM, or Entra | Auto-approved |
| Members joining through an invite link | Approval required |
| Two-step login | Required for admins, nudged for everyone else |
| Master password | Minimum strength, plus a breached-password check. If the breach service can't be reached (offline or firewalled), signup continues without it and Health re-checks later. Upstream silently failed the form instead. |
| Vault lock | When the computer locks |
| Browser password manager on managed devices | Saving and password autofill off. Card and address autofill: optional toggles, default unchanged. |
| Private items when someone leaves | Stay with the org |
| Offboarding | Access revoked immediately. Shared passwords the person could see are listed for rotation. |
| Collections | "Everyone" and "Admins" created automatically |

The Solo and Family presets have no admin recovery. They use emergency access instead.

Every setting explains itself in one sentence. Changing a setting needs no action from users.

## Browser import

- Runs automatically after first sign-in.
- Sources: Chrome, Edge, Brave, Opera, and Vivaldi through the upstream GPL importer (`apps/desktop/desktop_native/chromium_importer`). Firefox is ours to write.
- Dedupe: identical URL, username, and password merge into one item. Same URL and username with different passwords: the most recently changed wins and the others go to the review queue.
- Skip "never save" entries and entries with empty passwords.
- Ends with a summary and a review queue that users clear whenever they like.

## UX we commit to

Fixes for things that annoy users of Bitwarden and 1Password today.

- **One unlock:** unlocking the desktop app unlocks the browser extension, and the other way around, over the existing authenticated native-messaging channel. Locking either one locks both.
- **Biometrics by default:** Touch ID on Mac and Windows Hello on Windows are offered at first unlock, with no separate "browser integration" setup. Admins control biometrics and password requirements in the portal.
- **Survives profile migrations:** tools like ForensiT Profile Wizard change the Windows user's SID, so locally protected data (DPAPI, Windows Hello keys) stops decrypting. Upstream's extension then works once and needs a reinstall. Ours detects local state it can't decrypt, clears it, and asks the user to sign in again. Never a broken extension.
- **Custom fields are one tap away** in every item editor (web, extension, desktop, mobile), not buried in a menu.
- **Context-aware new items:** creating an item while viewing a folder or collection puts it there.
- **Onboarding day works:** upstream rate-limits logins per IP (a burst of 10, then one per minute). A whole office behind one NAT address would get stuck after the tenth person. Rate limits become per account, with allowances for an org's known addresses and enrolled devices. Tier 2 onboards 50 users from one IP.
- **No nags:** upstream's web vault interrupts every fresh login with an extension page, an "Are you sure?" dialog, and a welcome tour. All three go. Extension setup happens through onboarding instead.

## Importing from other password managers

Upstream gives us about 70 importers. They include 1Password, LastPass (with direct import), Dashlane, Keeper, Proton Pass, Enpass, KeePass, and the browsers. Our job is making them painless.

- **Detect and guide:** the desktop app detects installed password managers and walks the user through that product's export with exact steps. Then it imports and securely deletes the export file.
- **Direct import** where the source allows it, as upstream already does for LastPass.
- **Business:** the admin bulk-imports shared vaults into collections, mapping source folders and shared folders. Each member's private items go through the same guided import during their onboarding.
- **Tests:** upstream importer specs, plus round-trip fixtures for the top formats in tier 1.

## Health (better than Watchtower)

Reports are only useful if they lead to a fix.

- **Org password rules:** admins set minimum length, character sets, or passphrases. Every generator enforces them, on every device.
- **Site-aware generation:** generated passwords also follow each site's own rules, using `apple/password-manager-resources` data, so they are never rejected.
- **One-click fix:** open the site's change-password page (`/.well-known/change-password` where available), generate a compliant password, and save it with history.
- **Privacy-preserving admin view:** org-owned items are checked by an admin's client. For private items, each member's client reports only counts (weak, reused, breached), never which items.

## Legacy contacts

Built on the inherited emergency access feature (web vault and server). Bitwarden puts it behind Premium. We include it in every plan.

- Solo and Family onboarding suggests naming a legacy contact.
- A request starts a waiting period (default 7 days). The owner gets email and push reminders and can deny the request at any time. With no response, access is granted.
- The access level is either view or takeover.
- A printable instructions sheet helps the family find the account.
- **Open:** letting owners exclude items or folders. Upstream grants the whole vault.

## Account keys (open)

- **Upstream model:** the master password and email go through a KDF (PBKDF2 by default, or Argon2id) to make the master key, which unlocks the account key stored on the server. The server never sees the master password. If the database is stolen, each vault can be attacked offline, and only the master password's strength protects it.
- **1Password model:** the master password is combined with a 128-bit Secret Key that never leaves the user's devices, so a stolen database is useless. The cost is the Secret Key step in onboarding, which is exactly the friction we want to remove.
- **Proposal:**
  1. Version 1 keeps the upstream model with stronger defaults: Argon2id, plus master-password strength and breach checks at signup. Changing the key hierarchy is the riskiest change possible.
  2. Business orgs get trusted-device unlock, where a device key works like a Secret Key the user never sees.
  3. After an external crypto review: an optional account key for Solo and Family, added to the KDF input and kept on devices and in the recovery kit. New devices get it from an existing device by QR code, never by typing or downloading.

## Browser password manager

Disable it, don't purge it.

- **Browser level:** policies `PasswordManagerEnabled`, `AutofillCreditCardEnabled`, and `AutofillAddressEnabled` in Chrome and Edge, plus the Firefox equivalents.
- **Profile level:** the extension sets the same switches through the browser's privacy API, only in profiles where it is active.
- **Open:** does the policy stop already-saved passwords from filling? Sources disagree. Tier 2 settles it.

## Passkeys

- Inherited from upstream GPL code: passkeys in the browser extension, the Windows 11 plugin authenticator and macOS AutoFill provider on desktop, and Android Credential Manager and the iOS credential provider on mobile.
- Our job: make sure `keykeeper-server` stores and syncs passkey items correctly (verify against Vaultwarden), then cover registration and sign-in in tiers 1 and 2.

## Autofill

The goal is to be measurably better than upstream. 1Password currently does this much better than Bitwarden.

- **Corpus:** reduced fixtures of real login patterns. Multi-step logins, iframes, shadow DOM, single-page apps, one-time-code fields, signup and change-password forms, card forms.
- **Scoreboard:** every commit runs both the upstream extension and ours against the corpus. We publish the numbers.
- **Reference material** (compatible licenses only): Chromium autofill heuristics (BSD-3-Clause), Firefox form detection (MPL-2.0), and `apple/password-manager-resources` quirks data (MIT).
- **Per-site corrections:** handled by fill rules (next section). Sharing form structure (never values) is a later, opt-in idea.

### Choosing what fills where

Upstream fills a custom field only when its name exactly matches the page field's name, id, or label, so users end up reading HTML to make it work. Keeping the password from landing in the wrong field is just as hard. Ours:

- **Fill picker:** from the extension popup, or by right-clicking any field, choose "Fill this field with...". The list shows every value on the item (username, password, one-time code, each custom field, card and identity fields) plus "Never fill this field". One click fills it now and remembers the choice.
- **Rules travel with the item.** They are stored encrypted with the item, so they sync to every device. Site-wide "never fill" rules live in the user's encrypted settings.
- **Durable field identity:** a rule identifies a field by a fingerprint (autocomplete, name, id, label text, type, and position in the form), so small page changes don't break it.
- **Custom fields never fill on a guess.** They fill by rule, or by a confident label match ("Customer ID" against "Customer number") that the user confirms with one tap the first time.
- **Readable rules:** the item editor lists its rules in plain language, for example "bank.com: 'Customer number' gets Customer ID". Users can change or delete them there.
- **Open:** how `keykeeper-server` stores item data. Rules need either a new encrypted field or a reserved custom field to stay compatible.

### One-time codes never become passwords

This is a hard invariant, enforced by tier 1 tests.

- Fields classified as one-time code inputs are never treated as password fields. Signals: `autocomplete="one-time-code"`, OTP, 2FA, MFA, or verification hints, and short numeric inputs that follow a login step.
- The save or update prompt never offers a value that equals the item's current TOTP code. It also never offers a value that looks like a code (4 to 8 digits) when the saved password is not itself all digits.
- Every password update keeps the old value in password history, and the notification has an Undo.
- The corpus includes many one-time-code page variants. Any save prompt on them fails the build.

## Browser extension management (later)

- Version 1: an inventory of other installed extensions and their permissions, plus alerts for newly added extensions with broad permissions.
- Later: allow and block lists through policy.
- Never force-install third-party extensions.

## Testing

| Tier | When | Contents |
|---|---|---|
| 1 | Every commit, minutes, fully repeatable | Unit tests. Encryption test vectors. Server API tests. A permission matrix (every endpoint times every role, plus another org's member and an unauthenticated caller). Import dedupe on fixed fixtures. Stand-in OIDC, Graph, and SCIM servers. The autofill corpus in Chromium and Edge. |
| 2 | Nightly, slow, still repeatable | A fresh Windows VM with pinned browser versions: RMM-style install as admin, policies verified, browser profiles seeded with known saved passwords, onboarding driven through the desktop app, import counts verified, the extension present only in targeted profiles, the password manager off where targeted, the user auto-approved. Also: upgrade from N to N+1, and database migrations on SQLite and Postgres. |
| 3 | Nightly canary, not repeatable by design | Latest Chrome, Edge, and Firefox. A real Entra dev tenant. A weekly test merge of upstream `bitwarden/clients` and Vaultwarden. Red here means the world changed, not that we broke something. |

Determinism rules:

- Inject the clock.
- Test encryption by round trip and known vectors, never by comparing ciphertext.
- No live network in tiers 1 and 2.
- Each test gets a fresh database.
- Wait on state, never on sleeps.

The maintainer gets a morning summary, with screenshots and video only for failures.

## Known gaps

- Help, Terms of Service, and Privacy Policy links point at placeholder pages on `brand.json`'s domain until we publish our own.
- The installer's extension IDs are placeholders until the store listings exist.

## Milestones

1. Fork and rebrand `keykeeper-clients` and `keykeeper-server`. Tier 1 CI. A tier 2 Windows job that does an RMM-style install and verifies the policies.
2. Spike: seed real browser profiles with known saved passwords, including Chrome app-bound encryption. Tier 2 depends on it.
3. Onboarding wizard, autonomous import, presets, and defaults.
4. Autofill corpus and scoreboard.
5. Admin and MSP console, written clean-room (see CLEAN_ROOM.md).
6. Mobile apps with our own push delivery.
