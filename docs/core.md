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
| Refresh token | the OS's secret store: Keychain (macOS, iOS), Credential Manager (Windows), Secret Service (Linux), Keystore (Android) |
| Access token | memory only |
| (Where) | the OS's local app data folder, in `PassBundle`: `AppData\Local` on Windows, `Application Support` on macOS, `~/.local/share` on Linux. Files are readable only by the person (mode 600 where the OS has modes). The secret store entry is service `PassBundle`, account `<email> on <server>`. |
| Master password, master key, user key, private key, organization keys, anything decrypted | memory only, while unlocked; never on disk |

- **No secret store** (a Linux desktop without a keyring running): nothing is kept. The vault still unlocks from this device, and the app asks to sign in again to sync.
- **Signing out** forgets the kept sync and the refresh token; the server and email stay, to sign in again.
- **Unlock with Windows Hello or Touch ID** comes later, with its own design. On the desktop it should be the same enrollment the desktop agent already makes for the extension, so unlocking one unlocks the other.
- **"Never lock"** (keeping the user key on disk) isn't offered.

## Memory

- Keys and decrypted secrets live in types that wipe themselves when dropped (`zeroize`).
- Locking drops them all, along with every decrypted item. The app locks after the timeout the person or a policy sets, and when the computer sleeps or the screen locks, if they choose.
- **Secrets stay out of Dart.** The screens get what they draw: names, usernames, websites, folders. A password, a one-time code secret, or a hidden field reaches Dart only while the person has it revealed on screen. Copying never passes through Dart: the core puts the value on the clipboard itself, and clears it after 30 seconds if it's still there (never something copied since). It's marked to stay out of clipboard history, the cloud clipboard, and clipboard monitors on Windows, and out of clipboard managers on macOS (`org.nspasteboard.ConcealedType`); Linux under X11 has no such mark. Dart's strings can't be wiped, so this keeps secrets in Rust's memory, which can. The exceptions are what the person types or edits: the master password passes through Dart once (the field is cleared as soon as the core has it), and an item's secrets pass through Dart while its editor is open, as typing them would.

## The bridge to the app

The Flutter app calls the core through plain C functions (`core/src/ffi.rs`), with JSON in and out, rather than a code generator such as flutter_rust_bridge: fewer moving parts, and every call is visible in one file.
- Each call is a command ("unlock with this password", "search for this", "copy this item's password") and gets back plain data for the screen. No key ever crosses the bridge, and no call takes or returns key material.
- Calls that take a while (signing in, unlocking, syncing, saving) run on a background isolate, and the screens don't read from the core while one runs.

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
- **Next:** the web vault reads what the core wrote, and the core reads what the web vault wrote.

## New passwords

The generator draws characters uniformly with the OS's random numbers from the kinds chosen (upper and lower case, digits, symbols), with at least one of each, and leaves out look-alikes (0 O, 1 l I) unless asked. The default is 20 characters.

## Speed

The KDF is most of unlocking. On ARM (Apple silicon, phones) the core uses the chip's SHA-256 instructions, so PBKDF2 at 600,000 iterations takes about 46 ms on an M1 Pro instead of 288. x86 uses its own SHA extensions.

## Not yet

Unlock with biometrics, passkeys, attachments, Sends, organization admin, the MSP console (the web vault keeps it), autofill on phones and in browsers, and importing. Each gets designed when it's next.
