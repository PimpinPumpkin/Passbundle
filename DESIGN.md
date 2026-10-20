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
- **Status:** the foundation is built (`apps/agent`, version 0.1): the tray icon and menu (the version, Open web vault, Quit), one agent per signed-in user, settings by policy (web vault URL, self-updates off), and the signed self-updater. Tier 1 runs its tests on Windows and macOS, checks the release build is under 10 MB (0.9 MB on macOS), and runs it in the tray. Idle, it uses 8.5 MB of memory on macOS. Not yet: the update key (made offline; until then builds don't update themselves) and installing it from the RMM script (waits on code signing). Biometric unlock is built (see "Biometric unlock"). The agent won't do the MSP background work (see "MSP templates").

### Biometric unlock (Windows Hello and Touch ID)

Unlock the browser extension with Windows Hello or Touch ID, through the desktop agent. The agent has no login and no vault, so it can only hand back a key the extension gave it.

**Status:** built for Windows, not yet tried on a real Windows Hello device. The agent's channel and protocol (`apps/agent/src/channel.rs`, `protocol.rs`), its socket and native-messaging host (`ipc.rs`, `host.rs`), Windows Hello (`windows_hello.rs`, `sealed.rs`), and the extension's side (`apps/browser/src/keykeeper/agent-biometrics.ts`). Tier 1 runs it all with a stand-in for Windows Hello, on Windows, macOS, and Linux. Next: one check on real Windows Hello hardware, then the installer registering the host (it waits on code signing). macOS waits on signing too.

- **The protocol is upstream's native-messaging one**, the one the extension already speaks with upstream's desktop app, and all of it is GPL TypeScript we can read:
  - The browser starts our native-messaging host, a pipe to the agent: 4-byte native-endian length, then JSON, 1 MB at most. The host sends `{"command":"connected"}` once it reaches the agent and `{"command":"disconnected"}` when the agent goes away.
  - **Key exchange:** the extension sends `setupEncryption` with a new RSA-2048 public key (SPKI) and the active user's id. The agent makes a 64-byte session key (AES-256-CBC key and HMAC-SHA256 key) and returns it encrypted with RSA-OAEP (SHA-1, as upstream). Unlike upstream's desktop app, it sets up a channel for any user, since enrolling needs one and nothing comes back without a prompt; upstream answers `wrongUserId` for an account it doesn't have. A message under a session the agent doesn't have, or with a bad MAC, gets `invalidateEncryption`, and the extension starts over.
  - **Messages** are then type-2 EncStrings (AES-256-CBC with HMAC-SHA256) under the session key, carrying `command`, `messageId`, `userId`, and `timestamp`. Both sides drop a message more than 10 seconds from their clock, and replies carry the request's `messageId`. The extension waits 60 seconds for a reply, so a prompt must finish in that time, and the agent stamps a reply when it sends it, after the prompt.
  - **Commands the agent answers:** `getBiometricsStatus`, `getBiometricsStatusForUser`, `unlockWithBiometricsForUser` (prompts, then returns the user key), and `authenticateWithBiometrics`. Unknown commands get no reply, as upstream.
- **Not upstream's "shared unlock".** That newer feature runs over the SDK's own IPC protocol, whose messages, encryption, and peer checks live inside the SDK, which we can neither read nor link. It's off unless the server sends two feature flags, and ours can't: they aren't on its list of flags it will send (`SUPPORTED_FEATURE_FLAGS`).
- **One command of our own, `keykeeper.biometric.enroll`.** Upstream's desktop app has its own login and holds the user key; ours doesn't. So when someone turns on "Unlock with biometrics" in the extension while unlocked, the extension sends the agent the active user's id and user key over the encrypted channel. The agent asks for Windows Hello or Touch ID ("Turn on unlock with Windows Hello for <email> in <browser>?"), and stores the key only if the person confirms. `keykeeper.biometric.remove` deletes it, sent when the setting is turned off and at logout. The agent also deletes a user's key when it can't be opened any more (Windows Hello was set up again, or the stored key is damaged), so a stale key can't keep failing; a prompt that fails for now (a locked or busy device) keeps it.
- **Where the agent keeps the key:**
  - **Windows:** like upstream's GPL implementation, without its SDK crates. Each enrollment gets a random 32-byte challenge. Windows Hello signs it with a key credential only after the person authenticates, and the signature (RSA PKCS#1 v1.5, so the same every time) is hashed with HKDF-SHA256 into a key that seals the user key with AES-256-GCM. The challenge and the sealed key are stored in the user's app data, wrapped with DPAPI. Windows Hello opens its prompt behind the browser when the program asking isn't in front, so the native-messaging host, which the browser started and so may, lets the agent bring it forward (`AllowSetForegroundWindow`).
  - **macOS:** a keychain item that only Touch ID (the current set of fingerprints) can open, in the data protection keychain. That needs the agent signed with our Apple developer ID and a keychain entitlement, so on macOS biometric unlock waits for signing. We won't ship the weaker "ask for Touch ID, then read a normal keychain item" fallback upstream uses.
- **What it protects against, and what it doesn't:**
  - Nothing leaves the computer, and the server isn't involved.
  - The key exchange isn't authenticated: any program running as the person can connect, as with upstream's desktop app. It still can't get a key without the person passing Windows Hello or Touch ID. One prompt at a time, and none for 10 seconds after a cancel, so a program can't nag the person into approving. Windows shows its own text in a key credential's prompt, so on Windows the prompt can't name the browser or the account.
  - The agent's socket is the signed-in user's alone: a Unix socket in their own folder (0700) on macOS, and on Windows a named pipe whose access list allows only them and SYSTEM, created as the first instance of its name so no other program can claim it while the agent runs.
  - **The host checks who it reached.** When the agent isn't running (its tray's Quit), a program running as the person could make the pipe or socket first and be handed the user key at the next enrollment. So before it forwards anything, the host asks the operating system which program is at the other end (on Windows, the pipe's server process and its image path; on macOS and Linux, the socket peer's executable) and goes on only if it's the `passbundle-agent` installed next to the host. Later, with signed builds: checking the code signature as well.
  - **Copies of the user key** in the agent's decrypted messages and replies are overwritten before they're dropped (`zeroize`), besides the stored and returned keys themselves.
  - **Known gap:** any program running as the person can still ask the agent to forget a user's key or whether one is enrolled, which costs them the setting, not the key.
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
  - Real Windows Hello and Touch ID prompts can't run in CI. Each release gets one check on real hardware, with the Windows Hello test kit (`.github/workflows/test-kit.yml`, `installer/windows/test-kit/`): one zip with a Windows build of the server, the web vault, the agent, and an extension with a fixed ID, and `Try-WindowsHello.ps1`, which runs the server on localhost, installs the agent for the person, registers it for the kit's extension, and points that extension at the server by policy. CI tries the kit on a fresh Windows machine: the extension gets the server from policy and reaches the agent, which reports no Windows Hello there; `-Remove` leaves nothing behind.

### Installer and agent (Windows first)

- A signed MSI plus a bootstrap script per client org, copied from the admin portal with the org's enrollment token included.
- The MSP runs the script from its RMM. The script downloads the current MSI from a fixed URL, checks the Authenticode signer against a fingerprint written into the script, and installs silently.
- The install runs once with admin rights. It installs the desktop agent, writes browser policies, installs the import helper, and enrolls the machine to the org.
- **No resident service that accepts remote commands.** A hacked server must not become remote code execution on every client machine.
- Our extension IDs are compiled into the installer. It can force-install only our extension, never one named by the server.
- To change targeting, the MSP reruns the script, which applies the org's current settings.
- **Status:** `installer/windows/Install-PassBundle.ps1` applies the browser policies and, with the agent's two programs in an `agent` folder next to it, installs the desktop agent: to Program Files, started at every sign-in (the machine's Run key), registered for Chrome and Edge as our native-messaging host for our extension IDs only, with the server address in its policy, and a SYSTEM task that runs its signed updater daily and at startup (`-DisableAgentUpdates` for MSPs who update through their RMM). `-Remove` undoes all of it. Tier 2 builds the agent on a Windows machine, installs as an RMM would, checks every piece, and has the installed host reach the running agent. Not yet: the signed MSI and the download with a pinned signer (waits on code signing), the import helper, Firefox, and updating the host program along with the agent (the updater replaces only the agent).

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
- **Never more than they have (security review, October 2026):** a custom member gives others only collections they reach themselves (every one, if they have access to all items), never with more access than their own, and never the right to manage a collection. They don't add people to groups or change anyone's groups, and editing someone leaves that person's other collections alone. Otherwise a role that manages members could give a second account of its own every item, and "no vault items" would mean nothing.
- **Export needs access to all items:** the export holds every item in the organization, so it refuses a custom role without access to all items. A client's own custom roles can't have that yet, so for them import and export covers import. A technician given import and export must also be given vault items.
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

### Joining

Someone invited to an organization gets in without anyone clicking Confirm: no "the person you invited signed up, now go approve them" step, which 1Password and Bitwarden both have.

- **Why there's a step at all:** joining means giving the person the organization's key, encrypted to their public key, and the server never holds that key. So a device that has it must do the handoff. Upstream makes a person click Confirm for it; we do it in the background.
- **Who does it:** the web vault or browser extension of any owner or admin of the organization (for an MSP's clients, anyone on the MSP's staff who can confirm there), while it's unlocked: when it unlocks, when its items change, and every five minutes. Usually within a few minutes; if every owner's and admin's apps are closed, the person waits until one opens. Upstream's rule stands: admins confirm regular members, owners anyone.
- **Settings, per organization** (its Settings page, owners and admins): let people in automatically (on by default) or have an owner or admin approve each one on the Members page, and how long invitations last (2 hours, 1 day, or 5 days; the server allows 1 hour to 30 days). The invitation email says how long it works, and the link stops working after that.
- **MSPs** set a default for their clients in the console; a client with its own setting keeps it, and an MSP admin can put it back on the default. Changes go in the MSP's activity log.
- **Outside an MSP** the default is the server's: automatically, and `INVITATION_EXPIRATION_HOURS` (5 days).
- **Who hears about it:** with nobody clicking Confirm, an email is how anyone notices a join. Whoever sent the invitation gets "<email> joined <org>", which says nobody needs to confirm them and links to the Members page to remove someone unexpected. Where an admin approves joiners, it's upstream's "accepted your invitation, confirm them" instead. A join with the install command goes to the client's own owners (see "Onboarding through the RMM").
- **The trust this assumes:** the server says which public key belongs to the person who accepted, so apps confirm on their own only when something the server can't forge vouches for them (see "Joins a hacked server can't forge"). Organizations that want a person to compare fingerprints can require approval.
- **Tests:** API tests for the settings, how they resolve (own, MSP default, server), the list of who's waiting, and permission matrices; mail tests that invitations last as long as the setting and say so, and that the inviter's email matches the setting; an end-to-end test where someone invited gets in with no click while another organization's invitee waits for approval.
- **Status:** built (`keykeeper_joining.rs` and its migration on the server; the background work in `libs/admin-console/src/common/keykeeper/msp-work.ts`, which the web vault and the extension share; the Settings page card and the console section).

### Joins a hacked server can't forge

Letting someone in means encrypting the organization's key to their public key. The server never holds the organization's key, but it does say who is waiting and with which public key, and it serves the organization's public key to the extension that escrows a user key for account recovery. So a hacked server could ask the apps that confirm in the background to encrypt the organization's key to a key of its own, or hand the extension its own key in place of the organization's. These rules close that for the install command, and narrow it for email invitations to the one thing only a person comparing fingerprints can catch. Decided October 2026; the protocol is versioned (v1), and the test vectors are in `docs/vectors/joins-v1.json`.

**The join key.** Each organization has a join key that only holders of its organization key can compute, and the server can't: `joinKey = HKDF-SHA256(ikm = the organization's 64-byte symmetric key, salt = empty, info = "passbundle join key v1", 32 bytes)`.

**The install command carries a secret the server never sees.**
- When an owner or admin makes or replaces the command, their browser makes a 32-byte join secret and the server stores it only encrypted with the organization's key (an `EncString`, so owners, admins, and MSP staff who confirm there can read it, and the server can't). The command shows it next to the token: `-EnrollmentToken '<token>' -JoinSecret '<secret>' -OrgKey '<fingerprint>'`, each 43 base64url characters, checked and single-quoted like the rest.
- `<fingerprint>` is the SHA-256 of the organization's public key (SPKI, DER). The browser derives the public key from the organization's private key, which it decrypts with the organization key (owners and admins fetch it encrypted from `GET /keykeeper/organizations/<id>/private-key`), never from the public key the server reports.
- The install script writes all three to the extension's managed settings. The extension never sends the secret or the fingerprint anywhere.
- **Joining:** the extension refuses an organization whose public key (from the server) doesn't hash to the fingerprint, so a swapped key never gets a user key for account recovery. It sends, with the token, a proof: `HMAC-SHA256(secret, "passbundle join v1" ‖ 0x00 ‖ organization id ‖ 0x00 ‖ user id ‖ 0x00 ‖ SHA-256(the person's public key))`, where the public key is the one derived from the person's own private key on that device. The server stores the proof with the join.
- **Confirming:** an app confirms a token join on its own only when the proof checks out against the public key it's about to encrypt to (constant-time compare), and the command is limited to email domains (see "No click only with domains"). Otherwise the join waits for an owner or admin's Confirm on the Members page, with the fingerprint. A hacked server can't make a proof for a key of its own without the secret.

**Email invitations carry a seal.**
- When an owner or admin invites someone from upstream's member dialog, their browser seals the invitation: `HMAC-SHA256(joinKey, "passbundle invite v1" ‖ 0x00 ‖ organization id ‖ 0x00 ‖ lowercased email)`. The server keeps it by organization and email (`join_seals`), and an invitation sent without one removes any earlier one.
- An app confirms an invited member on its own only with a seal that checks out for that email. A membership the server made up for an address nobody invited waits for approval.
- **What it doesn't catch:** the server could still present a key of its own as someone an admin really invited (or as an invited address) at the moment they join. Only a person comparing fingerprints catches that, which is what requiring approval is for. The seal narrows the risk from "anyone, any time" to "the addresses an admin invited", and the limits and notice below make it loud.
- **MSP staff:** an MSP admin's browser seals each staff member's place in each client it reaches (`"passbundle staff v1"`, with that client's join key) when it adds them, widens their access, makes them an admin, or makes a client (for the staff the console lists as reaching every client). The server removes a staff member's seals when they leave or stop reaching a client. Staff without a seal wait for approval, as do invited people with only an invitation seal.

**The settings carry a seal too.** Whether an organization lets people in without approval, and its email domains, are sealed with its join key by the browser that saves them: `HMAC-SHA256(joinKey, "passbundle joining v1" ‖ 0x00 ‖ organization id ‖ 0x00 ‖ "1" or "0" ‖ 0x00 ‖ the domains, sorted and joined with ",")`. An app treats a setting without a valid seal as "an admin approves each one", so the server can't turn approval off. An MSP's default is sealed per client by the MSP admin's browser that saves it. Saving the setting keeps the domains only if the old seal vouches for them, and saving domains keeps "let people in" only if the old seal vouches for it, so a change the server slipped in is never resealed.

**Limits and notice.**
- An app confirms at most 20 people per organization per day on its own; past that, the rest wait for an admin's Confirm, and the app says so.
- Each confirm on its own shows a notice on that device naming the person and the organization ("Let ana@acmedental.com into Acme Dental"), so an unexpected one is seen where it happened, besides the owners' email.

**Organizations made before this** have no join secret, seals, or settings seal, so their joins wait for approval until an owner or admin saves how people join, and their invitations until they're sent again. The first time an owner, admin, or MSP admin opens an install command without a join secret, their browser adds one (the token stays); commands already run without one still let people ask to join, and an admin approves them.

**What the server still decides:** who is on an MSP's staff when a client is made, what an organization's members see, and everything else it decides today. It can't decrypt anything, and with these rules it can't get an organization's key from an app on its own, except by posing as an invited address or a staff member's email at the moment they join.

**Tests:** unit tests for each computation against the vectors (`libs/admin-console/src/common/keykeeper/join-seals.spec.ts`, which keeps a copy, and `join-checks.spec.ts` for who's let in, the daily limit included); API tests for who may leave seals and secrets, what the server checks, that the pending lists carry them, and that a change made without a seal drops the old one (`e2e/tests/api/join-seals.spec.ts`); and a web vault test where the server's answers about who is waiting are altered in flight (a made-up person, a stripped joining seal, a stripped invitation seal) and nobody is let in until the answers are real (`e2e/tests/joins-forged.spec.ts`). The install-to-recovery test runs the whole command, secret and fingerprint included.

**Status:** built: the server's storage and routes (`keykeeper_seals.rs` and a migration), the shared checks and computations (`join-seals.ts`, `join-checks.ts`), the web vault's sealing (`join-sealer.service.ts`, used by upstream's invite, the console, the Settings page, and organization creation), the extension's fingerprint check and proof, and the installer's two parameters.

### MSP templates

An MSP makes an item template once (a firewall, a Microsoft 365 tenant, a line-of-business app) and every client gets it, so technicians and the client's own people document things the same way everywhere. See "Item templates" for what a template is.

- **The source** is an ordinary custom template the MSP admin can see: in their own vault, or better in an organization all of the MSP's admins share, so any of them can change it. It's never one of the MSP's clients. The server records which item it is, never what's in it. The server names the source, so each admin's device checks it before copying: a template (never an ordinary item), not itself a copy from an MSP, and not in one of the MSP's clients. And it replaces only a copy of that template in each client, never another item the server points it at, and moves to the trash only items that are copies.
- **It applies automatically,** like a default policy: an MSP admin adds a template for every client (including clients added later) or for chosen ones, and that's all. Nobody sends anything.
- **How:** each client gets a copy, with the same template id, in its "Templates" collection, encrypted with that client's key. The server can't read templates, so it can't make copies; a browser holding the clients' keys must. Any MSP admin's web vault or browser extension does this in the background: when they unlock, whenever their items change (such as after editing a template), when the MSP console opens, and every five minutes in the extension. It creates the collection the first time. The server records each copy's item and which version of the source it was made from (the source's revision date), so any admin's vault can tell which clients are behind. It never sees a template's name or fields. If no MSP admin is signed in to either, changes wait until one is. The desktop agent doesn't do this work: it holds the user key only behind Windows Hello or Touch ID, and working in the background would mean keeping it unlocked. Two devices writing a client's copy at the same moment leave a duplicate; the next run moves the one the server didn't record to the client's trash.
- **Updating:** edit the template (the console's Edit opens it). Clients get the change on their own. The console shows "Update" only if a client couldn't be updated, to try again; a failure isn't retried automatically, so it can't repeat forever. A copy is the MSP's: an update replaces whatever the client changed in it. A client that wants something different makes its own template, which is just a template in its organization.
- **Removing:** MSP admins can remove a template, and choose whether its copies stay in the clients or go.
- **Who sees copies:** everyone with access to the client's Templates collection: MSP admins and technicians who see vault items, the client's owners and admins, and the client's own members, read-only. Members get it when the collection is first made and, after that, when they're confirmed, by any way in (an email invitation, the install command). Read-only, because the MSP keeps the copies: members use them in "New item from a template". A member an admin already gave the collection keeps that access, and the MSP's people reach it through the MSP as before.
- **Templates from an MSP** show once, under "From <MSP>", in "New item from a template", even for MSP staff who see the same template in many clients.
- **Who:** MSP admins add and remove templates, and their vaults keep copies current. Technicians see which templates their clients get.
- **Audit log:** templates added, changed (which clients), applied to clients, and removed. Entries name the template only by id; the console shows the name to people who can see it.
- **Tests:** API tests for recording templates and copies (only the MSP's own clients, only items in that client, never a client's copy as a source), what a limited technician sees, and the permission matrix. A console e2e test creates a template, adds it for every client, sees a new client get it, edits it and sees every copy change with nothing else clicked, and finds it once under "From <MSP>" in the vault. An extension e2e test, with no vault tab open, edits a template in the popup and sees the client's copy change.
- **Status:** built (`keykeeper_msp_templates.rs`, a migration for SQLite and PostgreSQL, the console's Templates section, and `libs/admin-console/src/common/keykeeper/`: `msp-work.ts`, the background work the web vault and the extension share, and `msp-template-sender.ts`, which writes copies with upstream's own item and collection code). A copy's definition names the MSP, so "New item from a template" groups it under "From <MSP>" and the item view and editor say the MSP keeps it up to date. To change which clients get a template, add it again with the new choice. Members get the Templates collection read-only (server: `give_templates`, called when the collection is recorded and in upstream's confirm), with an API test. Not yet: a separate control for which clients get a template.

### Server

- New endpoints live under `/api/keykeeper/msp`, so they never collide with upstream routes. Every one checks the caller's MSP role and that the org belongs to that MSP.
- New tables: `msps`, `msp_staff`, `msp_clients`, plus an `msp_id` on memberships that came from an MSP.
- **Databases:** PostgreSQL in production and SQLite for self-hosting and tests. We drop MySQL and CockroachDB: fewer code paths, and our own migrations only need writing twice. CI runs the API tests on both.
- Creating MSPs is off by default on self-hosted servers (`MSP_SIGNUPS_ALLOWED`).

### Status

- **Built, server:** MSPs, staff roles, clients, staff kept in step with every client, the list of memberships waiting for a key, and a client's view and removal of its MSP (`src/api/core/keykeeper_msp.rs`, migrations for SQLite and PostgreSQL). MSP tables cascade, so upstream deletes of users, orgs, and members always work. A client's single-organization, two-step login, and other member policies don't apply to MSP staff. Upstream exempts owners and admins; the server exempts every membership that came from an MSP the same way, so a technician with a custom role, who is a regular member in each client, still works in every Business client. **Known gap:** the apps still apply a client's member policies, such as removing the individual vault, to a technician with a custom role, because they exempt only people who can manage policies.
- **Built, console:** "MSP console" in the web vault, shown to MSP staff: set up an MSP, clients with member counts and a link into each client's admin console, add a client with the Business defaults (its keys made in the browser with upstream's own code), each client's RMM install command, password health per client (expiring items, weak passwords, reused passwords; computed in the browser, so the server never sees it), and add, re-role, or remove staff. Opening it confirms everyone waiting whom the person can confirm and whose organization lets them in without approval; MSP staff's web vault and browser extension also do it in the background (see "Joining"). People in a client that requires approval wait for an admin's Confirm on its Members page, with the fingerprint.
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

### MSP staff and account recovery

An MSP staff member's account reaches every client they work in, so whoever could recover it could reach all of them. So no organization recovers a staff account, through any membership: the server refuses enrolling a staff member in any organization's account recovery (accepting an invitation, the install command, or enrolling later), refuses recovering one, and ends every enrollment someone has when they join a staff. This is per person, not per membership, so a membership a client grants a staff member itself is covered too.

### MSP staff and two-step login

A client's "Require two-step login" policy applies to its MSP's staff, who reach its items (decided October 2026). Staff without two-step login can't be confirmed into a client that requires it, and a technician who turns it off loses that client, as a regular member would. An MSP's admins own its clients, so the policy never removes them, as upstream never removes owners; the console asks them to turn it on.

### Adding MSP staff

Adding someone to an MSP's staff always sends an invitation they accept themselves, with or without an account, and the answer to the admin is the same either way: adding an existing account directly would make them an owner of every client without asking, and would say which emails have accounts. Invitations expire with the server's invitation lifetime, need a verified email where the server sends email, and end when the person joins or leaves the staff.

### Login limits

Upstream limits logins per address: a burst of 10, then one a minute, and 50 requests shared by signup, pre-login, and the password hint. On rollout day a whole office comes from one address, so it stopped after ten to twenty-five people. What stops someone guessing a password is a limit on the account, wherever the guesses come from, so that's where the strict one is now.

- **Each account:** 10 login attempts from one network (an IPv4 /24 or IPv6 /64), then one a minute (`LOGIN_RATELIMIT_ACCOUNT_*`), counting the 2FA step and the email two-step code request, which checks the password too. Across every network, 100, then one every 36 seconds (`LOGIN_RATELIMIT_ACCOUNT_ANYWHERE_*`). Keyed by the email as typed (trimmed, lowercase), whether or not an account has it, so being refused says nothing about which emails have accounts. Keys are 32-byte hashes, and the server forgets the ones whose limits have filled back up.
- **Nobody can lock someone else out (security review, October 2026):** counting per network means guesses from elsewhere don't use up the owner's own allowance, and a device already signed in to the account isn't limited at all, so the owner's own devices always get through.
- **Each address:** 100 logins, then one every 6 seconds (`LOGIN_RATELIMIT_*`, upstream's settings with new defaults). Pre-login, which every login starts with, gets the same allowance, counted on its own; it only says how to derive the key, the same way for an email without an account.
- **Signup and the rest:** the shared allowance for signup, the password hint, recovery emails, and Send access is 150 at once (was 50), still refilling at one a minute, so 50 people can sign up together.
- **What it costs:** one address can now try 10 accounts' passwords a minute instead of one. Every guess also needs the client's KDF (600,000 PBKDF2 rounds by default), each account still allows only 10, and the hosted service has Cloudflare's rate limits in front.
- **Self-hosters** who set these settings keep their values.
- **Tests:** unit tests for the account key (case, spacing, emails without accounts, per network, across networks, IPv6 and mapped IPv4); API tests on a third test server that keeps the real limits (the other two relax them), where 30 people at one address sign up, pre-login, and log in, and guessing one account stops at its 11th attempt, the right password included, while a colleague logs in and an email without an account is refused the same way. Both fail on upstream's limits.

### Onboarding through the RMM (Business, version 1)

No desktop agent needed: browsers already let policy hand an extension its settings, and our installer already writes browser policy.

1. **The MSP copies one command.** In the MSP console, each client has an install command: our install script with the server address and that client's enrollment token. The MSP runs it from their RMM on the client's machines.
2. **The script configures the browsers.** It force-installs the extension where targeted, turns off the browser's password manager, and gives the extension two managed settings: the server address (upstream already reads this) and the enrollment token.
3. **The person signs up or signs in in the extension.** The server is already filled in. After unlock, the extension sees the token, asks the server which organization it belongs to, and asks the person once, in a small window: "Join Acme Dental?", what joining means, and, where the organization uses account recovery, that its admins will be able to reset their master password and sign in as them (with its fingerprint phrase, and a word that this would reach any organization where they're an owner or admin). On Join, it encrypts the person's user key to that organization's public key for account recovery (upstream's own enrollment code, as an emailed invite does) and sends the join. "Not now" sends nothing and asks again a week later.
4. **MSP staff's apps confirm them** in the background, like any member waiting for the org key, when the join doesn't need approval (see "No click only with domains"): the web vault or browser extension of anyone on the MSP's staff who can confirm in that client, while unlocked. The extension checks every five minutes, and the console confirms on opening. Joins that need approval wait for an owner or admin's Confirm on the client's Members page, which shows the person's fingerprint. The desktop agent doesn't confirm, for the same reason as in "MSP templates".

**The enrollment token** is per client, random (256 bits), and shown to the MSP's staff in the console. It lets an account ask to join that client as a regular member; it never grants the org key. Joins through it are auto-approved, per the Business defaults, so the token is a credential: the console can replace it (old installs then stop working for new joins), and each join is recorded with when it happened. The server keeps it like upstream keeps organization API keys. An account in another organization can't join (single organization).

- **Limiting it to email domains:** an MSP admin can list a client's email domains (acmedental.com, and others), and then only accounts at exactly those domains can join with the command; mail.acmedental.com is its own entry. An email counts only once it's verified, or anyone could sign up as ceo@acmedental.com and walk in, so the limit needs a server that sends email, and the extension tells an unverified person to verify first. Someone the client's admins invited by email can still join with the command from any address: an admin chose them. Changes go in the MSP's activity log.
- **No click only with domains (decided October 2026):** a join with the install command gets in without anyone approving it only when the command is limited to email domains (verified emails), and the join's proof checks out against the command's join secret (see "Joins a hacked server can't forge"). Without domains, the command can be copied off any machine it ran on and used with any account, so those joins wait for an owner or admin to approve them, and the owners' email says so. The console asks MSPs to set domains.
- **Invitations through the command:** someone the client invited by email can join with the command instead of the link, but only for a regular invitation (not admin, owner, access to all items, or a custom role) and, where the server sends email, from a verified address. Otherwise registering an invited address would be enough to take its invitation.
- **Who hears about a join:** the client's own owners get an email for each one ("<email> joined Acme Dental with your IT provider's install command", or "is waiting to join" where an admin approves joiners), with a link to the Members page. Its MSP's people don't: a rollout to 50 machines would be 50 emails, and the console's Activity has every join. A person who was invited by email first is the inviter's to hear about, as for any invitation.

- **What the extension won't do:** send the token to any server but the one the same policy names (an account on another server never sees it); join for MSP staff, who sign in on their clients' computers; or keep the token itself (it remembers a hash, to ask once per token).
- **The command can't carry code:** the console checks each part of the command it shows (the token, join secret, and key fingerprint are 43 base64url characters each, the server a plain HTTPS address, the script name a `.ps1` file) and single-quotes them for PowerShell. A token that isn't one isn't shown or copied, so a hacked server can't turn the command into code the RMM runs on every client machine. The install script checks the token and address again.

**Status:** built. The server issues a token with each new client and joins through upstream's invite acceptance; the MSP console shows each client's install command with a copy button, the number of people who joined with it, and (for MSP admins) a way to replace the token; the install script writes the extension's managed settings; the extension asks, joins after unlock, and says so once. An end-to-end test runs the whole path with real keys on the mail test server: the extension asks, the person joins, an MSP admin approves them on the Members page and recovers their account, and they sign in with the new password to an intact vault. Another says "Not now" and checks nothing joined, and that a token for another server goes nowhere. Email domains and join emails are built too (`enrollment_domains` on the server, the console's install command panel), with mail tests for both and a console test. Not yet: the install script's download URL with a pinned signature (the console shows the command for a local copy of the script).

**Tests:** API tests for the token endpoints and their permission matrix, joining (with and without account recovery, already a member, single organization, a replaced token), and that a join never includes the org key. The extension's join logic gets unit tests with managed settings stubbed. Tier 2 runs the real install script on Windows and checks the policy values the browsers will read.

### A company's own IT

A company that runs its own IT gets what an MSP's client gets, without setting up the MSP console: the Business defaults, the Everyone and Admins collections, and an install command. An IT team that runs several companies or locations uses the MSP console instead.

- **"New organization" asks what it's for.** A business (the default choice) gets the Business preset in one server call (`POST /keykeeper/organizations`), so a closed browser tab can't leave it half set up: single organization, master password requirements, account recovery with automatic enrollment, the Everyone and Admins collections, and an install command. A family or a group gets upstream's organization: no policies, one collection. Both follow upstream's rules for who may make an organization (`ORG_CREATION_USERS`, and not while a member of an organization with single organization on).
- **The install command is on the organization's Settings page**, below Joining, for its owners and admins: the command with a copy button, how many people joined with it, email domains (with a server that sends email), and Replace token. An organization without one (made before this, or for a family) has "Create install command". Everything else is the MSP version's: the same token, the same join (`/keykeeper/enrollment/join`), Everyone for people who join, and the owners' email, which says "your install command" instead of "your IT provider's".
- **An MSP's client's command stays in the MSP's console.** Making, replacing, or limiting it through the organization routes is refused for an MSP's client, even for its owners, so a technician the MSP didn't give install commands can't get one through the client's admin console, where they're an admin. Reading it answers only which IT provider manages it, and the client's Settings page says so.
- **Reading never answers 403.** Upstream's web vault signs out on a 403, and every owner's and admin's Settings page reads the command, so anyone else gets "not found" (the card stays hidden) and an MSP's client gets the provider's name, not a refusal.
- **A client that removes its MSP** keeps its preset and Everyone collection as its own, but not the token, which was the MSP's: its owners make a new command.
- **Storage:** `org_setups` (organization, preset, token, Everyone collection), the counterpart of the same columns in `msp_clients`. Joins are counted in `msp_enrollment_joins`, which is keyed by organization.
- **Tests:** API tests for the preset, joining, the permission matrix (owners and admins only; members, managers, outsiders, anonymous, and an MSP's admin and technicians refused), a client that removed its MSP, and upstream's creation rules; a mail test for the owners' email and email domains; a web vault test that makes a business and a family organization, joins one with its command, and replaces the token.

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
- **Built for a company's own organization too:** "New organization" for a business applies the same preset and makes an install command (see "A company's own IT").
- **Not built:** new members invited by email getting the "Everyone" collection automatically (people who join with the install command get it), and the Solo and Family presets.


Every setting explains itself in one sentence. Changing a setting needs no action from users.

## Browser import

- Runs automatically after first sign-in.
- Sources: Chrome, Edge, Brave, Opera, and Vivaldi through the upstream GPL importer (`apps/desktop/desktop_native/chromium_importer`). Firefox is ours to write.
- Dedupe: identical URL, username, and password merge into one item. Same URL and username with different passwords: the most recently changed wins and the others go to the review queue.
- Skip "never save" entries and entries with empty passwords.
- Ends with a summary and a review queue that users clear whenever they like.

### Keeping up with upstream

- **The bases:** the server follows Vaultwarden's release tags (`passbundle-server/.keykeeper-base`) and the clients follow the web vault Vaultwarden supports (`passbundle-clients/.keykeeper-base`), not Bitwarden's newest: the server must understand the clients. The two move together.
- **The weekly watch** (`.github/workflows/upstream-watch.yml`, `tools/upstream-watch/`) keeps one issue, "Upstream and dependency watch", open while something needs doing and closes it when nothing does. It raises a Vaultwarden release newer than our server base (flagging security fixes), Vaultwarden shipping a newer web vault than our clients base, and known vulnerabilities in what we ship: `cargo audit` of the server and the desktop agent, and `npm audit` of the clients' production dependencies.
- **Accepted advisories:** npm packages that never reach the web vault or the extension (the command-line client's, and build tooling) are listed with a reason in `tools/upstream-watch/accepted.json`; the watch notes them instead of raising them. The command-line client's need another look before we ship it.
- **Security fixes ahead of upstream:** when a fix is in a patch release of a dependency we ship and upstream hasn't taken it yet, we take it ourselves, as with Angular 21.2.25 in the clients (two cross-site scripting advisories) and rustls 0.23.46 for the server's outgoing connections (four advisories), and drop our change at the next base move. Advisories that don't apply to how we use a crate (Rocket's old rustls, which only serves TLS, or `rsa`, which has no fix yet) are accepted in the same file, by advisory and version, with a reason.

## The look

PassBundle has its own look, not Bitwarden's with a new color: translucent glass over a soft color field, the way 1Password looks on a Mac, with type and artwork of our own.

- **One look, three settings.** Settings, Appearance, Theme offers Glass (the default), Light, and Dark. Glass is upstream's System setting: light or dark like the device, with translucent bars, groups, cards, tables, and dialogs. Light and Dark are solid surfaces, for anyone who reads better without the translucency. The extension and the web vault share it.
- **Identity in every theme:** Figtree (SIL Open Font License, bundled; its license is in `brand/assets/fonts`), the brand palette, a gray scale tinted toward the brand's green instead of upstream's slate blue (so dark mode is green-black, not navy), and the illustrations' colors. Inter, upstream's font, still draws scripts Figtree doesn't cover.
- **Artwork:** every illustration and tab icon upstream draws in Bitwarden's style (55 of them) is redrawn from the logo's shapes, the rounded bands and the shackle, by `brand/artwork/draw.mjs`. The brand step puts each in place of upstream's drawing by its name, and fails if upstream renames one. Drawings use the theme's color classes, so they follow light, dark, and glass. Duo's and Yubico's logos stay theirs; the product logos are swapped by the brand step as before.
- **How:** `brand/look.css` is added to the component library's theme at build time. It targets upstream's components (`bit-*`, `popup-*`) rather than its utility classes, so changes inside them don't break it. The theming service sets `pb-glass` on the page for the System setting (a `// Keykeeper:` block), and the web vault's pre-start theme script does the same, so there's no flash of the solid look.
- **Not glass:** what the extension draws inside websites (the autofill menu, the save bar) follows light or dark only. A desktop window, when there is one, can use the operating system's own translucency (macOS vibrancy, Windows Mica).
- **Tests:** a unit test for the setting (Glass only for System, light or dark like the device), and an end-to-end test that the web vault starts in Glass, follows the device, switches to solid Light and Dark and keeps the choice across a reload, uses Figtree, and shows none of upstream's drawings on the sign-up page and the vault.

## UX we commit to

Fixes for things that annoy users of Bitwarden and 1Password today.

- **One unlock:** unlocking the desktop agent unlocks the browser extension, and the other way around, over the existing authenticated native-messaging channel. Locking either one locks both.
- **Biometrics by default:** Touch ID on Mac and Windows Hello on Windows are offered at first unlock, with no separate "browser integration" setup. Admins control biometrics and password requirements in the portal.
- **Survives profile migrations:** tools like ForensiT Profile Wizard change the Windows user's SID, so locally protected data (DPAPI, Windows Hello keys) stops decrypting. Upstream's extension then works once and needs a reinstall. Ours detects local state it can't decrypt, clears it, and asks the user to sign in again. Never a broken extension.
- **Custom fields are one tap away** in every item editor (web, extension, desktop, mobile), not buried in a menu.
- **Context-aware new items:** creating an item while viewing a folder or collection puts it there.
- **Onboarding day works:** upstream rate-limits logins per IP (a burst of 10, then one per minute) and signup, pre-login, and hint requests per IP (a shared burst of 50, then one per minute). A whole office behind one NAT address would get stuck after ten to twenty-five people. Built: the strict limit is per account now, and an address's limits fit an office (see "Login limits"). Later: allowances for an org's known addresses and enrolled devices.
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
- **Built:** the "Expires" date in the item editor (web, extension, desktop share it), an Expiration section in the item view, badges in the web vault list and the extension's item list for items expired or expiring within 30 days, and card expiry in the item view. All of PassBundle's own fields stay hidden in views and editors and survive edits (`libs/vault/src/keykeeper/`). An "Expiring items" report on the web vault's Reports page lists everything expired or expiring within 30 days, cards included, expired first, then soonest. The extension checks every six hours while unlocked and shows a system notification at 30, 7, and 1 day before and once expired, never twice for the same step; a new date starts over (`apps/browser/src/keykeeper/expiration-reminders.ts`). What it already showed is kept per account and cleared at logout. Tier 1 covers each.
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
- **Where a rule fills:** only on the host (and port) it was made on, so a rule on an item that matches several sites, or one someone with edit rights added, can't send a value anywhere else; only into a field the person can see; and, when the rule names a field id, only a field with that id (a name or label never stands in for it). For someone who can't see the item's passwords, a password or hidden field goes only into a password field. Our own fields (`keykeeper.*`) never fill a page field by name.
- **The picker keeps upstream's rules:** an item that asks for the master password asks before its password, code, or hidden fields fill (the rule is saved, and the fill after the prompt uses it); hidden fields aren't offered to someone who can't see passwords; and a secret never goes into a frame from another site.
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

## Capacity

What one Phase 0 server handles, measured by the load test in the private ops repo (`hosting/load/`): the Release image with the app and PostgreSQL sharing two cores (a mobile Xeon E-2276M) and 4 GB, 500 accounts with 100 items each (50,000 items in the database), and k6 on other cores.

| Request | Per second | Median | 95th percentile |
|---|---|---|---|
| Sync (`/api/sync`, what every app does on unlock and after changes) | 451 | 110 ms | 119 ms |
| Saving an item | 884 | 56 ms | 63 ms |
| Signing in with the master password | 9 | 866 ms | 1.3 s |

- **Signing in is the expensive one, on purpose:** the server hashes the master password hash again (PBKDF2, 600,000 rounds) before comparing it. Unlocking doesn't touch the server. On rollout day, 200 people signing in within the same minute wait at most about 20 seconds.
- **What that means for people (assumptions, not measurements):** in the busiest hour, an active person's apps sync about 6 times and save once, and 1 in 10 people signs in with their password. Then one starter server has room for well over 100,000 people active in that hour. A provider's vCPU is often slower than these cores, so halve it to be safe. Resize when the busiest hour uses half the CPU (launch plan, "How it scales").
- **Not measured yet:** live-update connections (one per open app), memory over days, and organizations with thousands of shared items.

**Sync used to get slower as the service grew.** Upstream's item query (`Cipher::find_by_user`) left-joins items to memberships, collections, and groups and ORs the access conditions across the joins, which no index can serve, and upstream has no secondary indexes. So every sync read every item in the database: the same 100-item vault synced at 258 a second with 2,000 items in the database and 65 with 50,000 (310 ms in the item query).

- **The fix (passbundle-server):**
  - **Narrowing:** every access condition in that query goes through the join on the person's confirmed membership in the item's organization, or else it's the owner condition. So the query is first narrowed to items the person owns or that belong to one of their confirmed organizations, with those organizations looked up first. The conditions that decide are unchanged, and so is what it returns.
  - **Indexes:** a migration (`keykeeper_lookup_indexes`) indexes what sync and sign-in look up by.
- **Tests:** every API and mail test (permissions across owners, collections, groups, admins, custom roles, and MSP staff) passes unchanged on SQLite and PostgreSQL. The load test is the regression check for speed.

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

- The launch site (`site/`) goes to a preview address until launch; passbundle.com still shows the earlier "in development" page. `site/README.md` lists what has to be true before it goes live.
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
