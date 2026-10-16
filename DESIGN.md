# PassBundle design

Status: draft, 2026-10-14. Decisions here are made unless marked "open".

## Goals

1. Onboarding that needs nobody on the phone. Install, sign in, and the vault fills itself from the browsers already on the machine.
2. Sane defaults. Nothing a business expects should require building policies first.
3. Better autofill and passkeys than upstream, proven by numbers, not claims.
4. Managed by MSPs through the RMM they already have. Entra is optional.
5. Tested by machines. A person looks only at red builds.

## Architecture

### Server

- Fork of Vaultwarden (`passbundle-server`), AGPL-3.0.
- Postgres in production. SQLite stays supported for self-hosters.
- Individuals and families share pooled instances. Each business org gets its own instance.
- Cloudflare in front: WAF, and rate limits on the login and identity endpoints.
- The server never holds a key that can decrypt a vault. Any feature that would need one is redesigned or dropped.

### Clients

- Open-source build of the Bitwarden clients (`passbundle-clients`), rebranded: web vault, browser extension, CLI. The vault UI people use every day is the extension and the web vault.
- **No Electron.** We don't ship upstream's Electron desktop app (about 150 MB on disk and hundreds of MB of RAM for what is mostly a tray icon). The desktop side is a small native agent. See "Desktop agent" below.
- Mobile comes later, from `bitwarden/android` and `bitwarden/ios`, with our own push delivery (APNs, FCM, and UnifiedPush on Android).
- The SDK comes from the upstream open-source `sdk-internal` build. Fork it only when we need to change it.

### Desktop agent (no Electron, no web view)

One small native app per computer, written in Rust. No bundled browser engine and no web view.

- **No windows in version 1.** It lives in the tray (menu bar on macOS) with a native menu, and talks through native notifications. Anything visual, like onboarding steps, the vault, or settings, opens in the browser extension or the web vault, which people already have.
- **What it does:**
  - Unlocks the extension with Windows Hello or Touch ID, and unlocking one unlocks the other (the 1Password behavior). It speaks the native-messaging protocol the extension already uses with upstream's desktop app. That app has its own login and holds the user key; the agent has neither, so the extension hands it the user key when someone turns biometric unlock on. That's a change to key handling, so it has its own design and test vectors: see "Biometric unlock".
  - Reports what's set up on the machine: which browsers and profiles have the extension, and whether the browser's password manager is off.
  - Drives onboarding for managed users by opening the right page at the right time.
- **Upstream's Rust, with care:** the `desktop_native` crates are GPL-3.0, but `biometric` links Bitwarden's SDK crates, which declare a license file instead of a standard open-source license, and `desktop_core` links `bitwarden-russh`, which declares none. So the agent is its own Cargo workspace (`apps/agent` in `passbundle-clients`) and links neither. GPL code it takes from upstream is copied in with a note saying where from.
- **Targets:** installer under 10 MB, under 20 MB of RAM when idle, no extra processes.
- **Updates:** a small self-updater. A release is a manifest signed with our offline update key (minisign), and the agent installs it only if the signature verifies with the key compiled in, it's for this platform, it's newer, it's served over HTTPS, and the download has the stated size and SHA-256. Installed agents update from a scheduled task (Windows) or a launch daemon (macOS), never because the network told them to. Organizations that push updates through their RMM turn self-updates off by policy.
- **A desktop vault window is a later decision**, made only if customers ask for one. The options then: native UI per OS (SwiftUI on macOS, WinUI on Windows), the lightest and most native but two UIs to build; or Tauri, which reuses the Angular UI through the OS's own web view, much lighter than Electron but still a few browser processes on Windows.
- **Order:** Windows first, then macOS.
- **Status:** the foundation is built (`apps/agent`, version 0.1): the tray icon and menu (the version, Open web vault, Quit), one agent per signed-in user, settings by policy (web vault URL, self-updates off), and the signed self-updater. Tier 1 runs its tests on Windows and macOS, checks the release build is under 10 MB (0.9 MB on macOS), and runs it in the tray. Idle, it uses 8.5 MB of memory on macOS. Not yet: the update key (made offline; until then builds don't update themselves), installing it from the RMM script (waits on code signing), biometric unlock, and the MSP work.

### Biometric unlock (Windows Hello and Touch ID)

Unlock the browser extension with Windows Hello or Touch ID, through the desktop agent. The agent has no login and no vault, so it can only hand back a key the extension gave it.

**Status:** built for Windows, not yet tried on a real Windows Hello device. The agent's channel and protocol (`apps/agent/src/channel.rs`, `protocol.rs`), its socket and native-messaging host (`ipc.rs`, `host.rs`), Windows Hello (`windows_hello.rs`, `sealed.rs`), and the extension's side (`apps/browser/src/keykeeper/agent-biometrics.ts`). Tier 1 runs it all with a stand-in for Windows Hello, on Windows, macOS, and Linux. Next: one check on real Windows Hello hardware, then the installer registering the host (it waits on code signing). macOS waits on signing too.

- **The protocol is upstream's native-messaging one**, the one the extension already speaks with upstream's desktop app, and all of it is GPL TypeScript we can read:
  - The browser starts our native-messaging host, a pipe to the agent: 4-byte native-endian length, then JSON, 1 MB at most. The host sends `{"command":"connected"}` once it reaches the agent and `{"command":"disconnected"}` when the agent goes away.
  - **Key exchange:** the extension sends `setupEncryption` with a new RSA-2048 public key (SPKI) and the active user's id. The agent makes a 64-byte session key (AES-256-CBC key and HMAC-SHA256 key) and returns it encrypted with RSA-OAEP (SHA-1, as upstream). Unlike upstream's desktop app, it sets up a channel for any user, since enrolling needs one and nothing comes back without a prompt; upstream answers `wrongUserId` for an account it doesn't have. A message under a session the agent doesn't have, or with a bad MAC, gets `invalidateEncryption`, and the extension starts over.
  - **Messages** are then type-2 EncStrings (AES-256-CBC with HMAC-SHA256) under the session key, carrying `command`, `messageId`, `userId`, and `timestamp`. Both sides drop a message more than 10 seconds from their clock, and replies carry the request's `messageId`. The extension waits 60 seconds for a reply, so a prompt must finish in that time, and the agent stamps a reply when it sends it, after the prompt.
  - **Commands the agent answers:** `getBiometricsStatus`, `getBiometricsStatusForUser`, `unlockWithBiometricsForUser` (prompts, then returns the user key), and `authenticateWithBiometrics`. Unknown commands get no reply, as upstream.
- **Not upstream's "shared unlock".** That newer feature runs over the SDK's own IPC protocol, whose messages, encryption, and peer checks live inside the SDK, which we can neither read nor link. It's off unless the server sends two feature flags, and ours can't: they aren't on its list of flags it will send (`SUPPORTED_FEATURE_FLAGS`).
- **One command of our own, `keykeeper.biometric.enroll`.** Upstream's desktop app has its own login and holds the user key; ours doesn't. So when someone turns on "Unlock with biometrics" in the extension while unlocked, the extension sends the agent the active user's id and user key over the encrypted channel. The agent asks for Windows Hello or Touch ID ("Turn on unlock with Windows Hello for <email> in <browser>?"), and stores the key only if the person confirms. `keykeeper.biometric.remove` deletes it, sent when the setting is turned off and at logout. The agent also deletes a user's key when unlocking with it fails, so a stale key (after a key rotation, say) can't keep failing.
- **Where the agent keeps the key:**
  - **Windows:** like upstream's GPL implementation, without its SDK crates. Each enrollment gets a random 32-byte challenge. Windows Hello signs it with a key credential only after the person authenticates, and the signature (RSA PKCS#1 v1.5, so the same every time) is hashed with HKDF-SHA256 into a key that seals the user key with AES-256-GCM. The challenge and the sealed key are stored in the user's app data, wrapped with DPAPI. Windows Hello opens its prompt behind the browser when the program asking isn't in front, so the native-messaging host, which the browser started and so may, lets the agent bring it forward (`AllowSetForegroundWindow`).
  - **macOS:** a keychain item that only Touch ID (the current set of fingerprints) can open, in the data protection keychain. That needs the agent signed with our Apple developer ID and a keychain entitlement, so on macOS biometric unlock waits for signing. We won't ship the weaker "ask for Touch ID, then read a normal keychain item" fallback upstream uses.
- **What it protects against, and what it doesn't:**
  - Nothing leaves the computer, and the server isn't involved.
  - The key exchange isn't authenticated: any program running as the person can connect, as with upstream's desktop app. It still can't get a key without the person passing Windows Hello or Touch ID. One prompt at a time, and none for 10 seconds after a cancel, so a program can't nag the person into approving. Windows shows its own text in a key credential's prompt, so on Windows the prompt can't name the browser or the account.
  - The agent's socket is the signed-in user's alone: a Unix socket in their own folder (0700) on macOS, and on Windows a named pipe whose access list allows only them and SYSTEM, created as the first instance of its name so no other program can claim it. Later, with signed builds: accepting connections only from our own signed host.
  - Malware already running as the person is out of scope, as for every password manager: it can read an unlocked extension's memory.
- **The host's name is ours.** Upstream's extension asks for `com.8bit.bitwarden`; `brand/apply.mjs` changes it at build time to brand.json's `nativeMessagingHost` (`com.passbundle.agent`). The installer registers the host machine-wide for Chrome, Edge, and Firefox, allowed only for our extension IDs, which are compiled in.
- **Extension changes**, each in a `// Keykeeper:` block: the host name (by brand), sending `enroll` when biometric unlock is turned on and `remove` when it's turned off or at logout, and showing the agent's answer ("Windows Hello is set up" or why not). How the extension unlocks with the key the agent returns is upstream's code, unchanged.
- **The extension asks for native messaging at install, not later.** Upstream makes it an optional permission, so turning biometric unlock on means a permission prompt and an extension reload. Ours makes it required (by brand, in the manifest), which matches "Biometrics by default" below: one less prompt, and nothing to approve on managed installs. The cost: the store listing's install warning adds "Communicate with cooperating native applications."
- **Test vectors, before any code:**
  - **Crypto interop (done):** `apps/agent/tests/vectors/native-messaging.json` holds a fixed session key, four messages with fixed IVs and the EncStrings they make, and a session key wrapped to a fixed test RSA key. `check-upstream.mjs` runs upstream's own crypto (the SDK's `PureCrypto`, which the extension uses for exactly these operations) on them: every message decrypts, a change to the IV, ciphertext, or MAC is refused, the wrapped key unwraps, and upstream's own EncStrings have the same layout. The agent's Rust tests decrypt every message and re-encrypt each, with its IV, to the identical string, and their wrapped keys unwrap with the same RSA parameters.
  - Windows sealing: a fixed challenge, a fixed stand-in signature, and a fixed user key give a known sealed blob.
- **Tests:**
  - Rust protocol tests: the key exchange, a wrong user, the 10-second window, unknown commands, oversized messages, and the prompt limits.
  - End to end in Tier 1 on Linux Chromium: a test build of the agent with a stand-in authenticator (only with a test feature, and release builds refuse to build it) and no tray, registered as the test profile's native-messaging host. The real extension turns biometric unlock on, locks, and unlocks with it; a canceled prompt leaves it locked; another user gets nothing.
  - Real Windows Hello and Touch ID prompts can't run in CI. Each release gets one check on real hardware.

### Installer and agent (Windows first)

- A signed MSI plus a bootstrap script per client org, copied from the admin portal with the org's enrollment token included.
- The MSP runs the script from its RMM. The script downloads the current MSI from a fixed URL, checks the Authenticode signer against a fingerprint written into the script, and installs silently.
- The install runs once with admin rights. It installs the desktop agent, writes browser policies, installs the import helper, and enrolls the machine to the org.
- **No resident service that accepts remote commands.** A hacked server must not become remote code execution on every client machine.
- Our extension IDs are compiled into the installer. It can force-install only our extension, never one named by the server.
- To change targeting, the MSP reruns the script, which applies the org's current settings.

### Import helper

- A small component, installed with admin rights, that only decrypts the browser's password key (Chrome app-bound encryption) when our signed desktop agent asks for it.
- Standard users get no UAC prompt.
- EDR products will flag it, because reading browser passwords looks like credential theft. We publish signed hashes and exclusion steps for Defender, SentinelOne, and Huntress.

### Updates

- The desktop agent updates itself (see "Desktop agent").
- Releases are signed with a separate update-signing key kept offline.
- Release rings: internal org, then early-access MSPs, then everyone.
- Every store publisher account (Chrome Web Store, Microsoft Edge Add-ons, Firefox Add-ons, Apple, Google Play) uses hardware security keys.

## MSP console

The MSP side is where we win, so it gets the most care: one place to run every client, and a backend that's small and tested end to end. Upstream's version of this ("Providers") is under the Bitwarden License, so ours is written from scratch (see CLEAN_ROOM.md).

### How an MSP reaches its clients

- **An MSP** is a server-side group: a name, its staff, and its client orgs. Each client org belongs to at most one MSP.
- **Staff roles:** MSP admins manage the MSP, its staff, and its clients. Technicians work in client orgs.
- **Staff are ordinary members of each client org,** marked as coming from the MSP: MSP admins as owners, technicians as admins. Adding someone to the MSP adds them to every client; adding a client adds every staff member. Removing someone from the MSP removes them everywhere at once.
- **No new crypto.** Staff get each org's key the normal way: an org member who already holds it confirms them, which encrypts the org key to the new member's public key. The MSP console does this automatically whenever any MSP admin has it open. The server never holds a key that can decrypt a vault. The trade-off is the same as upstream's automatic confirmation: we trust the server to hand out the right public key. Showing key fingerprints when staff are added comes later.
- **The client stays in control.** A client org's owner sees the MSP's staff listed separately ("Your MSP"), and can remove the MSP, which removes all of its staff from the org in one step.
- MSP staff don't count as the client's seats.

### What the console shows

- **Clients:** one row per client org with members (confirmed, waiting, invited), the preset, items expiring soon, password health (weak, reused, exposed), and last activity. Expiring and health figures are computed in the browser, which can decrypt org items because MSP staff are members. The server only sees counts of members.
- **Add a client:** name it, pick a preset (Business by default). The org, its default collections, and its policies are created in one step, and every staff member is added.
- **Waiting for approval:** members added by the portal, RMM, or Entra are confirmed automatically by the console. Invite-link joins wait for one click.
- **Per client:** opens the org's admin console (members, groups, collections, policies), which upstream already provides as open source.
- **Across clients:** expiring credentials, default policies every client follows (see "Default policies"), item templates sent to every client or chosen ones (see "MSP templates"), and the RMM install script for each client.
- **Staff:** add by email, change role, remove.

### Roles and permissions

Two layers: what a client's own people can manage, and what each MSP technician can do.

**Per client: custom roles.** Upstream's member dialog already offers a "Custom" role with permissions, but Vaultwarden ignores them and treats Custom as the old Manager role. We store and enforce them, so a client's point of contact can manage their own people without being an admin.

- **Version 1 permissions:** manage members (invite, confirm, remove, revoke, restore, and edit regular members), account recovery (recover regular members), manage policies, view event logs, and import and export. Later: collections, groups, and reports.
- **Storage:** our own table, keyed by membership. Upstream's membership stays a regular member, so other clients just see a member.
- **Enforcement:** one map in the server from each admin endpoint (route template and method) to the permission it needs. The admin guard admits a custom member only to endpoints their permissions cover. Everything else still needs an owner or admin.
- **No escalation:** a custom member acts with an admin's rules but only on regular members. They can't grant roles or permissions, can't give access to all items, can't act on themselves, and can't touch admins, owners, or other custom members. Account recovery reaches only regular members.
- **Who assigns them:** owners and admins, including MSP staff. Not custom members.
- **Tests:** the permission matrix gains a custom member per permission, across every mapped endpoint, plus escalation tests for each limit above.

**Status:** built on the server and tested: storage, the endpoint map, the limits, and Custom showing in the apps with its permissions. The member dialog offers only the permissions we enforce. Custom roles with these permissions can't also manage all collections: the member dialog doesn't offer both, the server refuses them, and the apps never show a custom role as managing collections. Otherwise the web vault opens the admin console's Vault tab for them, whose endpoints no custom permission covers, and the refusals sign them out. Upstream's Custom with only "Manage all collections" is still a manager of every collection. The Members page works for custom members: whoever can open it (manage members or account recovery) can read the collection list it loads, and manage members and import and export can read the invite and edit dialogs' and the import page's collection list, which shows them only collections they're assigned to. Endpoints a custom member's role doesn't cover refuse them with 403 rather than 401, so clients can tell a missing permission from an expired session. **Known gap:** upstream's web vault signs out on 403 as well as 401, so any page the web vault shows a custom member must load only endpoints their role covers. The end-to-end test opens the organization, the Members page, and the invite dialog as a custom member, and fails on any refused request.

**Per MSP: technician access.**

- **Which clients:** each technician gets every client (today's behavior) or chosen ones. New clients reach only technicians with every client.
- **Role in those clients:** admin (today's behavior) or a custom role with chosen permissions, such as a helpdesk role that manages members and account recovery. Separately, whether they can see vault items (access to all collections).
- **Install commands:** whether they see the clients' RMM install commands, which let anyone who has one ask to join.
- **Changes apply everywhere at once,** like adding or removing a technician, and go in the audit log.
- MSP admins stay owners of every client.

**Status:** built and tested (`keykeeper_msp.rs`, migrations for SQLite and PostgreSQL, the console's Staff section). MSP admins choose a technician's access when adding them (an invitation carries it until they join) or edit it later; one server step brings all of their client memberships in line, adding them where they now reach (waiting for the org key, which the console gives), changing their role, and removing the MSP's memberships where they no longer reach. A client's own grants are left alone. A limited technician's console and audit log show only their clients, and the install command endpoint refuses technicians without it. Custom roles are the client roles above, so the same limits apply: they act only on regular members. Vault items give access to every item, which a technician sees and edits in their own vault; the apps don't show it as managing all collections, because the admin console's collection tools need permissions custom roles don't enforce yet and its refusals would sign them out. Not yet: per-client roles (one role for all the clients a technician reaches) and showing a client's own owners which of the MSP's people reach them with what role.

### Default policies

An MSP sets its policies once, and every client follows them. A client that needs something different gets its own setting for that one policy, and keeps the defaults for the rest.

- **The defaults** are one setting per policy (on with its options, or off), kept on the MSP. A new MSP starts with the Business preset's policies (see "Defaults (Business preset)"). MSPs created before defaults existed get the same, which matches what their Business clients already have.
- **New clients start with the defaults.** Add client applies them along with the Everyone and Admins collections.
- **Following or own setting.** A client follows a default while its setting for that policy matches it. A client whose setting differs has its own setting for that policy. Nothing else marks it: there's no flag to drift out of step with the real policy, and every way of changing a client's policy (its admin console, its own owners, a point of contact with the policies permission, MSP staff) works the same.
- **Changing a default** changes every client that follows it, in one step, and leaves clients with their own setting alone. The console says which clients changed and which kept their own setting.
- **Giving a client its own setting:** change the policy in that client's admin console, as today. **Back to the default:** "Use default" in the console, for one client or several at once.
- **Same rules as the admin console.** The server applies a default to a client through the same code as upstream's policy endpoint, with the same checks and side effects. Turning on two-step login revokes members without it, and single organization revokes members who belong to another organization, in every client that follows. The console warns before changing either. If a client refuses a change, the console names it, and that client shows as having its own setting.
- **Who:** MSP admins change defaults and use them in clients. Technicians see the defaults and which of their clients have their own settings. A client's owners see on their Policies page that the MSP sets defaults, and that changing a policy there makes it the organization's own.
- **Editing:** the console edits a default with upstream's own form for that policy, so options, wording, and checks match the admin console. Only policies the server supports are offered; account recovery only when the server sends email.
- **Audit log:** each default change, with how many clients changed and kept their own setting, and each client moved back to the default.
- **Tests:** API tests for following and own settings (a changed default reaches followers and skips others; changing a client's policy makes it its own; using the default brings it back), side effects through a default (two-step login revoking a member), the legacy MSP defaults, and the permission matrix. A console e2e test changes a default, sees which clients took it, and uses the default for a client with its own setting.
- **Status:** built (`keykeeper_msp_policies.rs`, a migration for SQLite and PostgreSQL, the console's Default policies section, and a note on each client's Policies page that names its own settings). The server compares what each policy does: an off policy's options don't count, and missing, empty, and null options are the same. A changed default goes only to clients whose policy matched the old default, so a client's own setting is never overwritten by accident. Not yet: choosing which clients a changed default reaches, and policies Vaultwarden doesn't support (such as requiring single sign-on).

### MSP templates

An MSP makes an item template once (a firewall, a Microsoft 365 tenant, a line-of-business app) and every client gets it, so technicians and the client's own people document things the same way everywhere. See "Item templates" for what a template is.

- **The source** is an ordinary custom template the MSP admin can see: in their own vault, or better in an organization all of the MSP's admins share, so any of them can change it. It's never one of the MSP's clients. The server records which item it is, never what's in it.
- **It applies automatically,** like a default policy: an MSP admin adds a template for every client (including clients added later) or for chosen ones, and that's all. Nobody sends anything.
- **How:** each client gets a copy, with the same template id, in its "Templates" collection, encrypted with that client's key. The server can't read templates, so it can't make copies; a browser holding the clients' keys must. Any MSP admin's web vault or browser extension does this in the background: when they unlock, whenever their items change (such as after editing a template), when the MSP console opens, and every five minutes in the extension. It creates the collection the first time. The server records each copy's item and which version of the source it was made from (the source's revision date), so any admin's vault can tell which clients are behind. It never sees a template's name or fields. If no MSP admin is signed in to either, changes wait until one is; later the desktop agent will do it too. Two devices writing a client's copy at the same moment leave a duplicate; the next run moves the one the server didn't record to the client's trash.
- **Updating:** edit the template (the console's Edit opens it). Clients get the change on their own. The console shows "Update" only if a client couldn't be updated, to try again; a failure isn't retried automatically, so it can't repeat forever. A copy is the MSP's: an update replaces whatever the client changed in it. A client that wants something different makes its own template, which is just a template in its organization.
- **Removing:** MSP admins can remove a template, and choose whether its copies stay in the clients or go.
- **Who sees copies:** everyone with access to the client's Templates collection: MSP admins and technicians who see vault items, and the client's owners and admins. The client's admins can give it to their members like any collection.
- **Templates from an MSP** show once, under "From <MSP>", in "New item from a template", even for MSP staff who see the same template in many clients.
- **Who:** MSP admins add and remove templates, and their vaults keep copies current. Technicians see which templates their clients get.
- **Audit log:** templates added, changed (which clients), applied to clients, and removed. Entries name the template only by id; the console shows the name to people who can see it.
- **Tests:** API tests for recording templates and copies (only the MSP's own clients, only items in that client, never a client's copy as a source), what a limited technician sees, and the permission matrix. A console e2e test creates a template, adds it for every client, sees a new client get it, edits it and sees every copy change with nothing else clicked, and finds it once under "From <MSP>" in the vault. An extension e2e test, with no vault tab open, edits a template in the popup and sees the client's copy change.
- **Status:** built (`keykeeper_msp_templates.rs`, a migration for SQLite and PostgreSQL, the console's Templates section, and `libs/admin-console/src/common/keykeeper/`: `msp-work.ts`, the background work the web vault and the extension share, and `msp-template-sender.ts`, which writes copies with upstream's own item and collection code). A copy's definition names the MSP, so "New item from a template" groups it under "From <MSP>" and the item view and editor say the MSP keeps it up to date. To change which clients get a template, add it again with the new choice. Not yet: a separate control for that, and giving a client's members the Templates collection automatically.

### Server

- New endpoints live under `/api/keykeeper/msp`, so they never collide with upstream routes. Every one checks the caller's MSP role and that the org belongs to that MSP.
- New tables: `msps`, `msp_staff`, `msp_clients`, plus an `msp_id` on memberships that came from an MSP.
- **Databases:** PostgreSQL in production and SQLite for self-hosting and tests. We drop MySQL and CockroachDB: fewer code paths, and our own migrations only need writing twice. CI runs the API tests on both.
- Creating MSPs is off by default on self-hosted servers (`MSP_SIGNUPS_ALLOWED`).

### Status

- **Built, server:** MSPs, staff roles, clients, staff kept in step with every client, the list of memberships waiting for a key, and a client's view and removal of its MSP (`src/api/core/keykeeper_msp.rs`, migrations for SQLite and PostgreSQL). MSP tables cascade, so upstream deletes of users, orgs, and members always work. A client's single-organization, two-step login, and other member policies don't apply to MSP staff. Upstream exempts owners and admins; the server exempts every membership that came from an MSP the same way, so a technician with a custom role, who is a regular member in each client, still works in every Business client. **Known gap:** the apps still apply a client's member policies, such as removing the individual vault, to a technician with a custom role, because they exempt only people who can manage policies.
- **Built, console:** "MSP console" in the web vault, shown to MSP staff: set up an MSP, clients with member counts and a link into each client's admin console, add a client with the Business defaults (its keys made in the browser with upstream's own code), each client's RMM install command, password health per client (expiring items, weak passwords, reused passwords; computed in the browser, so the server never sees it), and add, re-role, or remove staff. Opening it confirms everyone waiting whom the person can confirm, and MSP staff's web vault and browser extension also do it in the background (see "Enrollment").
- **Built, audit log:** every MSP action is recorded with who did it, from which address, and which client and person it touched: the MSP and clients created, staff added, invited, re-roled, and removed, install tokens replaced, people joining with an install command, members confirmed in a client, and a client removing its MSP. Names and emails are copied in, so entries stay readable after an account or organization is deleted. The console shows it as Activity, newest first, in plain sentences.
- **Built, invitations:** adding someone without an account invites them. The invitation's link is emailed when the server sends email, and shown to the admin either way. Accepting needs the link and an account with the invited address, so neither a leaked link nor someone registering that address is enough. Admins can cancel pending invitations.
- **Fixed:** upstream lets only owners confirm admins and owners, so a technician's console no longer tries to confirm other staff; it gets only the regular members it may confirm.
- **Built, client side:** a client's Members page says which MSP manages it and lists its staff; the client's own owners can remove the MSP there, which takes all of its staff out at once. MSP staff see the banner without the button, and the server refuses them anyway.
- **Built, tests:** behavior tests, the MSP and organization permission matrices, and a console e2e test where a technician gets into a client with no manual confirm. CI also runs `cargo fmt`, clippy, and the API tests on PostgreSQL.
- **Open question:** MSP admins are owners in every client, so today they can delete a client's whole organization, as any owner can. Deleting a client might instead need the client's own owner, or a waiting period. Decide before launch.
- **Built, default policies:** see "Default policies".
- **Built, templates:** see "MSP templates".
- **Not built yet:** exposed (breached) passwords in the health columns, which needs a lookup per password; key fingerprints; showing the MSP's actions to the client's own owners; choosing between several MSPs; MSP signup on our hosted service.

### Tests

- **API tests (tier 1):** a black-box suite that drives the real server binary over HTTP, with a fresh database per run. It's the backend's safety net, for upstream's endpoints and ours.
- **Permission matrix:** every MSP endpoint and the org endpoints it relies on, times every caller: MSP admin, technician, another MSP's staff, the client org's owner and members, a stranger, and no login. Each cell is an expected status code, and the table is the test.
- **Console e2e:** add a client, add a technician, see the member confirmed automatically, open the client's admin console, remove the MSP from the client's side.
- **Mail tests:** a second test server sends email to a local mail catcher (`e2e/mail-server.mjs`), so tests follow real emailed invites and cover features the server only offers with email, such as account recovery.

## Onboarding

A domain is never required. Each org picks a preset: Solo, Family, or Business.

- **Solo:** install, create an account, automatic import from local browsers, extension added to the default browser profile. Done.
- **Family or small team:** the owner creates an org and shares an invite link or QR code. Members join with any email address. The owner sets approval to automatic or one tap.
- **Business:** the admin adds emails (any domain), runs the RMM script, or connects Entra (optional). Users added any of these ways are pre-approved. The org-key confirmation runs silently on any admin device that is online.

The target is a working vault, with imported passwords, after zero decisions beyond the org name. Tier 2 tests this for every preset.

### Onboarding through the RMM (Business, version 1)

No desktop agent needed: browsers already let policy hand an extension its settings, and our installer already writes browser policy.

1. **The MSP copies one command.** In the MSP console, each client has an install command: our install script with the server address and that client's enrollment token. The MSP runs it from their RMM on the client's machines.
2. **The script configures the browsers.** It force-installs the extension where targeted, turns off the browser's password manager, and gives the extension two managed settings: the server address (upstream already reads this) and the enrollment token.
3. **The person signs up or signs in in the extension.** The server is already filled in. After unlock, the extension sees the token and joins the client: it asks the server which organization the token belongs to, encrypts the person's user key to that organization's public key for account recovery (upstream's own enrollment code, as an emailed invite does), and sends the join. A one-time notice names the organization and says its admins can recover the account.
4. **MSP staff's apps confirm them** in the background, like any member waiting for the org key: the web vault or browser extension of anyone on the MSP's staff who can confirm in that client, while unlocked. The extension checks every five minutes, and the console confirms on opening. Later, the desktop agent on an MSP admin's machine does it too.

**The enrollment token** is per client, random (256 bits), and shown to the MSP's staff in the console. It lets an account ask to join that client as a regular member; it never grants the org key. Joins through it are auto-approved, per the Business defaults, so the token is a credential: the console can replace it (old installs then stop working for new joins), and each join is recorded with when it happened. The server keeps it like upstream keeps organization API keys. An account in another organization can't join (single organization). Later: limiting joins to the client's email domains, and emailing the client's owners about each join.

**Status:** built. The server issues a token with each new client and joins through upstream's invite acceptance; the MSP console shows each client's install command with a copy button, the number of people who joined with it, and (for MSP admins) a way to replace the token; the install script writes the extension's managed settings; the extension joins after unlock and says so once. An end-to-end test runs the whole path with real keys on the mail test server: someone joins from the extension, the console confirms them, an MSP admin recovers their account, and they sign in with the new password to an intact vault. Not yet: limiting joins to a client's email domains, emailing the client's owners about joins, and the install script's download URL with a pinned signature (the console shows the command for a local copy of the script).

**Tests:** API tests for the token endpoints and their permission matrix, joining (with and without account recovery, already a member, single organization, a replaced token), and that a join never includes the org key. The extension's join logic gets unit tests with managed settings stubbed. Tier 2 runs the real install script on Windows and checks the policy values the browsers will read.

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
| Single organization | On. A work account belongs to one organization; personal items go in a separate personal account. Account recovery opens a member's whole account, so this keeps a client's admins out of members' family organizations. Owners and admins, including MSP staff, are exempt. |
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

**Status:**

- **Built:** an MSP's "Add client" applies the MSP's default policies (see "Default policies"), in one server call so a closed browser tab can't leave a client half set up. A new MSP's defaults are the Business preset: account recovery with automatic enrollment, single organization, and master password requirements (12 characters and a strength score of 3 out of 4; existing passwords aren't forced to change). Add client also creates the "Everyone" and "Admins" collections. All of these are upstream policies and collections, which the client's owners can change in its admin console.
- **Account recovery needs email.** The server only offers it when it can send email, since a member must be told when an admin resets their password. Our hosted service sends email. Self-hosters without SMTP don't get account recovery. The tests need a local mail catcher to cover it end to end, which also lets them test emailed invites; that comes with the enrollment work below.
- **MSP staff are never part of a client's account recovery (built).** Recovery lets a client's admins reset a member's master password and take over the whole account, and an MSP staff member's account can see every other client. So the server refuses account recovery enrollment, and recovery itself, for memberships that came from an MSP. Without this, a technician could enroll with upstream's own "join account recovery" option. A mail test proves the refusal and that a regular member invited by email is still enrolled.
- **Single organization is part of the Business preset (decided 2026-10-15).** Account recovery opens a member's whole account, including any other organization they belong to, so Business clients keep work accounts to one organization, as Bitwarden requires. MSP staff are exempt, as upstream exempts owners and admins; tests check that staff, including a technician with a custom role, reach every Business client while a member of one can't be confirmed into another, and that turning on two-step login or single organization in a client leaves staff alone.
- **Enrolling members who didn't use an emailed invite:** members who join through the RMM enrollment link enroll at join, like an emailed invite (see "Onboarding through the RMM"). What remains is enrolling members of organizations that turn the policy on later; that waits until someone needs it. Upstream enrolls a member in account recovery only when they accept an emailed invite. Members added any other way (the MSP console, the RMM script, members added before the policy was on) would never be enrolled. Our clients will close that gap: on unlock, for each organization whose account recovery policy has automatic enrollment and where the member isn't enrolled, the client enrolls them with upstream's own enrollment code, which encrypts the member's user key to the organization's public key exactly as the invite flow does. The member sees a one-time notice naming the organization. The trust is the same as upstream's invite flow: the client takes the organization's public key from the server. Tests: a member added through the MSP console unlocks and is enrolled; an owner then sees them as enrolled; a member of an organization without automatic enrollment is never enrolled.
- **Not possible with upstream policies, so not done yet:** two-step login required for admins only (upstream's policy exempts owners and admins, the opposite), and locking the vault when the computer locks (a per-device setting the desktop agent will set). Keeping private items with the organization needs upstream's newer data ownership policy, which Vaultwarden doesn't support yet.
- **Not built:** new members getting the "Everyone" collection automatically, the Solo and Family presets, and presets for organizations created without an MSP.


Every setting explains itself in one sentence. Changing a setting needs no action from users.

## Browser import

- Runs automatically after first sign-in.
- Sources: Chrome, Edge, Brave, Opera, and Vivaldi through the upstream GPL importer (`apps/desktop/desktop_native/chromium_importer`). Firefox is ours to write.
- Dedupe: identical URL, username, and password merge into one item. Same URL and username with different passwords: the most recently changed wins and the others go to the review queue.
- Skip "never save" entries and entries with empty passwords.
- Ends with a summary and a review queue that users clear whenever they like.

## UX we commit to

Fixes for things that annoy users of Bitwarden and 1Password today.

- **One unlock:** unlocking the desktop agent unlocks the browser extension, and the other way around, over the existing authenticated native-messaging channel. Locking either one locks both.
- **Biometrics by default:** Touch ID on Mac and Windows Hello on Windows are offered at first unlock, with no separate "browser integration" setup. Admins control biometrics and password requirements in the portal.
- **Survives profile migrations:** tools like ForensiT Profile Wizard change the Windows user's SID, so locally protected data (DPAPI, Windows Hello keys) stops decrypting. Upstream's extension then works once and needs a reinstall. Ours detects local state it can't decrypt, clears it, and asks the user to sign in again. Never a broken extension.
- **Custom fields are one tap away** in every item editor (web, extension, desktop, mobile), not buried in a menu.
- **Context-aware new items:** creating an item while viewing a folder or collection puts it there.
- **Onboarding day works:** upstream rate-limits logins per IP (a burst of 10, then one per minute) and signup, pre-login, and hint requests per IP (a shared burst of 50, then one per minute). A whole office behind one NAT address would get stuck after ten to twenty-five people. Rate limits become per account, with allowances for an org's known addresses and enrolled devices. Tier 2 onboards 50 users from one IP.
- **No nags:** upstream's web vault interrupts every fresh login with an extension page, an "Are you sure?" dialog, and a welcome tour. All three go. Extension setup happens through onboarding instead.

## Item templates

Like 1Password's item types (API key, server, Wi-Fi, software license, passport, and so on), plus custom templates that people, families, and MSPs define.

- **Built-in templates** beyond upstream's types (login, card, identity, secure note, SSH key, bank account, passport, driver's license): API key, server, database, Wi-Fi network, router, software license, domain, certificate, email account, membership, and later crypto wallet. Each is an upstream base type (login or secure note) with predefined, typed fields.
- **Typed fields:** text, hidden, date, URL, email, phone, number, yes/no, one-time code. Upstream only knows text, hidden, yes/no, and linked, so values are stored as ordinary custom fields and the template supplies each field's type, which drives the editor (date picker, URL check) and display.
- **Storage, with no server changes:** an item records its template in a text field `keykeeper.template` (template id, name, and version), so its template shows even to people who can't see the template itself. A custom template is itself an item: a secure note with a text field `keykeeper.template-definition` (an id, whether new items are logins or notes, and a version). The note's name is the template's name, and its custom fields are the template's fields, with any values as defaults. So people create, edit, share, and delete templates with the ordinary item editor, and everything stays end-to-end encrypted and syncs like any item. Other clients show a template as a plain note.
- **Where custom templates live:** personal templates in the personal vault. Family and business templates in an organization collection, which reaches everyone who can see that collection. An MSP pushes a template to many client orgs at once from the MSP console, which writes the same template item, same id, into each client's templates collection.
- **Creating items:** "New item from a template" lists each organization's templates, then the person's own, then built-in. An item from an organization's template still goes where the person is adding it (the open folder, organization, or collection), never into that organization by default, so a personal item can't land in a shared collection by surprise.
- **Built:** ten built-in templates (API key, server, database, Wi-Fi network, router, software license, domain, certificate, email account, membership); upstream already has passport, driver's license, and bank account types. Custom templates for logins or notes, made from "Create template" in the same picker, with defaults, a hint in the editor, a description in the item view, and a "Template" badge in lists. "From template" in the web vault's New menu and the browser extension's (`libs/common/src/vault/keykeeper/templates.ts`, `template-chooser.component.ts`). New items keep hidden fields editable (upstream locked them when there was no original item). Tier 1 covers built-in and custom templates in the web vault and the extension.
- **MSP push to many orgs:** built; see "MSP templates".
- **Not built yet:** giving every org member access to the templates collection automatically; "Save as template" from an existing item; typed fields beyond text, hidden, and yes/no (date, URL, email, phone, number, one-time code) and a date field that sets the expiration; hiding templates from "All items"; "From template" in a desktop vault window, if we build one; and an organization template test (needs org creation in the test rig).

## Expiration dates

Any item can expire: API keys, certificates, licenses, domains, passports, cards.

- **Set it anywhere:** an "Expires" date on every item, plus template date fields marked "is the expiration date" (an API key's expiry, a passport's). Cards use their existing expiry month and year automatically.
- **Stored with the item:** a text field `keykeeper.expires` (ISO date), encrypted and synced, no server changes. A text field, not hidden: a date isn't secret, and list views only carry text fields' values, so lists can show badges without decrypting every item.
- **Built:** the "Expires" date in the item editor (web, extension, desktop share it), an Expiration section in the item view, badges in the web vault list and the extension's item list for items expired or expiring within 30 days, and card expiry in the item view. All of PassBundle's own fields stay hidden in views and editors and survive edits (`libs/vault/src/keykeeper/`). An "Expiring items" report on the web vault's Reports page lists everything expired or expiring within 30 days, cards included, expired first, then soonest. The extension checks every six hours while unlocked and shows a system notification at 30, 7, and 1 day before and once expired, never twice for the same step; a new date starts over (`apps/browser/src/keykeeper/expiration-reminders.ts`). Tier 1 covers each.
- **Not built yet:** card expiry badges in lists (list views don't carry card expiry), the "Expiring soon" filter, Health integration, per-item reminder days, desktop agent reminders, and the MSP view.
- **See it:** "Expires in 12 days" and "Expired" badges in every list, an "Expiring soon" filter, and expiring items in Health.
- **Reminders, on the device:** the extension (built) and desktop agent check while unlocked and notify at 30, 7, and 1 day before, and once expired. Steps adjustable per item later. Nothing leaves the device.
- **Reminders by email (open):** the server can't read items, so emailed reminders would mean storing an unencrypted reminder date with an opaque item id ("an item in your vault expires on Oct 30", no name). Opt-in per user or org, or skip it.
- **MSP view:** expiring credentials across all clients in one list, from the MSP's own client, which can decrypt org items.

## Importing from other password managers

Upstream gives us about 70 importers. They include 1Password, LastPass (with direct import), Dashlane, Keeper, Proton Pass, Enpass, KeePass, and the browsers. Our job is making them painless.

- **Detect and guide:** the desktop agent detects installed password managers and walks the user through that product's export with exact steps. Then it imports and securely deletes the export file.
- **Direct import** where the source allows it, as upstream already does for LastPass.
- **Business:** the admin bulk-imports shared vaults into collections, mapping source folders and shared folders. Each member's private items go through the same guided import during their onboarding.
- **Bitwarden (built and tested):** its JSON export imports with every item, folder, TOTP secret, custom field, note, and password history intact. A password-protected export moves to another account with no plaintext in the file. Both are tier 1 tests. Our own exports use the same format, so the importer's "Bitwarden (json)" label should become "PassBundle or Bitwarden (json)".
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
- Our job: make sure the server stores and syncs passkey items correctly (verify against Vaultwarden), then cover registration and sign-in in tiers 1 and 2.

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
- **Storage (built):** a rule is a hidden custom field named `keykeeper.fill` whose value is a small JSON document (`apps/browser/src/autofill/keykeeper/fill-rules.ts`). It's encrypted and synced like any field, and the server and other clients need no changes.
- **Built so far:** the right-click picker (`fill-field-menu.ts`). Value rules fill first, before upstream's matching. Never-fill fields are hidden from upstream's field selection, so a value meant elsewhere moves to the next fitting field. Unit tests cover the rules and the menu. Tier 1 covers a custom field into a differently named field, and never-fill.
- **Next:** show rules in plain language in the item editor and hide the raw `keykeeper.fill` fields there (they currently show as hidden custom fields), one-tap label-match suggestions, site-wide never-fill, translated menu strings, and the same picker inside the inline menu.

### One-time codes never become passwords

This is a hard invariant, enforced by tier 1 tests.

- Fields classified as one-time code inputs are never treated as password fields. Signals: `autocomplete="one-time-code"`, OTP, 2FA, MFA, or verification hints, and short numeric inputs that follow a login step.
- The save or update prompt never offers a value that equals the item's current TOTP code. It also never offers a value that looks like a code (4 to 8 digits) when the saved password is not itself all digits.
- Every password update keeps the old value in password history, and the notification has an Undo.
- The corpus includes many one-time-code page variants. Any save prompt on them fails the build.
- **Found in upstream:** the background keeps a sign-in's submitted form data for five seconds and fills a later username-less submission's gaps from it. A code pasted on the second step within that window becomes "alice-example changed her password to 123456". Fixed: a username-less submission whose only secret is 4 to 8 digits is never stored or merged. A username with a numeric PIN still saves.
- **Next:** field-based detection in the content script, for passwordless sign-ins that show an email field next to the code field (the value check above can't tell those from a PIN login).
- **Tier 1 coverage:** tagged, masked (`type="password"`), and bare code fields, each on its own page and as the second step of a sign-in submitted inside the five-second window, after a calibration that proves the prompt still works for a real password change. Unit tests cover the guard and fail without it.

### Missed save prompts on fast sites (upstream race)

After a sign-in form is submitted, upstream asks the page for the typed values over an async message while the request is in flight. When the site answers instantly (a fast intranet app, or a local server), the request completes first and the save or update prompt is silently dropped. Fix: capture the form values synchronously at submit time in the content script, and keep them until the response arrives. Until then, the test fixture server answers sign-ins after 300 ms, like a real site.

## Script access (our Secrets Manager, later)

Bitwarden's Secrets Manager is a separate DevOps product under its source-available license, so we can't use it. Ours starts from what MSPs need: RMM scripts that use credentials (domain admin, client API keys) without pasting them into the RMM in plain text.

- **Scoped tokens:** a token can read only the items or collection it was granted. It can't list or browse the vault.
- **Made for scripts:** `keykeeper get` in the CLI and a PowerShell module, so an RMM script fetches exactly one value at run time.
- **Device-bound and short-lived:** tokens can be tied to an enrolled machine, expire, and are revoked instantly.
- **End-to-end encrypted:** a token carries a key that decrypts only its granted items. The server still can't read anything.
- **Audited:** every read is logged with token, item, and machine. Unusual access raises an alert in the MSP console.
- **Later:** rotation helpers that change a credential and update the item together, plus CI integrations if developers ask.
- **Clean room:** designed from public documentation only. Never read Bitwarden's Secrets Manager code or SDK.

## Browser extension management (later)

- Version 1: an inventory of other installed extensions and their permissions, plus alerts for newly added extensions with broad permissions.
- Later: allow and block lists through policy.
- Never force-install third-party extensions.

## Testing

| Tier | When | Contents |
|---|---|---|
| 1 | Every commit, minutes, fully repeatable | Unit tests. Encryption test vectors. Server API tests. A permission matrix (every endpoint times every role, plus another org's member and an unauthenticated caller). Import dedupe on fixed fixtures. Stand-in OIDC, Graph, and SCIM servers. The autofill corpus in Chromium and Edge. |
| 2 | Nightly, slow, still repeatable | A fresh Windows VM with pinned browser versions: RMM-style install as admin, policies verified, browser profiles seeded with known saved passwords, onboarding driven through the desktop agent, import counts verified, the extension present only in targeted profiles, the password manager off where targeted, the user auto-approved. Also: upgrade from N to N+1, and database migrations on SQLite and Postgres. |
| 3 | Nightly canary, not repeatable by design | Latest Chrome, Edge, and Firefox. A real Entra dev tenant. A weekly test merge of upstream `bitwarden/clients` and Vaultwarden. Red here means the world changed, not that we broke something. |

Determinism rules:

- Inject the clock.
- Test encryption by round trip and known vectors, never by comparing ciphertext.
- No live network in tiers 1 and 2.
- Each test gets a fresh database.
- Wait on state, never on sleeps.

The maintainer gets a morning summary, with screenshots and video only for failures.

**Changes that span repos** use the same branch name in each repo. Tier 1 tests a pull request together with the same-named branches of the other repos, so linked pull requests pass before any of them merges, and none of them goes red only because another hasn't merged yet. Branches are deleted when their pull request merges, so a stale one is never picked up.

## Known gaps

- Help, Terms of Service, and Privacy Policy links go to pages on passbundle.com that don't exist until we publish the site.
- The apps' default server is `vault.passbundle.com` (one host, the way our server is deployed), which serves nothing until the hosted service exists. Self-hosted servers are unaffected.
- The installer's extension IDs are placeholders until the store listings exist.
- passbundle.com still points at Namecheap, and the site is on a temporary Cloudflare account (https://passbundle.pages.dev). Next: move it to PassBundle's own Cloudflare account, point passbundle.com, .io, and .app at it, and set up hello@, privacy@, and security@ (steps in `site/README.md`).

## Milestones

1. Fork and rebrand the clients and the server. Tier 1 CI. A tier 2 Windows job that does an RMM-style install and verifies the policies.
2. Spike: seed real browser profiles with known saved passwords, including Chrome app-bound encryption. Tier 2 depends on it.
3. Onboarding wizard, autonomous import, presets, and defaults.
4. Autofill corpus and scoreboard.
5. Admin and MSP console, written clean-room (see CLEAN_ROOM.md). Moved ahead of 2 to 4: it's where most of the effort goes. Backend API tests come first.
6. Mobile apps with our own push delivery.
7. Script access (our Secrets Manager).
