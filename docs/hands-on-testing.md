# Hands-on testing before launch

What CI can't check: real devices, real sites, and how it feels. Work through it on test.passbundle.com with the newest builds (the web vault and the Mac's extension update themselves; the Android, Mac, Windows, and Linux apps offer each release in Settings, Updates). When something's off, note the platform, what you did, what you expected, and a screenshot; "it feels clunky" is useful too.

## Set up once

- [ ] **Brave or Chrome:** remove the old PassBundle, then Load unpacked from `~/Library/Application Support/PassBundle/extension-chrome` (Cmd+Shift+G to paste the path). Sign in with `test.passbundle.com`.
- [ ] **Pixel:** uninstall the old app, install the newest `passbundle-...-arm64-v8a.apk` from https://github.com/PimpinPumpkin/passbundle-apps/releases, sign in.
- [ ] **Mac app** (macOS 14 or later): the newest "PassBundle ... for Mac" zip from the same page into Applications; first open needs System Settings > Privacy & Security > Open Anyway.
- [ ] **Windows app:** the newest "PassBundle ... for Windows" zip from the same page. Unzip it, move the `PassBundle` folder to `%LOCALAPPDATA%\Programs` (paste that into File Explorer's address bar), and open `passbundle.exe` in it; pin it to Start if you like. SmartScreen stops the first open (it isn't code-signed yet): More info, then Run anyway.
- [ ] **Linux app:** the newest "PassBundle ... for Linux" tarball for your computer (`linux-x64`, or `linux-arm64` for ARM), then `mkdir -p ~/.local/opt && tar -xzf PassBundle-*-linux-x64.tar.gz -C ~/.local/opt` and open `~/.local/opt/PassBundle/passbundle` (it needs GTK 3).
- [ ] **Updating a computer's app:** when a new release is out, Settings > Updates > Check for updates, then "Update to ...": the Mac, Windows, and Linux apps restart as the new version (locked). Once, try it with the app's folder somewhere you can't change (Program Files, `/opt`): it should only say there's a new version.
- [ ] **A second person** (or a second email of yours): invite them from an organization's Members page so you can test sharing and offboarding. The test server is invite only.

## Every day things

- [ ] **Sign in** on each: web vault, extension, Pixel, Mac app. Typing `test.passbundle.com` without https:// works.
- [ ] **Unlock** with fingerprint on the Pixel (it should offer to turn it on after your first sign-in) and with the master password elsewhere. Lock after the timeout you set.
- [ ] **New item:** a login, a card, a note, and one from a template (Wi-Fi, server). Icons and colors match across web, extension, phone, and Mac.
- [ ] **Search** finds items by name, username, and website.
- [ ] **Generator:** default 20 characters; change the length on one device and see it follow you to another.
- [ ] **Screenshots** on the Mac and Windows: a screenshot (Cmd+Shift+4 then Space, or Win+Shift+S) and a screen shared in a video call leave PassBundle's window out. Settings > "Allow screenshots of PassBundle" lets them take it; off again, they don't.
- [ ] **Sign in with a device:** in a browser where you've signed in before, sign out of the web vault (or the extension), type your email, and choose "Sign in with a device". The Mac app (and the Pixel, with PassBundle open) shows "Approve sign-in?" within about 10 seconds: check its fingerprint phrase matches the browser's, approve with Touch ID, your fingerprint, or your master password, and the browser signs in. Try Deny once too, and leave one to expire (15 minutes): it should disappear.
- [ ] **Command-line tool:** install the newest `cli-v` release for your Mac (docs/cli.md, "Install"), `passbundle config server https://test.passbundle.com`, sign in with your API key (web vault, Settings, Security, Keys), unlock, then `passbundle list items` and `passbundle get password` on one of your logins. As your second person, `get password` on an item in their "Can view but not see passwords" folder is refused, and `get item` shows it without the password.

## Autofill (the part people judge us on)

On a real computer and the Pixel, with logins saved for each:
- [ ] Your bank, your email (Gmail, Outlook), Microsoft 365 sign-in (email first, password on the next page), a site with a separate username and password page, a site with 2FA codes (the code fills or copies).
- [ ] Your router's admin page (an IP address).
- [ ] **Open and fill:** in the extension, the open button beside a login (or Open and fill beside a website in the item's page) opens the site in a new tab and fills it, once. Reload: it doesn't fill again. A login set to ask for the master password asks before the tab opens.
- [ ] **Change password on the site:** on an account you can afford to lock yourself out of (a throwaway one, not your bank or email), Change password on the login's page in the extension. It opens the site's change-password page, saves a new password to the item first, fills in the form, and submits it. Sign in with the new password to check. On a site with a CAPTCHA or a code, it fills the form and asks you to finish. When the item asks "Did the new password work?", answer it, and try "Put the old password back" once. Note any site where it couldn't find the form.
- [ ] A site you've never saved: after you sign in, PassBundle offers to save it, in our colors.
- [ ] Android apps: your bank's app, a social app, one that signs in with a WebView.
- [ ] Passkeys: create one on a site that offers it (passkeys.io, or your Google/Microsoft account if you're willing), then sign in with it.
- [ ] Note any site where the menu doesn't appear, fills the wrong field, or needs two clicks. These go into the autofill scoreboard.

## iPhone (once there's an Apple Developer account)

CI runs the iPhone app and the AutoFill extension's own code on a simulator, but iOS lets a password manager into AutoFill only in a build signed with a provisioning profile, and Face ID, NFC, and push only on a real iPhone (docs/phones.md, "Not yet"). With a TestFlight build:
- [ ] **Face ID:** sign in, accept "Unlock with Face ID next time?", lock, and unlock with Face ID. It asks by itself as PassBundle opens locked. Add a second account (Settings, Accounts) and turn Face ID on for it too: each unlocks on its own.
- [ ] **Turn on AutoFill:** after unlocking, "Turn on AutoFill" opens Settings at AutoFill & Passwords; switch PassBundle on, come back, and the sheet says it's on.
- [ ] **Filling:** in Safari, on a site you have a login for, the keyboard's bar suggests it; picking it asks for Face ID and fills. With two accounts, the key icon's list shows each unlocked account's logins, labeled, and "Other accounts" unlocks the rest. In an app with a sign-in form, the same.
- [ ] **Passkeys:** on passkeys.io (or a site that offers them), make a passkey: iOS asks where to save it, PassBundle names the site, asks which account with two unlocked, and saves it. Sign out of the site and sign in with it from iOS's sheet.
- [ ] **Screen recording:** start one from Control Center with PassBundle open: the vault is covered, saying why, until the recording stops.
- [ ] **Locking:** with "When the phone locks" on, lock the phone with PassBundle open: it's locked when you come back.
- [ ] **Two-step login:** a YubiKey 5Ci or a USB-C YubiKey types its code into the field; a security key says the iPhone can't use one yet and offers the other ways; Duo opens in iOS's sign-in sheet and comes back by itself.

## Bringing passwords over

- [ ] Each file in `~/Documents/PassBundle-demo/fake-exports/`, through the sign-up screen's import tiles and Tools > Import. Spot-check a few items against the README's notes.
- [ ] **Your real browser's passwords** in a fresh account (Chrome, Brave, Safari through the Mac's browser import): counts match, nothing doubled, folders sensible. Delete the account afterwards if you like.

## Sharing, permissions, offboarding (the MSP part)

- [ ] Make an organization, two shared folders, a group; give your second person "Can view but not see passwords" in one and "Can edit" in another. Check what they see on the web and the extension.
- [ ] Try a **Custom** grid: edit without delete; check delete is refused.
- [ ] **Access page:** who can open what, by person and by folder.
- [ ] **Remove your second person:** the confirmation says what they had, then the "Passwords they could see" list appears; open one and change it.
- [ ] **Item history:** change a password twice, open History, compare, restore the first.
- [ ] **Account recovery:** as the organization's admin, reset your second person's master password; they sign in with the new one.
- [ ] **Two-step login in the apps** (DESIGN.md, "Two-step login in the apps"): add a security key in the web vault (Settings, Security, Two-step login), then sign in with it in each app: the Mac and Linux with it plugged in (touch it when it blinks), Windows through its own dialog, and the Pixel both ways (held to the back, and plugged in with a USB-C key, allowing PassBundle to use it). The iPhone says it can't yet. Cancel while it waits. If you have a YubiKey with its one-time code, add it as YubiKey too and sign in by touching it (and on the Pixel, by holding it to the back). With a Duo account, add Duo and sign in with "Continue with Duo" on each: the browser opens, you approve, and the app finishes by itself (on Windows and Linux the browser may ask to open PassBundle first). Last, sign in once with your recovery code: the app says two-step login is off now; turn it back on in the web vault.
- [ ] **Two-step login for admins:** make your second person an admin of a Business organization while they have no authenticator app (or only email codes). If they're signed in somewhere, that session ends as you save. They sign in on the web: "Set up two-step login to continue" with a QR code; scan it with a real authenticator app (and once, a security key or passkey), save the recovery code, and sign in with the code. In the extension and the Pixel before they set it up, the message says to use the web vault. The organization's Settings, Joining and security, lists them until they're done.
- [ ] **MSP console:** add a client, look at its health numbers, push a template, check the activity log, and check Seats against the clients' people, then download its CSV and open it in your spreadsheet.
- [ ] **Event log** shows what you just did.
- [ ] **Event streaming** (Reporting > Event streaming, and the MSP console's section): send events to a real SIEM you have (Huntress, Blumira, or a Sentinel workspace, set up as docs/event-streaming.md says), press Test, do something in the organization, and find both in the SIEM.

## When Microsoft 365 is ready

- [ ] Provisioning: a client's Settings > Provisioning; paste the URL and token into an Entra enterprise app; add a test user in Entra, see them appear waiting; "Let them in"; turn them off in Entra and see them revoked.
- [ ] Single sign-on: register the app and set up a client's Settings > Single sign-on with docs/sso-entra.md, verify your domain, then work through its "Checking it with a real tenant" list (Link SSO and its confirmation, sign in and unlock, Require single sign-on with a member not linked yet, recovery, a refused user).

## How it feels

- [ ] Light and dark on each platform. Anything hard to read, misaligned, or still looking like Bitwarden.
- [ ] Phone at a small size and with large text.
- [ ] Anything that took you longer than it should have.
