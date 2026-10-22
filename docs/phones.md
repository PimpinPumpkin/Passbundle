# The phone apps

Design, October 21, 2026. The phone apps are the desktop app's Flutter screens and the same core (`docs/core.md`), on Android and iOS. Phones keep keys and tokens differently from computers, unlock with the phone's own biometrics, and fill other apps through the OS's autofill. All of that handles keys, so per the rule in DESIGN.md, this note comes before the code.

## What's the same

- **The screens.** One Flutter app; the phone layout already exists (the narrow window: a header, the list, an item on its own page).
- **The core.** The same Rust library, built for each phone's chip. Everything in `docs/core.md` holds: the format and its vectors, signing in, sync, the kept vault, HTTPS only, secrets staying in Rust's memory where they can be wiped, and the bridge (plain C functions, JSON in and out).
- **The look.** Our own design, not each OS's. The one exception is what the OS draws itself: the biometric prompt, and the autofill and password suggestions lists.

## The core on phones

- **Android:** a shared library (`libpassbundle_core.so`) for `arm64-v8a`, plus `x86_64` for the emulator, built with the Android NDK and packed into the app. No 32-bit ARM: Google Play has required 64-bit since 2019, and business phones are.
- **iOS:** a static library in an XCFramework, for devices (`arm64`) and the simulator (`arm64`), linked into the app and its autofill extension. Dart finds it in the process (`DynamicLibrary.process()`).
- **The data folder** is the app's own: on Android the app's private files folder, which the app passes to the core at start (`pb_open`); on iOS an App Group container, so the autofill extension reads the same kept vault.

## Kept where

| What | Android | iOS |
|---|---|---|
| Server, email, KDF settings, the last sync (secrets still encrypted), lock choices | the app's private files folder | the App Group container |
| Refresh token | encrypted with a key in the Android Keystore that never leaves it (AES-256-GCM, this app only, not backed up), in the app's private files | the Keychain, this device only, after first unlock (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`), in a keychain group the extension shares |
| The user key, for biometric unlock (below) | encrypted with a Keystore key that needs the person's biometrics for each use | the Keychain, readable only after Face ID or Touch ID with the biometrics enrolled now (`biometryCurrentSet`), this device only |
| Master password, master key, private key, organization keys, anything decrypted | memory only, while unlocked | memory only, while unlocked |

- **Backups:** the app's backup rules leave its files out of Android's backups (auto-backup would include them otherwise), Keystore keys never leave the phone, and the iOS Keychain items are "this device only". The kept sync is still encrypted, so a backup of it alone would open nothing anyway.
- **"Never lock"** (keeping the user key without biometrics) isn't offered, as on the desktop.

## Talking to the OS

The core needs a few things only the OS's own APIs do on phones: the Keystore, the Keychain with biometrics, the clipboard, and autofill. Each phone app has a small native piece, Kotlin on Android and Swift on iOS, with plain functions the core calls:

- `seal(bytes) -> bytes` and `open(bytes) -> bytes` with the app's Keystore key (Android; on iOS the Keychain does this);
- `copy(text, sensitive, clear_after)`;
- on Android, the autofill service's calls into the core (below).

On Android the core reaches Kotlin through JNI; on iOS Swift hands the core C function pointers at start. Dart isn't in the path, so secrets stay out of Dart as on the desktop. Kotlin's and Swift's strings can't be wiped either, so a secret is only put into one where the OS takes nothing else (the clipboard, an autofill value), and byte arrays are zeroed after use.

## Unlocking with biometrics

The phone's own fingerprint or face unlock, standing in for the desktop agent's Windows Hello. It changes how the user key is kept, so the rules:

- **Turning it on**, while unlocked, in Settings: "Unlock with fingerprint" (Android) or "Unlock with Face ID" (iOS).
  - **Android:** a new AES-256-GCM key in the Keystore that needs the person's strong biometrics for every use (`setUserAuthenticationRequired`, `BIOMETRIC_STRONG`), is invalidated when someone adds a fingerprint or face (`setInvalidatedByBiometricEnrollment`), and is in StrongBox where the phone has one. The OS asks for the biometric (`BiometricPrompt` with the key's cipher), the user key is encrypted with it, and the result is kept in the app's files.
  - **iOS:** the user key goes in the Keychain with access control `biometryCurrentSet`, this device only.
- **Unlocking:** the lock screen offers it when it's on. Android asks for the biometric and decrypts the user key with the Keystore key; iOS reads the Keychain item, which asks for Face ID or Touch ID. The core opens the kept vault with the user key, without the KDF, as with Windows Hello.
- **The key goes from the OS's code to the core directly:** Kotlin or Swift hands the bytes to the core's native function and zeroes them; it never passes through Dart.
- **Someone adds a fingerprint or face:** the OS invalidates the key, the app can't decrypt, it turns biometric unlock off and asks for the master password once. The same if the account's keys change (the user key no longer opens the vault), as on the desktop.
- **Signing out and turning it off** delete the key and the kept user key.
- **The master password always works.**

## Copying

- **Android:** Kotlin takes the value from the core (the screen asks Kotlin to copy an item's field; the value never passes through Dart) and puts it on the clipboard marked sensitive (`ClipDescription.EXTRA_IS_SENSITIVE`, Android 13 and later), so the keyboard's clipboard preview and the system's copy notice don't show it. After 30 seconds it clears it if it's still ours. Android hides the clipboard from apps in the background, so there the app can't tell what's on it, and it clears it anyway: the 30 seconds are the promise.
- **iOS:** Swift puts it on the pasteboard for this device only (`localOnly`, so not Universal Clipboard) with a 30-second expiry (`expirationDate`), which iOS enforces even if the app is suspended.

## Autofill

The part that's most of the work, and native, because each OS draws its own lists.

**Android: an autofill service** (`AutofillService`), in Kotlin, in the app's own process.
- The OS asks it to fill a sign-in screen in another app or in a browser. The service asks the core for logins matching the app's package name or the page's domain, with the same matching rules as the extension (the item's websites and its Android app URIs, `androidapp://<package>`). It answers with datasets: the item's name and username, which the OS shows in its list. The password goes into a dataset only when the person picks it, through an authentication step (below).
- **Locked:** one entry, "Unlock PassBundle". With fingerprint or face unlock on, picking it asks for that and then offers the logins, without leaving the app being filled. Otherwise it opens PassBundle to unlock with the master password, and the person fills again.
- **Which logins:** the core decides (`core/src/matching.rs`), by the rules the web vault and the extension use. Each of an item's websites can be set to match by its registrable domain (the default, by the Public Suffix List, so `a.github.io` never fills on `b.github.io`), its host, or never. The rules that need a page's whole address (starts with, exact, regular expression) aren't offered, since Android gives only the domain. Editing an item in the app keeps each website's setting.
- **Saving:** when the person signs in with something new, Android offers to save it to PassBundle. Accepting opens the app (unlocking first, if it's locked) to the editor, with the name, username, password, and the site or the app's `androidapp://` link filled in; nothing is saved until they tap Save. A new password for a login it has (one login for the same app or site, by the rules autofill fills with, with the same username) opens that login instead, with the new password, so changing a password doesn't make a second login. The sign-in stays in the app's process (autofill runs there), and Android's offer only opens the app, so no other app can hand the editor a sign-in. Android 14 before its March 2024 update can stop the app from opening itself there; then the sign-in waits, for up to 10 minutes, for the person to open PassBundle.
- **Apps aren't websites:** an app's package name matches an item only through the item's own `androidapp://` URI or the app's verified link to a website (Digital Asset Links), never a lookalike name. Browsers that pass the page's domain to autofill (Chrome since version 135, with its "autofill using another service" setting) fill by domain.
- **The core stays in the process:** the service runs in the app's process, so it shares the unlocked core with the app. When the app is locked, so is autofill.

**iOS: a Credential Provider extension** (`ASCredentialProviderViewController`), in Swift.
- It's a separate process with a tight memory limit, so it doesn't run Flutter. Its few screens (the matching logins, and the unlock screen) are native SwiftUI, drawn in our design.
- It links the same core, reads the kept vault from the App Group, and unlocks on its own (Face ID makes that quick), because it can't share the app's memory.
- **Suggestions above the keyboard:** after each sync the app gives iOS the list of websites and usernames (`ASCredentialIdentityStore`), never passwords, so iOS can suggest a login; picking one asks Face ID and fills it without showing our screen.
- **Passkeys** come later, in the same extension.

## Locking

- **Lock after a time away:** phones have no "idle time" for the whole device, so the wait counts from when the app leaves the screen. The choices are the desktop's (1, 5, 15, or 30 minutes, 1 or 4 hours), plus "Immediately", which phones' password managers offer because people switch apps all the time. The default is 5 minutes.
- **When the phone locks** (on by default): Android's screen-off broadcast; iOS's notice that protected data is about to become unavailable.
- **Back in front:** the app checks the wait the moment it's shown again, before the vault is in front of anyone.
- **Out of screenshots:** the vault stays out of screenshots, screen recordings, and the app switcher's preview (`FLAG_SECURE` on Android).
- **On Android, autofill follows the app's lock;** on iOS the extension locks when it closes.

## Order and tests

1. **Android first:** its emulator runs in CI on Linux, autofill included.
   - The core built for Android, and its tests run on the emulator (the test programs pushed with `adb`).
   - The app on the emulator: sign in, unlock, browse, copy, lock.
   - Then the Keystore, biometric unlock, and the autofill service, each with tests on the emulator.
     - Biometric unlock: debug builds have a stand-in for Android's prompt that says yes, with a Keystore key that needs no biometrics, as the desktop agent's test authenticator does. Release builds refuse it. Everything but the OS prompt is tested: sealing the user key, unlocking with it, and signing out removing it. The real prompt gets checked by hand on a real phone, because enrolling a fingerprint on an emulator means typing a PIN into Android's own prompt.
     - Autofill is driven with a small test app that has a sign-in form (`app/android/autofilltest`): PassBundle, signed in and locked with biometric unlock on, offers to unlock, then the login, and fills the form.
2. **iOS second:** CI's Macs build it and run it in the simulator, with simulated Face ID enrollment and matches. The extension is tested with the simulator's Settings turning it on.
3. **Real phones:** a check by hand at each release, as for Windows Hello. Store listings, signing keys, and the Apple Developer account are the owner's.

## Not yet

Passkeys, Wear OS and watchOS, tablets' own layout (they get the desktop layout when wide enough), and sharing from other apps into a new item.
