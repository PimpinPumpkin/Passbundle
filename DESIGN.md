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
| Master password | Minimum strength, plus a breached-password check |
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
- **Per-site corrections:** when a user fixes a fill, store a rule for that domain locally. Sharing form structure (never values) is a later, opt-in idea.

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

## Milestones

1. Fork and rebrand `keykeeper-clients` and `keykeeper-server`. Tier 1 CI. A tier 2 Windows job that does an RMM-style install and verifies the policies.
2. Spike: seed real browser profiles with known saved passwords, including Chrome app-bound encryption. Tier 2 depends on it.
3. Onboarding wizard, autonomous import, presets, and defaults.
4. Autofill corpus and scoreboard.
5. Admin and MSP console, written clean-room (see CLEAN_ROOM.md).
6. Mobile apps with our own push delivery.
