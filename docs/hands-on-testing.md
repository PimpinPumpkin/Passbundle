# Hands-on testing before launch

What CI can't check: real devices, real sites, and how it feels. Work through it on test.passbundle.com with the newest builds (the web vault and the Mac's extension update themselves; Android and the Mac app offer each release in Settings, Updates). When something's off, note the platform, what you did, what you expected, and a screenshot; "it feels clunky" is useful too.

## Set up once

- [ ] **Brave or Chrome:** remove the old PassBundle, then Load unpacked from `~/Library/Application Support/PassBundle/extension-chrome` (Cmd+Shift+G to paste the path). Sign in with `test.passbundle.com`.
- [ ] **Pixel:** uninstall the old app, install the newest `passbundle-...-arm64-v8a.apk` from https://github.com/PimpinPumpkin/passbundle-apps/releases, sign in.
- [ ] **Mac app:** the newest "PassBundle ... for Mac" zip from the same page into Applications; first open needs System Settings > Privacy & Security > Open Anyway.
- [ ] **A second person** (or a second email of yours): invite them from an organization's Members page so you can test sharing and offboarding. The test server is invite only.

## Every day things

- [ ] **Sign in** on each: web vault, extension, Pixel, Mac app. Typing `test.passbundle.com` without https:// works.
- [ ] **Unlock** with fingerprint on the Pixel (it should offer to turn it on after your first sign-in) and with the master password elsewhere. Lock after the timeout you set.
- [ ] **New item:** a login, a card, a note, and one from a template (Wi-Fi, server). Icons and colors match across web, extension, phone, and Mac.
- [ ] **Search** finds items by name, username, and website.
- [ ] **Generator:** default 20 characters; change the length on one device and see it follow you to another.

## Autofill (the part people judge us on)

On a real computer and the Pixel, with logins saved for each:
- [ ] Your bank, your email (Gmail, Outlook), Microsoft 365 sign-in (email first, password on the next page), a site with a separate username and password page, a site with 2FA codes (the code fills or copies).
- [ ] Your router's admin page (an IP address).
- [ ] A site you've never saved: after you sign in, PassBundle offers to save it, in our colors.
- [ ] Android apps: your bank's app, a social app, one that signs in with a WebView.
- [ ] Passkeys: create one on a site that offers it (passkeys.io, or your Google/Microsoft account if you're willing), then sign in with it.
- [ ] Note any site where the menu doesn't appear, fills the wrong field, or needs two clicks. These go into the autofill scoreboard.

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
- [ ] **MSP console:** add a client, look at its health numbers, push a template, check the activity log.
- [ ] **Event log** shows what you just did.
- [ ] **Event streaming** (Reporting > Event streaming, and the MSP console's section): send events to a real SIEM you have (Huntress, Blumira, or a Sentinel workspace, set up as docs/event-streaming.md says), press Test, do something in the organization, and find both in the SIEM.

## When Microsoft 365 is ready

- [ ] Provisioning: a client's Settings > Provisioning; paste the URL and token into an Entra enterprise app; add a test user in Entra, see them appear waiting; "Let them in"; turn them off in Entra and see them revoked.

## How it feels

- [ ] Light and dark on each platform. Anything hard to read, misaligned, or still looking like Bitwarden.
- [ ] Phone at a small size and with large text.
- [ ] Anything that took you longer than it should have.
