# The core

Design, October 2026. PassBundle's own apps (desktop and mobile) share one library, the core, written in Rust. It does everything except draw the screen. It handles keys, so per the rule in DESIGN.md, this note and its test vectors (`docs/vectors/core-v1.json`) come before the code.

## Why

On October 20 we decided our desktop and mobile apps are our own, not upstream's: Bitwarden's format and our server stay for the security side (storage and encryption), and every app looks and behaves the same. One Flutter UI draws the screens everywhere, and one core does the rest. A logic bug then shows up everywhere or nowhere, and it's fixed once.

The browser extension and the web vault stay upstream's for now. They can move onto the core later, compiled to WebAssembly.

## What the core does

- **Signing in and unlocking:** with an email and master password, against the person's PassBundle server, including two-step login.
- **Sync:** the vault from `/api/sync`, kept on the device as the server sent it (still encrypted), so the app opens without a network.
- **Opening the vault:** the user key, the private key, organization keys, and every item, folder, and collection.
- **Changing it:** new, edited, and deleted items, encrypted the way the other apps expect, so the web vault and the extension read them.
- **Everything the screens show:** search, one-time codes, the password generator, what an item shows and in what order, and the words for errors.
- **Copying:** the core puts a secret on the clipboard itself and clears it later (below).

It never draws anything, and it never talks to any server but the person's own.

## Clean room

The format is Bitwarden's, from its public security whitepaper and the GPL TypeScript clients we already ship, which we may read. We never read or link Bitwarden's SDK (`sdk-internal`) or anything under the Bitwarden License (CLEAN_ROOM.md). The core uses the RustCrypto crates, as the desktop agent does, and its CI fails if any Bitwarden crate appears in `Cargo.lock`. Upstream's crypto is used in one place: the public `PureCrypto` API, to check our test vectors from the outside.

## The format

What the core reads and writes. Everything else is refused (below).

**Keys from the master password.** The server's prelogin (`POST /identity/accounts/prelogin`) gives the KDF and its settings.

- **The salt is the email**, trimmed and lowercased.
- **Master key** (32 bytes):
  - PBKDF2: PBKDF2-SHA256 of the password, with the email as salt, for the given iterations.
  - Argon2id: Argon2id of the password, with SHA-256 of the email as salt, for the given iterations, memory (in MiB), and parallelism.
- **Login hash**, sent instead of the password: base64 of PBKDF2-SHA256 with the master key as the password and the master password as the salt, 1 iteration.
- **Stretched master key** (64 bytes): HKDF-Expand-SHA256 of the master key with info `enc` (32 bytes), then with info `mac` (32 bytes). No extract step.

**KDF settings are checked before anything is derived.** A hacked server could answer the prelogin with weak settings, so the device derives a cheap master key and sends a login hash that's easy to crack offline. The core refuses settings outside these bounds and says the account's security settings need changing in the web vault:

| KDF | Allowed |
|---|---|
| PBKDF2 | 600,000 to 2,000,000 iterations (600,000 is what our apps make) |
| Argon2id | 16 to 1,024 MiB, 2 to 10 iterations, parallelism 1 to 16 |

**Encrypted strings** (EncString), `<type>.<parts>`:

- **Type 2**, `2.<iv>|<ciphertext>|<mac>`: AES-256-CBC with PKCS#7 under the key's first 32 bytes, and HMAC-SHA256 over IV then ciphertext under its last 32. The MAC is checked first, in constant time, and a bad MAC refuses the whole string. A 64-byte key is "a symmetric key" below.
- **Type 4**, `4.<ciphertext>`: RSA-2048 OAEP with SHA-1, for organization keys. Type 3 (OAEP with SHA-256) is read too.
  - The core uses the `rsa` crate, whose decryption isn't constant-time (RUSTSEC-2023-0071, the Marvin attack). That attack needs someone timing many decryptions of ciphertexts they choose. The core decrypts only the person's own organization keys, on the device, once per unlock, so it offers no such oracle. We move to a constant-time release when there is one.

**The keys, in order:**

| Key | Where it comes from | Opened with |
|---|---|---|
| User key (64 bytes) | `Key` in the token response and profile, type 2 | the stretched master key |
| Private key (RSA-2048, PKCS#8) | `PrivateKey`, type 2 | the user key |
| Organization key (64 bytes) | each organization's `key`, type 4 | the private key |
| Item key (64 bytes), if the item has one | the item's `key`, type 2 | the user key, or its organization's key |

**Items.** An item's fields (name, notes, username, password, one-time code secret, URIs, custom fields, and the rest) are type 2 strings under its item key if it has one, otherwise under the user key, or the organization's key for an organization's item. Folders use the user key, collections their organization's key.

- **Cards and identities** have their own details, each a type 2 string under the same key. A card's number and security code, and an identity's Social Security, passport, and license numbers, are secrets like a password: kept zeroizing in the core, and out of it only when revealed or copied. Lists show a card by its brand and the number's last 4 digits ("Visa, *1111") and an identity by its name. Search reads a card's holder and brand, and an identity's name, company, email, and username, never a secret. The apps show, copy, and edit them, and make new ones. **SSH keys** show their public key and fingerprint, and their private key is a secret the same way; the web vault makes and edits them. The vectors have one of each, opened by the core and by upstream's crypto.
- **Attachments:** each file is encrypted with a key of its own (64 bytes, AES-256-CBC with HMAC-SHA256, as an item key), stored as upstream's file format: the type byte 2, the 16-byte IV, the 32-byte MAC over the IV and ciphertext, then the ciphertext. The file's key and name are type 2 strings under the item's key (its item key, its organization's, or the user's). A file with no key of its own (very old ones) is under the item's key. One whose name or key doesn't open is listed as an attachment that can't be opened, and the rest of its item still opens. The MAC is checked before anything is decrypted, as for strings; a file that fails it is refused, never shown. The apps download a file only when someone saves it: the server's `GET /api/ciphers/<id>/attachment/<attachment id>` says where, and the file is fetched from the server's own address or over HTTPS, without the session's token. The download doesn't hold up the app's other calls or locking, may take up to half an hour, and is refused past 501 MiB (upstream's 500 MB limit, before encryption). It's decrypted in memory, in place (so a file needs its size in memory once, not three times), and written by the core itself. On a computer it goes to the Downloads folder:
  - next to anything of the same name rather than over it, created only where nothing is, not even a link, so it never writes through one out of the folder;
  - readable only by the person, and removed if writing it fails;
  - marked as downloaded (macOS's quarantine, Windows' Mark of the Web), so the OS asks before opening an app or script from it;
  - under a name that can't leave the folder, without invisible characters that change how it reads (a right-to-left override can make `invoice\u202Efdp.exe` look like `invoiceexe.pdf`), not hidden, not a Windows device name, and at most 200 bytes.

  Elsewhere: on Android into the file MediaStore makes in Downloads (the core writes through the file descriptor, so the file never passes through Java); on an iPhone into the app's Documents folder, which Files shows under On My iPhone, PassBundle. An item that asks for the master password asks first. Tests: the vectors, a real-server test that uploads an attachment the way upstream's apps do and then downloads and opens it, the phone tests saving one on Android and iPhone, and unit tests for names, links in the folder, the file's permissions, the quarantine mark, and an attachment whose key doesn't open. The vectors have one attachment under the user key and one on the item with its own key, a changed file that's refused, and upstream's crypto opens them too.
- **Folders** are made, renamed, and deleted in the apps' sidebar, through upstream's folder endpoints (`POST /api/folders`, `PUT` and `DELETE /api/folders/<id>`); the name is a type 2 string under the user key, and the core syncs after each. Deleting a folder leaves its items in the vault, in no folder, as upstream's apps do. On phones the same is in the menu (the sidebar, as a drawer), which also shows favorites, folders, and organizations; an item's editor chooses its folder everywhere. Tests: a real-server test that makes, renames, and deletes one with an item in it, and app tests of the sidebar's dialogs and of the phone's menu.
- Our server and apps don't make item keys today; the core reads them so an item that has one still opens.
- It writes new items without item keys, like the other apps, until they all do. Editing an item that has one keeps it, and encrypts what changed under it ("Editing keeps what the app doesn't show", below).

**Refused**, with a message saying so, never decrypted around:

- type 0 and type 1 strings (no MAC, or 128-bit keys);
- types 5 and 6 (older RSA with HMAC);
- keys of a newer kind upstream is starting to use (XChaCha20-Poly1305);
- anything whose MAC fails, whose padding is wrong, or whose key has the wrong length.

An account or item that needs them gets "made by a newer app" or "damaged", never a guess.

## Signing in

1. Prelogin, then derive the master key and the login hash.
2. `POST /identity/connect/token` with the password grant: the email, the login hash, `scope=api offline_access`, and this device:
   - its type, as upstream numbers them (6 Windows, 7 macOS, 8 Linux, 0 Android, 1 iOS), with `client_id` `desktop` or `mobile`;
   - a name ("PassBundle on Windows");
   - an identifier made once per install and kept by the app.
3. The response carries the access token, the refresh token, the user key, and the private key. The core opens the user key with the stretched master key; a wrong password fails here, on the device, as well as on the server.
4. Sync, then open the vault.

**Two-step login.** If the account has it on, the server answers step 2 with the methods it offers. The core does an authenticator app's code and an emailed code (it asks the server to send the email); the others come later.
- The sign-in waits for the code holding the login hash and the stretched master key, in memory only, so the slow KDF runs once.
- The code goes back with the same request.

**Unlocking later** is steps 1 and 3 without the network: the KDF settings are kept with the email, and the encrypted user key is in the cached sync.

**The session.** The access token is refreshed with the refresh token a minute before it expires. When the server refuses the refresh token, the app is signed out and asks for the master password.

**Saving an item** sends it encrypted, under its organization's key or the user key, with the revision it was edited from. The server refuses an edit made from a copy that's since changed (more than two seconds older), so one device can't overwrite another's newer edit; the app syncs and the person tries again.

**Asking for the master password again.** An item can ask for the master password before its secrets are used (upstream's "master password re-prompt", which the web vault and the extension set and honor). The apps honor it the same way:

- **Opening such an item asks for the master password first.** Lists still show it as upstream's do; its view shows only its name until it's given, and its secrets (password, one-time code, notes, hidden fields, a card's number and code, an identity's ID numbers) don't reveal, copy, or fill. Its editor opens only after it's given, and a save must hand back the same giving (the core's `grant`), so an editor can never save blanks over secrets it couldn't show.
- **The check:** the core derives the master key with the account's KDF settings (the same ones it unlocks with, checked the same way) and opens the kept protected user key with it. It's right only if that opens and gives the user key the vault is open with. Nothing new is stored, and nothing is sent to the server.
- **How long it lasts:** for that item, until another item asks, or the vault locks. The core enforces it (`App::value` and the reveal calls refuse with "asks for the master password first"), so a screen can't skip it.
- **Phones:** filling a login that asks, through Android's autofill, asks for the master password first in PassBundle's own dialog. iOS's AutoFill extension will ask in its own screen, with the extension.
- **Biometrics don't stand in for it**, as in upstream's browser extension and web vault: it's there for the person who already unlocked with them.
- **Tests** (`core/tests/reprompt.rs`, the app tests): on the sample vault with one login set to ask, its secrets are refused before the master password and given after it, a wrong password says so, giving it for another item moves it, locking forgets it, and an edit waits for it; opening the item in the app asks, a wrong password says so, and the right one shows it.

**Editing keeps what the app doesn't show.** The server replaces an item with what an edit sends, so an edit sends back everything the app doesn't change, as the server sent it:

- **The item's own key**, if it has one. What changed is encrypted under it, so what's kept as sent (below), and its attachments' keys, still open. Without it, those would be lost.
- **Whether it asks for the master password first** (upstream's "reprompt"). Never turned off by an edit.
- **A login's passkeys**, whether it fills on page load, and when its password last changed.
- **Yes-or-no, linked, and nameless custom fields**, which the app's editor doesn't edit, and **our own data on items** (`keykeeper.*` fields: fill rules, the expiration date, the template marker), which the apps never show or edit as custom fields, as the web vault and the extension don't. Each is kept in its place among the item's fields. The item view shows the expiration date.
- **Each website's checksum**, base64 of its address's SHA-256 under the item's key, as upstream writes it. Upstream's apps show an item with its own key only the websites whose checksum matches, so a server can't swap one in; keeping the key without them would hide the websites there.
- **The password history**, with what upstream's apps add on an edit, newest first: a changed password, then each hidden field whose value changed or that went ("name: value"), keeping the 5 newest. A changed password sets the date it changed.
- **Refused:** editing an SSH key (the web vault edits them for now), changing an item into another kind (a login into a note, say), and moving an item to another owner, which the web vault does by re-encrypting it.
- **Tested** on the vectors' item with its own key, changed as the web vault would leave it: the edit keeps each of these, what the server keeps opens again under the same key, and the history reads back newest first (`core/tests/editing.rs`).

## What's kept where

| What | Where |
|---|---|
| Server address, email, KDF settings | the app's data folder |
| The last sync, as the server sent it (secrets still encrypted) | the app's data folder |
| When to lock by itself (below) | the app's data folder, kept for whoever signs in on this device |
| Refresh token | the OS's secret store: Keychain (macOS, iOS), Credential Manager (Windows), Secret Service (Linux), Keystore (Android) |
| Access token | memory only |
| (Where) | the OS's local app data folder, in `PassBundle`: `AppData\Local` on Windows, `Application Support` on macOS, `~/.local/share` on Linux. Files are readable only by the person (mode 600 where the OS has modes). The secret store entry is service `PassBundle`, account `<email> on <server>`. |
| Master password, master key, user key, private key, organization keys, anything decrypted | memory only, while unlocked; never on disk |

- **No secret store** (a Linux desktop without a keyring running): nothing is kept. The vault still unlocks from this device, and the app asks to sign in again to sync.
- **Signing out** forgets the kept sync and the refresh token; the server and email stay, to sign in again.
- **Unlock with Windows Hello or Touch ID:** through the desktop agent, with the extension's enrollment (below).
- **"Never lock"** (keeping the user key on disk) isn't offered.

## Memory

- Keys and decrypted secrets live in types that wipe themselves when dropped (`zeroize`).
- Locking drops them all, along with every decrypted item. The app also locks by itself (below).
- **Secrets stay out of Dart.** The screens get what they draw: names, usernames, websites, folders. A password, a one-time code secret, or a hidden field reaches Dart only while the person has it revealed on screen. Copying never passes through Dart: the core puts the value on the clipboard itself, and clears it after 30 seconds if it's still there (never something copied since). It's marked to stay out of clipboard history, the cloud clipboard, and clipboard monitors on Windows, and out of clipboard managers on macOS (`org.nspasteboard.ConcealedType`); Linux under X11 has no such mark. Dart's strings can't be wiped, so this keeps secrets in Rust's memory, which can. The exceptions are what the person types or edits: the master password passes through Dart once (the field is cleared as soon as the core has it), and an item's secrets pass through Dart while its editor is open, as typing them would.

## Locking by itself

The app locks by itself, the same as Lock: every key and everything decrypted is dropped, and whatever was open over the vault (an item's editor, a menu) closes at once.

- **After a time without using the computer:** 1, 5, 15 (the default), or 30 minutes, 1 or 4 hours, or only when the app closes. Using the computer is the OS's own count of keyboard, mouse, and touch input, so working in other apps keeps the vault open, as desktop password managers do: `GetLastInputInfo` on Windows, `CGEventSourceSecondsSinceLastEventType` on macOS, GNOME's idle monitor on Linux. Where the OS doesn't say (Linux desktops other than GNOME), the app's own use counts. The OS's count never outlasts the app's: if the person used the app more recently than the OS says anything was touched, the app's time counts.
- **When the computer sleeps or its screen locks** (one switch, on by default):
  - Before sleeping, on the OS's notice to the app's window (`WM_POWERBROADCAST` on Windows, `NSWorkspace`'s will-sleep notice on macOS, systemd-logind's `PrepareForSleep` on Linux), so the vault isn't open in memory while asleep, or on screen on waking.
  - If a notice comes too late or not at all, the core still sees that the computer slept: it compares a clock that counts time asleep with one that doesn't (interrupt time with and without sleep on Windows, `CLOCK_MONOTONIC_RAW` and `CLOCK_UPTIME_RAW` on macOS, `CLOCK_BOOTTIME` and `CLOCK_MONOTONIC` on Linux), and locks at the first check after waking.
  - The screen locked: the session's state on Windows (`WTSQuerySessionInformation`), the session dictionary's `CGSSessionScreenIsLocked` on macOS, logind's `LockedHint` on Linux.
- **With that switch off**, time asleep still counts toward the wait: waking resets the OS's idle count, so the core adds the time asleep to the idle time it saw before.
- **The clock set back** doesn't stretch the wait: the app's own time is the longer of the wall clock's and a monotonic clock's.
- **How:** the core decides (`core/src/autolock.rs`), from what the OS says, and is tested with made-up readings. The app asks every two seconds while unlocked, and tells the core when the person uses it (at most once a second). A check while a slow call (a sync) has the core waits for the next one; a sleep notice then locks as soon as that call is done.
- **An organization can set the longest wait** (below).

## Locking by policy

An organization can set how long its members' vaults may stay open, which MSPs want for every client. Upstream's server leaves this policy out of its open-source code, and its page for it is under the Bitwarden License, so ours is designed and built here in full. We don't read either.

- **The policy** is upstream's "vault timeout" policy (type 9), with the data upstream's open-source clients read: `{"type", "minutes", "action"}`. Keeping that shape means the web vault and the browser extension, which are upstream's code, already keep to it; what's ours is the server accepting it, the web vault's page to set it, and the core keeping to it.
- **What an organization can set:**
  - **The longest wait** before locking, from 1 minute to a day (`"type": "custom"`, with `minutes`). A person can choose a shorter one.
  - **Immediately** (`"immediately"`): phones lock as the app leaves the screen; computers when the app's window is closed or minimized.
  - **When the computer locks** (`"onSystemLock"`): "Lock when the computer sleeps or its screen locks" stays on. The wait is the person's.
  - **Lock or sign out** when the time comes (`"action"`: `"lock"`, the default, or `"logOut"`). Signing out is what Sign out does: the kept vault and its keys are deleted from the device, and the person signs in again.
  - The page doesn't offer upstream's `"never"` or `"onAppRestart"`: neither limits our apps, which always lock when they close.
- **The server** accepts type 9 and refuses data it doesn't understand: a type other than the three above (or upstream's two that limit nothing), minutes outside 1 to 1,440 for a longest wait, or an action other than lock or sign out. So a client never gets a policy it can't read. An MSP's default policies can include it. The Business preset's "lock when the computer locks" (DESIGN.md) is this policy; MSPs that already existed got it as a default too, and their clients keep what they have until an MSP admin uses the default there. The web vault can't see the computer lock, so there upstream's code turns a "never" or "on refresh" choice into locking on refresh, and leaves a timed choice alone; the extension locks with the computer.
- **Who it binds:** everyone in the organization who has joined except its owners; admins and MSP technicians are bound. That's Bitwarden's own rule ("This policy does not affect organization owners", in its help center), which the web vault and the extension follow as upstream's code, so every PassBundle app agrees. (1Password's policy binds everyone.)
- **More than one organization:** the strictest of each part applies: the shortest wait, immediately over any wait, the computer locking if any says so, and signing out if any says so.
- **In the apps:** the core keeps the person's own choice and the policy apart, and applies the stricter.
  - Settings offers only the waits the policy allows and says why ("Your organization locks PassBundle after 15 minutes at most"). With "when the computer locks", that switch shows on and can't be turned off.
  - A choice made before the policy (a longer wait) is kept, not changed: the policy's wait applies while the policy does, and the person's own choice comes back if the organization drops it or they leave.
  - The policy comes with each sync and is kept with the vault (`sync.json`), so it applies offline and from the moment the vault unlocks.
- **Status:** the server and the web vault's page are built, with their tests (`e2e/tests/api/vault-lock-policy.spec.ts`, `e2e/tests/vault-lock-policy.spec.ts`). The apps keeping to it is built in passbundle-apps' `lock-policy` branch (`core/src/lock_policy.rs`, its tests, and Settings), which goes up once the Android work ahead of it merges.
- **Tests:** the server refuses each kind of bad data and keeps good data as sent; the web vault's page turns each choice into that data and back; the core combines policies from several organizations (made-up policies) and locks, or signs out, by them (made-up readings); the app's Settings offers only what the policy allows; and end to end, the web vault sets the policy and the core, signed in to the same server, keeps to it.

## The bridge to the app

The Flutter app calls the core through plain C functions (`core/src/ffi.rs`), with JSON in and out, rather than a code generator such as flutter_rust_bridge: fewer moving parts, and every call is visible in one file.
- Each call is a command ("unlock with this password", "search for this", "copy this item's password") and gets back plain data for the screen. No key ever crosses the bridge, and no call takes or returns key material.
- Calls that take a while (signing in, unlocking, syncing, saving) run on a background isolate, and the screens don't read from the core while one runs.
- Calls that wait on the network or the desktop agent's socket run on a thread of the core's own. Dart signals the threads that run Dart (its profiler does, in debug builds), and a signal arriving during a blocking read or connect ends it with "Interrupted system call". The Android tests found this.

## Unlock with Windows Hello or Touch ID

Design, October 21, 2026. The desktop agent already unlocks the browser extension with Windows Hello (DESIGN.md, "Biometric unlock"). The app uses the same agent, the same protocol, and the same enrollment: one Windows Hello setup covers both, and the agent stays the one place a key is kept for it. It changes how keys are handled, so this comes before the code; the protocol's vectors already exist.

- **The app is one more client of the agent.** It connects to the agent's own socket (the one the native-messaging host uses) and speaks the same protocol:
  - `setupEncryption` with a new RSA-2048 key, and back the agent's 64-byte session key, wrapped with RSA-OAEP (SHA-1);
  - then type 2 messages carrying `command`, `messageId`, `userId`, and `timestamp`, dropped outside 10 seconds.
- **It checks who it reached**, as the host does. The program at the other end must be the `passbundle-agent` installed next to the app, by the OS's own answer: on Windows the pipe server's image path, on macOS and Linux the socket peer's executable. Otherwise the app sends nothing, least of all the user key.
- **Turning it on:**
  - In the app's settings, while unlocked: "Unlock with Windows Hello". The app sends `keykeeper.biometric.enroll` with the user id and user key over the encrypted channel, and the agent asks for Windows Hello and keeps the key sealed, as for the extension.
  - An account the extension already enrolled has the same user key, so it stays one enrollment.
- **Unlocking:**
  - The lock screen offers it when `getBiometricsStatusForUser` says it's set up.
  - `unlockWithBiometricsForUser` asks for Windows Hello and returns the user key, and the core opens the kept vault with it, as after the master password, without the KDF.
  - The master password always works too.
- **Turning it off, and signing out,** send `keykeeper.biometric.remove`. That ends it for the extension too (it's one enrollment), and the app says so first.
- **Memory:** the RSA key, the session key, and the user key in messages are wiped when dropped; none of them reaches Dart.
- **Without the agent** (not installed, or quit from its tray) the option doesn't show.
- **Platforms:** Windows first, where the agent's Windows Hello is built. macOS when the agent's Touch ID is (it waits on code signing). Linux has none yet.
- **Code:** the core gets the protocol's client side and the peer check. The agent moved into `passbundle-apps` on October 21, 2026, so the core and the agent can share the peer check.
- **Tests:**
  - The core's client against the protocol's vectors (`agent/tests/vectors/native-messaging.json`, in this same repo now). It opens every message and re-encrypts each, with its IV, to the identical string, and unwraps the session key with the vectors' RSA key. Upstream's crypto already checks the same vectors.
  - The core's client against a real agent, built with its stand-in authenticator (the agent's test feature, which release builds refuse), over a real socket: turning it on, unlocking, a wrong user, a cancelled prompt, and a program pretending to be the agent.
  - Real Windows Hello, by hand with the Windows Hello test kit, at each release.

## Servers

Where the apps sign in, so nobody types a server address who doesn't have to:

- **PassBundle's own server** (brand.json's web vault, `https://vault.passbundle.com`) by default. Someone on PassBundle's hosted service signs in with their email and master password and is never asked.
- **A server an organization set by policy**, which the apps then use and show ("Your organization's server: vault.example.com") instead of a field. It comes only from places an administrator writes:
  - Windows: the machine policy key the RMM install writes for the desktop agent (`HKLM\SOFTWARE\Policies\PassBundle\Agent`, `ServerUrl`);
  - macOS: the MDM profile's managed preferences (`com.passbundle.agent`, `ServerUrl`);
  - Linux: `/etc/passbundle/policy.json` (`ServerUrl`), which the Linux install script writes, read only if it's root's and only root can change it;
  - Android: the app's managed configuration (`server_url`), which an MDM sets.
  - iOS: the app's managed app configuration (`server_url` in `com.apple.configuration.managed`), which an MDM sets.

  Nothing the person, or something running as them, can write is read, so nobody can point the apps at another server this way.
- **Someone hosting their own**: "Self-hosted?" on the sign-in screen shows the server field. Signing in to that server once keeps it showing, for next time.

## Network

- HTTPS only, to the server the person set, with the OS's own certificate checks (rustls with `rustls-platform-verifier`), so an office's own root certificate works as it does in their browser.
- The one exception is plain HTTP to this computer (`localhost`, `127.0.0.1`, `::1`), which browsers treat as secure too: a server running on the same machine, and the core's tests.
- No other hosts, no analytics.
- Website icons come from the person's server (`/icons`), as in the other apps.

## Tests

- **Vectors:** `docs/vectors/core-v1.json`, made with plain Node (`node docs/vectors/make-core-v1.mjs`), cover every row of the format above and the refusals:
  - the master key with PBKDF2 and with Argon2id, the login hash, the stretched key, and KDF settings outside the bounds;
  - the user key, the private key, its public key, an organization key;
  - personal, organization, and item-key items;
  - tampered and refused strings;
  - a sample sync that ties them together.
- **Checked with upstream's crypto:** a script in the clients repo opens every vector with upstream's `PureCrypto` (derive, unwrap, decapsulate, decrypt), and tier 1 runs it, as for the other vectors.
- **The core's own tests** read the vectors and must produce or open every value.
- **Against a real server** (`core/tests/server.rs` in `passbundle-apps`, run by its CI against the server's `keykeeper` branch), with real keys:
  - signing up as an app would;
  - a wrong password, and two-step login with an authenticator code;
  - sync, saving, editing, refusing an edit from a stale copy, trash, and refreshing the session;
  - an organization made with its key sealed to the owner's public key, and its items.
- **With the web vault** (`e2e/tests/core-interop.spec.ts`, tier 1, with the core's `interop` tool built from `passbundle-apps`): the web vault makes an account, an organization, and an item in each, and the core opens them. The core saves its own item in each, and the web vault shows every field as the core wrote it. Real keys on both sides. The tool trusts the test server's throwaway certificate through a `test-trust` build feature the app never has.

## New passwords

The generator makes a password or a passphrase, drawn uniformly with the OS's random numbers:

- **A password:** characters from the kinds chosen (upper and lower case, digits, symbols), with at least one of each, leaving out look-alikes (0 O, 1 l I) unless asked. The default is 20 characters; the app offers 4 to 64, and the core takes up to 128.
- **A passphrase:** 3 to 20 words from EFF's long word list (7,776 words, about 12.9 bits each), with up to 3 characters between them, optionally capitalized, and optionally with a digit at the end of one word. The default is 6 words (about 77 bits), as EFF advises.
- **The last choices** are kept on the device (`generator.json`, nothing secret), for whoever uses it next.
- **An organization's "Password generator" policy** (upstream's type 2, from the sync) holds the choices, in the app and in the core before it generates. It binds everyone, owners too, as Bitwarden's apps have it. Across organizations the strictest of each part wins, as upstream combines them: the highest minimum length, digit and symbol counts, and word count; any required kind of character, capitals, or number; and a password over a passphrase when two organizations disagree. The generator shows that the organization sets some choices and won't go below them.

## Passkeys

A login can hold a passkey (upstream's `fido2Credentials`), made by the browser extension, by upstream's apps, or by ours. The apps will use them to sign in to websites and apps, on phones through the OS (Android's Credential Manager, iOS's AutoFill), the way they fill passwords.

**Built so far:** the core reads a login's passkey (its key left encrypted until it signs), lists a site's passkeys, signs in with one (`pb_passkeys`, `pb_passkey_assert`), raising and saving the counter of one that counts, and makes one into a new or existing login (`pb_passkey_create`), saved before it answers. A real-server test makes passkeys and signs in with them, the signatures verified with their own public keys. The apps show a login's passkey (who it's for, when it was made). Android's passkey provider uses them (`docs/phones.md`, "Passkeys"). Not yet: iOS's, and the test both ways with our extension.

**What's stored**, upstream's format, so a passkey made anywhere works everywhere. Each value is a type 2 string under the item's key, except the date:

| Field | What it holds |
|---|---|
| `credentialId` | a UUID (its 16 bytes are the credential ID), or `b64.` and the ID in base64url for one imported from elsewhere |
| `keyType`, `keyAlgorithm`, `keyCurve` | `public-key`, `ECDSA`, `P-256` |
| `keyValue` | the private key, PKCS#8, base64url without padding |
| `rpId`, `rpName` | the site's ID (a domain) and its name |
| `userHandle` | the site's ID for the account, base64url |
| `userName`, `userDisplayName` | the account's names, as the site gave them |
| `counter` | the signature counter, in decimal |
| `discoverable` | `true` or `false` |
| `creationDate` | when it was made (ISO 8601, not encrypted) |

- **Only ES256** (ECDSA on P-256 with SHA-256), which is what upstream makes and every site takes. Any other kind of key is refused, like other formats the core doesn't know.
- **The private key never leaves the core.** It's decrypted only to sign, in Rust, and zeroized after. Dart, Kotlin, and Swift get the signature and what goes around it.
- **One passkey per login**, as upstream: making one for a login replaces the one it had (after asking), and fills in the login's username if it had none.

**Signing in** (an assertion, WebAuthn's `authenticatorGetAssertion`):

- **The authenticator data:** SHA-256 of the site's ID, then the flags, then the counter (4 bytes, big-endian).
- **The flags:** user present, always; user verified, only when the person proved who they are in this sign-in (Face ID, a fingerprint, or the master password, unlocking just now included); backup eligible and backed up, since the vault syncs.
- **The signature:** ECDSA over the authenticator data followed by the client data hash, DER-encoded. The core signs with RFC 6979's deterministic nonces, so the vectors can fix the bytes.
- **The client data hash:** iOS always gives it, and so does Android for a browser. For another Android app the provider builds the client data itself (`webauthn.get`, the site's challenge, and the app's origin, `android:apk-key-hash:` and its signing certificate's SHA-256). It does that only after the site's Digital Asset Links say that app may use its passkeys (below).
- **The counter, as upstream:** a passkey whose counter is 0 stays at 0, since a synced passkey can't keep one counter across devices and sites accept 0. One with a counter above 0 has it raised and the login saved before the signature goes back. Offline it's refused, rather than sign with a counter the site has already seen.
- **Asking for the master password again:** a login that asks for it asks before its passkey signs, as for its password, and that counts as the person proving who they are.
- **When a site wants proof of who it is** (`userVerification: required`) and the person didn't just give it, the provider asks for Face ID, a fingerprint, or the master password first.

**Making one** (WebAuthn's `authenticatorMakeCredential`):

- **The key:** a new P-256 key from the OS's random numbers; the credential ID is a new random UUID.
- **Attestation "none":** `{"fmt": "none", "attStmt": {}, "authData": ...}` in CBOR, the authenticator data carrying the attested credential data: PassBundle's AAGUID, the credential ID's length and the ID, and the public key as a COSE key (`{1: 2, 3: -7, -1: 1, -2: x, -3: y}`).
- **PassBundle's AAGUID:** `09c5ee5f-0845-48e6-aef4-c7c443317de5`, made at random for this design. The browser extension still uses upstream's for now.
- **Where it goes:** into the login the person picks, or a new login named after the site, with the site as its website and the account's name as its username. A new login follows the same rules as one made in the editor: the personal vault, or a collection where an organization's policy says so.
- **It's saved before the site hears of it.** Offline, it's refused, so a site never holds a passkey the vault lost.
- **A site's list of passkeys it already has** (`excludeCredentials`): if one of them is in the vault, nothing is made, and the person is told they have one there, as the spec has it.

**Tests,** when it's built:

- **Vectors:** a fixed P-256 key, site ID, client data hash, counter, and flags. The authenticator data and the signature are fixed bytes (RFC 6979), and Node's own crypto verifies the signature with the public key.
- **Upstream's format:** the vectors' `keyValue` opens with WebCrypto's PKCS#8 import, as upstream's authenticator reads it, and the passkey's strings open with upstream's `PureCrypto`.
- **Making one:** the attestation object is read back with an independent CBOR reader, its COSE key matching the private key.
- **Both ways with the browser extension:** a real-server test makes a passkey in our extension on a test page and signs in with it from the core, and the other way round. The test page checks each with its own WebAuthn verifier.
- **Phones:** the emulator and simulator tests sign in to a test app and a test page with a passkey, and make one.

## Speed

The KDF is most of unlocking. On ARM (Apple silicon, phones) the core uses the chip's SHA-256 instructions, so PBKDF2 at 600,000 iterations takes about 46 ms on an M1 Pro instead of 288. x86 uses its own SHA extensions.

## Not yet

Sends, organization admin, the MSP console (the web vault keeps it), importing, and passkeys on computers (the browser extension has them there). Each gets designed when it's next.
