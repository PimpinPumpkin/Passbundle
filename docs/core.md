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

- Our server and apps don't make item keys today; the core reads them so an item that has one still opens.
- It writes items without item keys, like the other apps, until they all do.

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
- **Not yet:** a longest wait an organization sets by policy, which MSPs will want. Upstream's server leaves that policy out of its open-source build, so ours gets designed and built in full: the server, a policy page in the web vault, and the apps keeping to it.

## The bridge to the app

The Flutter app calls the core through plain C functions (`core/src/ffi.rs`), with JSON in and out, rather than a code generator such as flutter_rust_bridge: fewer moving parts, and every call is visible in one file.
- Each call is a command ("unlock with this password", "search for this", "copy this item's password") and gets back plain data for the screen. No key ever crosses the bridge, and no call takes or returns key material.
- Calls that take a while (signing in, unlocking, syncing, saving) run on a background isolate, and the screens don't read from the core while one runs.

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

The generator draws characters uniformly with the OS's random numbers from the kinds chosen (upper and lower case, digits, symbols), with at least one of each, and leaves out look-alikes (0 O, 1 l I) unless asked. The default is 20 characters.

## Speed

The KDF is most of unlocking. On ARM (Apple silicon, phones) the core uses the chip's SHA-256 instructions, so PBKDF2 at 600,000 iterations takes about 46 ms on an M1 Pro instead of 288. x86 uses its own SHA extensions.

## Not yet

Unlock with biometrics, passkeys, attachments, Sends, organization admin, the MSP console (the web vault keeps it), autofill on phones and in browsers, and importing. Each gets designed when it's next.
