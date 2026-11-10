# Hands-on testing before launch

What CI can't check: real devices, real sites, real accounts, and how it feels. Work through it on https://test.passbundle.com with the seeded test tenants (tools/test-tenants/README.md) and the newest builds. The web vault comes with the server; the Mac's extension updates itself; the Android, Mac, Windows, and Linux apps offer each release in Settings, Updates.

There are two ways through it. Section 2 goes persona by persona: sign in as one person and work down their list. Section 3 goes app by app, so every app is covered. Section 4 needs real hardware or real accounts, section 5 waits on email, and section 6 lists what isn't built yet, so you don't chase it. When something's off, see section 8.

- Each step says what to do, as whom, and what should happen. Personas are named as in the README; their emails and passwords are only in the credentials file (below).
- "(changes the seed)" marks a step that leaves a person or organization different from the README. Do those after the rest of that section, and run `reset` when you're done with them (see "Before a reset").
- Note the time with each result: the server can change under you (see the first step below).

## 1. Set up once

### The test server

- [ ] **What it is:** https://test.passbundle.com, updated automatically to main's newest green build within about 15 minutes of each merge. If something changes mid-test, check whether a merge just landed before reporting it. The apps, the extension, and the CLI don't follow it: they update from their own releases, so an app can be a version behind or ahead of the server.
- [ ] **Invite only:** nobody can make an account without an invitation. New people get in from an organization's Members page, the MSP console's Staff section, or provisioning; an invited address may sign up.
- [ ] **No email:** it sends none. So account recovery isn't offered, invitations aren't mailed, joins from invitations wait for an owner's or admin's approval on the Members page, and email codes and email domain limits can't be tried. Everything that needs email is in section 5.
- [ ] **New-device check is on.** The seeded accounts have only ever signed in from the seeding tool, as a command-line tool, which can't approve. So your first sign-in as each person goes straight through. After that, a device that person hasn't used shows a two-digit number and waits until you type it on one of their signed-in devices (the web vault, the extension, or an app, unlocked). People with an authenticator app aren't asked.
- [ ] **Make each first sign-in count:** for people without two-step login, sign in first on a device you'll keep (a normal browser profile, not a private window). Any web vault, extension, or app that finished a sign-in in the last 30 days (90 for a phone) counts as one that can approve, signed out or not. If none of them is in reach, the only way through on this server is "Can't use your other devices?", which lets the sign-in through after 24 hours. Signing out and back in on the same device isn't a new device.
- [ ] **The seed:** the test-tenants tool (README "Running it") made everything; `status` says whether it's all there, and `reset` tears it down and makes it again. Run it from the meta repo with `--server https://test.passbundle.com --test-server`.

### People, passwords, and codes

- [ ] **Credentials:** every persona's email, master password, authenticator key, and two-step recovery code are in `~/Documents/PassBundle-test-tenants/test.passbundle.com/credentials.md`, readable only by you. Copy from it; never paste its contents into a report or a screenshot.
- [ ] **Two-step codes:** `node tools/test-tenants/test-tenants.ts code <person> --server https://test.passbundle.com --test-server`, with the first name in lowercase (`code grace`), prints that person's current code. To use someone's codes on a phone instead, add their authenticator key from the credentials file to an authenticator app.
- [ ] **Who has what:**
  - Authenticator app: all of Harbor IT's staff (Maya Chen, Owen Brooks, Theo Ramirez, Priya Shah, Sam Whitfield), the owners and admins of the clients that require it (Grace Liu, Marcus Reed, Elena Rossi, Noah Bennett, Ravi Menon, Frank Delgado, Rosa Martinez), and Lena Fischer, Aisha Patel, Chloe Martin, Ivy Park, Diego Rivera.
  - No two-step login (so the new-device check and the nudge apply): Tom Alvarez, Liam Walsh, Jess Taylor, Kai Anderson, Mike O'Neill, Dana Kowalski, Luis Ortega, Nora Feld (Summit Accounting's owner: no rule there asks for it), Paul Grant, Carmen Rivera, Sofia Rivera, Alex Morgan.
  - Revoked: Ben Carter (Northwind Dental), Greg Hollis (Pinecrest Construction). Invited, no account: Jordan Blake, Casey Nguyen, Marisol Rivera.
- [ ] **Recovery codes:** don't use one unless a step says so. Signing in with it turns that person's two-step login off, and `code` stops working for them.
- [ ] **Before a reset:** the tool signs in as each person to tear down. Undo what it can't sign through first: turn off two-step login you added to someone who had none (web vault, Settings, Security, Two-step login), and delete accounts you made by hand (Casey, Marisol, Jordan, provisioned people) in their web vault (Settings, My account, Delete account). Someone whose master password you changed is left behind and named by teardown.

### Devices and apps

- [ ] **Brave or Chrome:** remove the old PassBundle, then Load unpacked from `~/Library/Application Support/PassBundle/extension-chrome` (Cmd+Shift+G to paste the path). At "Where's your vault?" choose Self-hosted and type `test.passbundle.com` (the hint says it adds https://).
- [ ] **Edge:** edge://extensions, turn on Developer mode, Load unpacked from the same folder, then sign in the same way.
- [ ] **Firefox:** there's no download of the Firefox build yet (CI builds and checks it but doesn't keep it). Build it in passbundle-clients (`npm run build:prod:firefox` in apps/browser, after branding), then about:debugging, This Firefox, Load Temporary Add-on, and pick its manifest. It's gone when Firefox restarts. Firefox has the least automated coverage of the three, so it's worth the most by hand.
- [ ] **A second browser profile** (Chrome's profile menu), so two personas can be signed in side by side for sharing, offboarding, and approval steps.
- [ ] **Pixel:** uninstall the old app (a copy signed with another key, such as a debug build, has to go first), install the newest `passbundle-<version>-arm64-v8a.apk` from the newest `android-v` release at https://github.com/PimpinPumpkin/passbundle-apps/releases, then on the sign-in screen tap "Self-hosted?" and type `test.passbundle.com` in Server.
- [ ] **Mac app** (macOS 14 or later): the newest "PassBundle ... for Mac" zip (`PassBundle-<version>-macos.zip`) from the same page into Applications. On macOS 15 and later, the first open needs System Settings > Privacy & Security > Open Anyway; on macOS 14, Control-click the app and choose Open. If the keychain asks about an older copy, choose Always Allow.
- [ ] **Windows app:** the newest "PassBundle ... for Windows" zip from the same page. Unzip it, move the `PassBundle` folder to `%LOCALAPPDATA%\Programs` (paste that into File Explorer's address bar), and open `passbundle.exe` in it; pin it to Start if you like. SmartScreen stops the first open (it isn't code-signed yet): More info, then Run anyway.
- [ ] **Linux app:** the newest "PassBundle ... for Linux" tarball for your computer (`linux-x64`, or `linux-arm64` for ARM), then `mkdir -p ~/.local/opt && tar -xzf PassBundle-*-linux-x64.tar.gz -C ~/.local/opt` and open `~/.local/opt/PassBundle/passbundle` (it needs GTK 3).
- [ ] **iPhone:** nothing can go to a real iPhone until the Apple Developer account exists (docs/prelaunch.md, "Waiting on you"). Until then, use the iPhone simulator on the Mac: in passbundle-apps, `tools/ios-core.sh build`, then `flutter run` in `app/` with a simulator booted (tools/ios-app-test.sh shows the steps; it needs Xcode, Flutter, and the Rust iOS targets).
- [ ] **Command-line tool:** install the newest `cli-v` release for your Mac (docs/cli.md, "Install"). If there's no `cli-v` release yet, run the "CLI release" workflow in this repo's Actions first. Then `passbundle config server https://test.passbundle.com` (its default, vault.passbundle.com, serves nothing yet).
- [ ] **Every app's default server** is vault.passbundle.com, which serves nothing yet: point each one at the test server by hand, every time you add an account.
- [ ] **Updating a computer's app:** when a new release is out, Settings > Updates > Check for updates, then "Update to ...": the Mac, Windows, and Linux apps restart as the new version (locked). Once, try it with the app's folder somewhere you can't change (Program Files, `/opt`): it should only say there's a new version, and why.

### Before the MSP and template steps

- [ ] **Confirm each client:** as Maya Chen (Harbor IT MSP admin), open the web vault's MSP console. Every client's row shows "Confirm client": the seeding tool can't make the client seals, which only an MSP admin's browser makes. Leave Summit Accounting unconfirmed for now (it's used to see what waits), and press "Confirm client" for the other four, reading what each says it means. Until a client is confirmed, Harbor IT's template copies and staff seals don't go into it.
- [ ] **Save joining:** organizations the tool made have no joining seal, so until someone saves Settings, Joining and security, every join into them waits for approval on every device. As each client's owner (Grace Liu, Elena Rossi, Ravi Menon, Frank Delgado) open it and save how people join, then as Maya press "Use default" for that client in the console's Joining section. Do Harbor IT's own organization (Maya) and the Rivera Family (Carmen Rivera) too. Leave Summit Accounting for later, as above.

## 2. By persona

### MSP admins: Maya Chen, Owen Brooks

**The console**
- [ ] As Maya, the web vault's menu has "MSP console" among the tools; as Tom Alvarez (Northwind Dental member) it doesn't.
- [ ] As Maya, the Clients table shows the five clients with Members, Waiting, Invited, Expiring, Weak, Reused, and Exposed. Northwind Dental counts Casey Nguyen as invited; Bluebird Law counts Liam Walsh as waiting. Each row's actions (Admin console, Install command, Entra ID sync, and Confirm client while it's there) say what they do on hover and on keyboard focus.
- [ ] As Maya, turn the network off in DevTools and open the console: it says why it can't load, in plain words, with "Try again", never "Create MSP".
- [ ] As Owen, everything above looks the same: he's also an MSP admin, and should be an owner in every client.
- [ ] (changes the seed) **Add client:** as Maya, add "Lakeside Clinic" with the Business preset and "Default policies (recommended)" ticked: it's made in one step with Everyone and Admins, the default policies plus the required one, and every staff member; it needs no "Confirm client"; Activity records it. Add a second without the default policies: only vault lock (required for every client) is on. Close the tab once while one is being made: nothing is left half set up.
- [ ] **Confirm client:** as Maya, Summit Accounting still shows "Confirm client", and as Paul Grant (Summit member) no Harbor IT templates are offered. Leave it until Jordan Blake has joined (Staff, below), then press it: the copies follow within a few minutes of Maya's next unlock or console visit.

**Health and expiring**
- [ ] As Maya, weak and reused counts show first, then exposed with its progress ("Checking passwords against known breaches: ..."). A count opens "Passwords to fix in <client>": names only, the most exposed first, labeled "Exposed N times", "Weak", or "Reused". "Open" goes to that client's admin console.
- [ ] As Maya, turn off "Check my passwords against known breaches after unlocking" (Settings, Appearance) and reload: the Exposed column says "Not checked", with "Check exposed passwords". Press it: it checks once. Turn the setting back on. In a second browser of Maya's, the setting follows at its next sync.
- [ ] As Maya, block api.pwnedpasswords.com (or go offline after unlocking): the console says "Couldn't check" with "Try again" and how many items, never "Nothing to fix".
- [ ] As Maya, the console's "Expiring soon" lists everything expired or expiring within 30 days across clients, soonest first, with the client, and a link that opens the item in that client's vault.

**Default policies**
- [ ] As Maya, "Default policies" shows "N follow, M have their own" for each default, and "Vault lock" as "Required" with a lock and "all 5 clients". Bluebird Law has its own setting for two-step login for admins (everyone, not only admins) and master password requirements (16 characters); Cedar Ridge Veterinary for assisted password change; Pinecrest Construction for the browsers' card and address autofill.
- [ ] As Maya, open a default: upstream's form for that policy, "Default" or "Required for every client", and the clients that follow, checked.
- [ ] As Maya, Summit Accounting (added without the default policies) shows as having its own setting for the defaults it doesn't have (single organization, two-step login for admins, Members' own passwords, and the rest), and vault lock, which is required, as in step. Start "Use default" for single organization there: the console warns it would revoke members of other organizations (Diego Rivera, who's also in his family's). Cancel.
- [ ] (changes the seed) As Maya, turn on the default "Turn off assisted password change" for the clients that follow: the console names which changed. Turn it back off, unticking Cedar Ridge Veterinary so it keeps its own setting (off).
- [ ] As Maya, "Two-step login for admins" has the option "Everyone else too". Don't change it; note it's there.
- [ ] As Grace Liu (Northwind Dental owner), the Policies page has a note at the top about what required means, and the Vault lock row reads "Required by Harbor IT" with a lock and doesn't open. Changing it any other way (an event log link to its dialog, say) is refused with "Harbor IT requires this policy for every client, so it can only be changed in Harbor IT's console." Settings, Joining and security, "Two-step login for admins" is on and unlocked: Northwind follows Harbor IT's default.

**Two-step login for staff and clients' admins**
- [ ] As Maya, the console's "Two-step login" section has the staff requirement on, "Staff without it" empty (every staff member has an authenticator app), and "Clients' admins without it" empty. Changing the staff requirement asks for the master password first.

**Templates**
- [ ] As Maya, "Templates" lists Firewall and Microsoft 365 tenant for every client, and Line-of-business app for Northwind Dental and Cedar Ridge Veterinary, all from Harbor IT's own "Client templates" folder.
- [ ] Once the clients are confirmed, as Grace Liu (Northwind Dental owner) there's a "Templates" shared folder; as Tom Alvarez (Northwind Dental member), "New item from a template" lists all three, once each; as Jess Taylor (Cedar Ridge member) Line-of-business app is there; as Paul Grant (Summit member) it isn't.
- [ ] As Tom, an item made from Firewall lands where he's adding it (Personal, if that's open), not in Northwind by default. As Grace, the template copy's item view says it's a copy kept up to date elsewhere; vault lists hide the copies unless the Templates folder is open.
- [ ] As Grace, edit Northwind's copy of Firewall. As Maya, edit the source in Client templates (the console's "Edit" opens it): Northwind's copy changes on its own, replacing Grace's edit.
- [ ] As Maya, "Clients" on Line-of-business app's row: add Pinecrest Construction (as Frank Delgado, it shows up), then take it off again, choosing whether Pinecrest's copy goes to its trash or stays as its own template.
- [ ] As Maya, make a template in Client templates (Add, More categories, Create template), then "Add a template" for chosen clients. Then "Remove": it asks whether the copies stay or go.
- [ ] As Theo Ramirez (technician), the console shows which templates his clients get, with nothing to add, change, or remove.

**Staff**
- [ ] As Maya, "Staff" lists Owen, Theo, Priya, Sam, and Jordan Blake's invitation. "<name>'s access" matches the README: Theo every client as admin with install commands; Priya only Northwind Dental and Cedar Ridge Veterinary, the Helpdesk custom role (manage members, account recovery), no vault items, no install commands, and admin at Cedar Ridge; Sam every client, a custom role with vault items and view event logs, no install commands.
- [ ] As Maya, add a staff member by an email that has an account (Alex Morgan's) and one that doesn't: the answer is the same. Cancel both invitations.
- [ ] (changes the seed) As Maya, cancel Jordan Blake's invitation and add him again: with no email, the link shows once, to Maya. Open it in a browser profile nobody's used, make his account with his invited email, and join. Staff must use two-step login, so he's sent to "Set up two-step login to continue". Once he's set up, he's added to every client: in the four confirmed clients whose joining was saved, Maya's console lets him in by itself. In Summit Accounting (not confirmed, joining never saved) he waits: see Nora Feld's step under client owners.
- [ ] (changes the seed) As Maya, change Sam's access to chosen clients without Summit Accounting: Sam's console stops showing it and he's out of it. Put it back: he's added again, and Maya's console gives him the key.

**Install commands**
- [ ] As Maya, Northwind Dental's "Install command": a Windows, Mac, or Linux choice, the command with a copy button, how many joined with it, and "People who join see Northwind Dental's fingerprint phrase, to check with you", with the phrase. The Mac has two: "Copy profile command" and "Copy app command". "Replace the token?" and "Only these email domains can join" are there for MSP admins (domains need email: section 5).
- [ ] As Maya, Pinecrest Construction's command carries `-DisableCardAutofill -DisableAddressAutofill` (Windows) and `--disable-card-autofill --disable-address-autofill` (Mac and Linux); Northwind Dental's doesn't.
- [ ] As Maya, replace Northwind's token: the old command stops letting new people join, and Activity says "install tokens replaced".
- [ ] Running a command on a real computer is in section 4.

**Seats**
- [ ] As Maya, "Seats" says what counts, has a month picker and "So far, through" today. By DESIGN's rule (joined and not revoked; staff, invitations, and revoked people don't count), before any step that adds or removes people, today should read Northwind Dental 5, Bluebird Law 4 (Liam counts though he's waiting), Cedar Ridge Veterinary 3, Pinecrest Construction 6, Summit Accounting 3, total 21.
- [ ] As Maya, "Download CSV": `seats-<month>.csv` opens in your spreadsheet with Month, Through, Client, Seat-days, Days in month, Prorated seats, Peak, Today, and a Total line.
- [ ] (changes the seed) As Nora Feld (Summit owner), rename the organization to "=1+1": Maya's CSV shows it with a leading apostrophe, not as a formula. Rename it back.
- [ ] As Theo, Seats isn't there.

**Site fixes, event streaming, activity**
- [ ] As Maya, "Site fixes", "Shared by your staff" lists fixes Theo shared from the extension (section 3, extension), with who sent them. "Use for every client" moves one to "Used for every client", and it fills for Tom Alvarez at once, without three people agreeing.
- [ ] As Maya, the console's "Event streaming" adds a destination for the whole MSP: every client's events, tagged with the client and Harbor IT, plus Harbor IT's activity. Set it up as in Grace Liu's Event streaming step (client owners, below); a real SIEM is in section 4.
- [ ] As Maya, "Activity" reads in plain sentences, newest first, with who, from which address, and which client and person: the confirms, template changes, default changes, staff changes, and token replacements above. As Priya Shah, it shows only her two clients.

**What a client keeps for itself**
- [ ] As Maya, try to revoke Grace Liu, invite a new owner at Northwind Dental, and delete Northwind Dental: each is refused.
- [ ] (changes the seed) As Grace, revoke Owen at Northwind Dental: Owen's console can't act on Northwind any more (its row refuses), Maya's still can, and the console shows Owen as revoked by the client. Staff Owen invites afterwards stay out of Northwind. As Grace, restore him.
- [ ] As Maya, "Entra ID sync" on a client's row opens its Provisioning page. As Theo, there's no such action.

### Technicians: Theo Ramirez, Priya Shah, Sam Whitfield

**Theo Ramirez (every client, as admin, sees install commands)**
- [ ] As Theo, the console shows every client. "Install command" shows and copies, without "Replace the token?" or domains. Default policies and Templates show without changing anything. No Seats.
- [ ] As Theo, Northwind Dental's Settings, Joining and security shows only Joining and a line that Harbor IT manages the install command. No two-step login for admins card, no Script access, no Members' own passwords or card and address autofill settings. Settings, Provisioning answers "not found". Nothing signs him out.
- [ ] As Theo, Cedar Ridge Veterinary's Reports, "Members' own passwords" opens for him (he's an admin there), but he can't turn the setting off.
- [ ] As Theo, Reporting, Event streaming isn't his to set up in a client.
- [ ] As Theo, with someone waiting to join a client that lets people in automatically, his web vault or extension lets regular members in by itself; it never lets other staff in.

**Priya Shah (Northwind Dental and Cedar Ridge Veterinary only)**
- [ ] As Priya, the console shows only her two clients, and its Expiring soon and health show nothing from Northwind Dental (she has no vault items there).
- [ ] As Priya at Northwind Dental (Helpdesk: manage members, account recovery): the Members page works; she can revoke and restore Tom Alvarez, but not Grace Liu, Marcus Reed, Lena Fischer, or any staff. She sees groups but can't change anyone's. The Access page shows only the shared folders she opens herself and says how many it can't show. Account recovery needs email (section 5). Her web vault never lets anyone into Northwind on its own.
- [ ] As Priya at Cedar Ridge Veterinary (admin): she sees every item, lets regular members in, and reads Members' own passwords.

**Sam Whitfield (every client; vault items and view event logs)**
- [ ] As Sam, he sees and edits every client's items (Northwind Dental's Banking and payroll included), and reads each client's Event logs. No Members page actions, no Access page, no install commands.
- [ ] As Sam, the console's "Open" on a client's passwords to fix opens his own vault (he has no admin console role), and the health counts cover every client item he can edit.
- [ ] As Sam, an export from a client is refused: a client's custom roles can only import.
- [ ] As Sam in the web vault or the extension, a client's member policies (removing the individual vault, single organization, turning off Send) leave him alone, as they do the client's admins. A client's vault lock applies to him in every app, as it does to its admins.

**All of Harbor IT's staff**
- [ ] As each, sign in on a browser they haven't used: the authenticator code is asked, and there's no new-device wait.
- [ ] As Maya, "Link SSO" never links: MSP staff can't use a client's single sign-on (it says why).

### Client owners and admins

Grace Liu (Northwind Dental owner), Marcus Reed (Northwind Dental admin), Elena Rossi (Bluebird Law owner), Noah Bennett (Bluebird Law admin), Ravi Menon (Cedar Ridge Veterinary owner), Frank Delgado (Pinecrest Construction owner), Rosa Martinez (Pinecrest Construction admin), Nora Feld (Summit Accounting owner), and Lena Fischer's custom role.

**Members and the MSP**
- [ ] As Grace, the Members page says Harbor IT manages Northwind Dental and lists its people with their roles and whether they see vault items, with a "Remove MSP" button. As Maya, the same banner shows without the button.
- [ ] As Grace, try to change Theo Ramirez's role: refused, pointing to removing him or Remove MSP. Changing his shared folders or groups works.
- [ ] As Grace, a member's Options menu offers their event log.

**Joining**
- [ ] As Grace, Settings, Joining and security has the cards Two-step login for admins, Joining, Install command (managed by Harbor IT, so no Replace), Script access, Assisted password change, Members' own passwords, and Browsers' card and address autofill. As Marcus (admin, not owner), the same page opens and he can change Joining with no refused request.
- [ ] As Grace, Joining: let people in automatically or approve each one, and invitations lasting 2 hours, 1 day, or 5 days. Change and save; Northwind now has its own setting, and Maya's console shows that. Put it back with "Use default" there.
- [ ] (changes the seed) **Casey Nguyen joins:** if her invitation ran out (5 days by default), as Grace invite her again from the Members page. Then sign up at the web vault with Casey's invited email: the master password needs 12 characters and a strength of 3 out of 4, with "Check known data breaches for this password" ticked; then the first-run import tiles (section 3). Her join waits: as Grace, the Members page shows her waiting; Confirm, comparing her fingerprint phrase. Delete her account before a reset.
- [ ] (changes the seed) **Accepting a role:** as Grace, invite Alex Morgan (who has an account and no two-step login) to Northwind Dental as an admin. With no email he's joined at once, but as Grace, Confirm is refused until he accepts, saying so. As Alex, the vault page shows "Accept your role in Northwind Dental". Accepting signs him out (he has nothing that counts); his next sign-in goes to "Set up two-step login to continue". Set it up, then as Grace confirm him. Afterwards, as Grace remove him, and as Alex turn off the authenticator he added.
- [ ] **Liam Walsh waits:** as Elena, the Members page says Liam is waiting for two-step login, and Confirm is refused. The rule is Bluebird's own: Settings, Joining and security, "Two-step login for admins" with "Everyone else too" on (DESIGN.md, "Two-step login for everyone"), which Maya's console shows as Bluebird's own setting. Upstream's "Require two-step login" policy is off.
- [ ] As Nora Feld (Summit Accounting owner), after Jordan Blake joined Harbor IT's staff: Summit isn't confirmed and its joining was never saved, so Jordan waits on Summit's Members page. Confirm him, comparing his fingerprint phrase. Then save Summit's Joining and security, and as Maya press "Confirm client" and, in the console's Joining section, "Use default" for Summit: Summit now gets Harbor IT's template copies, and later joins behave as in the other clients.

**Two-step login for admins**
- [ ] (changes the seed) As Grace, make Tom Alvarez an admin. Tom's sessions end at once, everywhere. As Tom: the web vault's next password sign-in goes to "Set up two-step login to continue", saying "Northwind Dental requires two-step login for your role.", with an authenticator app, a security key or passkey, and Duo (only if the server has its own Duo account) to choose from. A wrong code says "That code didn't work", never a server time or IP. The extension's sign-in shows a dialog that sends him to the web vault; the apps say the same with the web vault's address; the CLI prints the server's sentence. Meanwhile, Maya's console lists him under "Clients' admins without it", and Grace's Joining and security card lists him. Once he sets it up, the page shows a new recovery code. Afterwards, as Grace make him a member again, and as Tom turn the authenticator off.
- [ ] As Grace, the card notes that "Require two-step login is a separate policy: it counts email codes, and removes members who have no two-step login from the organization."
- [ ] As Marcus Reed, Noah Bennett, Rosa Martinez, and Lena Fischer, the vault page shows no "Accept your role" notice and nothing on hold: the seed accepted their roles. Note it if one does.

**Access and offboarding**
- [ ] As Grace, the Access page (next to Members) has "By person" and "By shared folder", and one search for people, groups, and shared folders. Tom in Vendors shows "Custom" with what it allows; Practice software shows Clinical "Can view" and Front desk "Can view but not see passwords", each "Through <group>"; Ben Carter is revoked; Theo, Sam, Maya, and Owen are marked MSP staff; owners and admins show "Every item". Expanding a person shows item counts.
- [ ] As Lena Fischer, the Access page shows only the folders she opens herself and says how many it can't show; groups show without names.
- [ ] (changes the seed) As Grace, revoke Tom: the confirmation says "Tom Alvarez can open N shared folders with M items". Then "Passwords Tom Alvarez could see" lists the logins in Everyone and Vendors with their shared folders. "Open" opens one over the list: change its password and come back. "Copy list" copies names and folders only (paste it to check). It says "This list won't be shown again, so copy it if you'll need it later." and links to the Access page. Restore Tom.
- [ ] (changes the seed) As Grace, revoke Tom and Aisha Patel together: "Passwords these 2 people could see", with "Who could see it" beside each login. Restore both.
- [ ] (changes the seed) As Grace, remove Ben Carter (already revoked): it says what he could open before he was revoked. Casey (never confirmed) is never in these lists.
- [ ] After any removal, the Members page offers to replace the install command's token; Northwind is told to ask Harbor IT.
- [ ] (changes the seed; do it last) As Grace, remove Sam Whitfield: he could see every item, so the list says so and offers "Show all N logins". Maya's console shows him removed by the client, and Harbor IT's staff changes never add him back to Northwind.

**Folders, permissions, and icons**
- [ ] As Grace, "New folder" in the menu asks where: Personal or Northwind Dental. Make "Lab" in Northwind Dental and open its "Icon and color": 24 icons, 10 colors, a preview of how it shows in the menu; arrow keys move and pick within a group, Tab goes to the next. The icon shows in the web vault's menu, the admin console's Shared folders, the extension's folder filter, the desktop app's sidebar, and the phone's Folders card, in light and dark.
- [ ] As Grace, give Tom "Can view but not see passwords" in Lab and Aisha "Can edit". Then give Aisha a Custom grid: edit without delete. As Aisha, deleting an item there is refused. As Tom, Lab's passwords are hidden (Chloe Martin's steps under Members say what that means).
- [ ] As Grace, in the Custom grid, untick See items: the person's out of the folder. Ticking Export, Print, or Share needs See passwords ("Export, print, and share need see passwords."). Manage includes everything else.
- [ ] As Grace, give Aisha "Can manage" on Lab: as Aisha, she can rename it, change its icon, and give people access, but not make or delete folders. As Tom (who can't rename it), changing its icon is refused: "Only people who can rename this shared folder can change its icon."
- [ ] As Lena (manages members), give a member access to a folder she doesn't open herself: refused; she gives only what she has, never manage.

**Policies**
- [ ] As Grace, the Policies page: single organization, master password requirements, vault lock (required by Harbor IT, locked), two-step login for admins, Members' own passwords. No account recovery (it needs email).
- [ ] As Grace, turn on "Password generator" with a minimum length of 24: as Tom, the generator follows in the web vault, the extension, and the apps ("Your organization sets some of these."). Turn it off again.
- [ ] As Tom, the vault lock policy shows: in the apps "Lock when the computer sleeps" is on and can't be turned off ("Your organization keeps this on"), and lock times stop at the policy's; in the web vault, the timeout is at most 15 minutes. As Grace (an owner), the apps leave her choices alone.
- [ ] As Tom, "New organization" is refused (single organization). As Grace, invite Diego Rivera to Northwind Dental: he can't be confirmed (he's in his family's organization). Cancel the invitation.

**Reports and logs**
- [ ] As Grace, Reports has the weak, reused, and exposed reports for Northwind's items, "Expiring items", and "Members' own passwords".
- [ ] As Grace, Reporting, Event logs reads in sentences for what you did above (sign-ins, new-device approvals, folder changes, item history, settings). Export it as CSV and as JSON.
- [ ] As Lena, Event logs open for her (view event logs).

**Settings cards**
- [ ] **Members' own passwords:** as Ravi Menon (Cedar Ridge owner), Reports, "Members' own passwords" has one row each for Jess Taylor and Kai Anderson, "Not reported yet: their apps send the numbers after they next unlock." until they do. Sign in as Kai in the web vault, then reload Ravi's page: Kai's logins, weak, reused, and exposed. Harbor IT's people aren't rows. As Ravi, turning it off asks first (it deletes the numbers); Kai's Health page loses its line about Cedar Ridge's admins. Turn it back on: "Not reported yet" again.
- [ ] **Assisted password change:** as Ravi, Cedar Ridge's card has it off, not locked. As Jess Taylor in the extension, a Cedar Ridge login has no "Change password"; as Kai, his own logins still do. As Ravi turn it on: after Jess's next unlock, the button shows. Turn it off again.
- [ ] **Browsers' card and address autofill:** as Frank Delgado, Pinecrest's card reads "Turn off, and offer to bring them in" (the others: "Leave as is", "Turn off"). What members see is under Members (Pinecrest). As Frank switch to "Leave as is": Maya's install command for Pinecrest loses its two options and the console says to rerun it on computers set up before. Switch back.
- [ ] **Script access:** as Grace, Settings, Joining and security, Script access, "New token": a name ("Join domain"), items (only ones whose passwords she can see), fields per item (username, password, one-time code, named custom fields), an expiry (at most a year, 90 days by default), and optional networks. It asks for the master password; a wrong one makes nothing. The token shows once, with the lines a script needs. Then, in PowerShell 7 (on the Mac too) or Windows PowerShell 5.1, run those lines: `Get-PassBundleCredential` and `Get-PassBundleSecret` for the password, a custom field, and the one-time code. An item or field not granted is refused; 61 reads in a minute get refused; edit the item and the page shows "Updating" until the copy catches up, then the script gets the new value; revoke, and the next read is refused. Set a network the script isn't in: refused, and forged `X-Forwarded-For` or `X-Real-IP` headers don't get past it. Every read, allowed or not, is on the token's list, and Maya's Activity shows its first use from a new address.
- [ ] **Event streaming:** as Grace, Reporting, Event streaming: add a Webhook to any public HTTPS address that shows what it receives. It asks for the master password; the signing secret shows once; the URL shows only its scheme and host. Test sends a test event (a refused address answers with one plain message after 16 seconds). Do something in Northwind: it arrives, signed. Changing the URL, the header's name, or the certificate authority asks for the header's value again. As Lena and as Theo, it isn't theirs to set up. A real SIEM is in section 4.
- [ ] **Provisioning (without Entra):** as Grace, Settings, Provisioning: the SCIM URL and "Create token" (master password first; the token shows once). With curl, `GET <SCIM URL>/Users` with `Authorization: Bearer <token>` lists Northwind's members. As Theo, Provisioning answers "not found".
- [ ] (changes the seed) As Grace, with curl, `POST /Users` a made-up person at northwind-dental.test: they appear under the people waiting. Sign up as that address in the web vault (the invitation lets them, on an invite-only server); press "Let them in" as Grace, and her browser lets them in. `PATCH` them `active: false`: revoked. Try to turn off Marcus (an admin) through SCIM: refused with 403, and Provisioning lists him under "Entra turned these people off; remove them here if they've left". "Replace token" stops the old one at once. Delete the made-up account before a reset. The real Entra run is in section 4.
- [ ] **Single sign-on:** the setup needs a real Microsoft tenant (section 4). As Nora, "Require single sign-on" is refused at Summit Accounting: it has no single organization policy.

**A company's own IT (no MSP)**
- [ ] (changes the seed) As Diego Rivera (he has an authenticator app, and none of his organizations has single organization on), "New organization", "A business": it's made in one step with the Business preset (single organization, master password requirements, vault lock, two-step login for admins, Members' own passwords; no account recovery here, it needs email), Everyone and Admins, and Settings, Joining and security with every card, including the install command for Windows, Mac, and Linux with "Replace token" (it's his own, not an MSP's). Delete the organization afterwards.

**Lena Fischer (Northwind Dental custom role: manage members, view event logs)**
- [ ] As Lena, the Members page works: she can revoke and restore Tom, but not Grace, Marcus, or any staff, and not herself. She sees groups but can't change anyone's. No Settings, Joining and security, no Provisioning, no Members' own passwords report. Any page that signs her out is a finding (upstream signs out on a 403).
- [ ] (changes the seed) As Lena, remove a member: the list after it shows only what her own Access view shows.

**Remove MSP (do it last)**
- [ ] (changes the seed for good) As Nora at Summit Accounting, Members, "Remove MSP": in one step Harbor IT's people are gone, and Nora is shown what went (who lost access, script tokens and event destinations by name, the install command). Joining, the preset, and the folders stay hers. Summit is gone from Maya's console and can't be added back: run `reset` afterwards.

### Members

**Tom Alvarez (Northwind Dental member, no two-step login)**
- [ ] As Tom, the first sign-in in the web vault goes straight through. The menu shows Personal and Northwind Dental with only the shared folders he has (Everyone, Vendors, and any his groups give), and counts only what he can see.
- [ ] As Tom, the vault page shows the nudge: "Your password is all that protects your account. Add a second step, such as an authenticator app, so a stolen password isn't enough." with "Set it up" and "Not now". "Not now" hides it everywhere for 90 days: the extension's callout ("Add two-step login") is gone too.
- [ ] As Tom, sign in to the extension in Chrome after the web vault: "This device is new to your account.", a big number, and "Waiting for approval. This works for 10 minutes." In Tom's web vault, "Approve this sign-in?" shows the device ("Extension in Chrome"), where it is, its address, and time left. Type the number: the extension signs in. Next time on another browser: type a wrong number (it denies: "That number didn't match, so the sign-in was denied."), then "Not now" (it comes back after 2 minutes), then "Deny". Grace's Event logs show each.
- [ ] As Tom, the popup closing doesn't lose a waiting check; a web vault reload does (it starts over with a new number).
- [ ] As Tom in Vendors (Custom: see passwords, create, edit, no delete): he can add and edit; moving an item to the trash is refused. In Version history he can restore if his grid has view item history, but "Delete this version" and "Clear history" aren't his.
- [ ] As Tom, his Health page says "Admins at Northwind Dental see how many of your own passwords are weak, reused, or exposed. Never which ones."

**Aisha Patel (Northwind Dental member, authenticator by choice)**
- [ ] As Aisha, a new browser asks for her code and no number; no nudge. In Vendors (Can view) she can't edit; Version history shows versions but no Restore.

**Chloe Martin (Bluebird Law member; Client portals: can view but not see passwords)**
- [ ] As Chloe, a Client portals login's password shows as a mask and can't be shown, copied (list button, item, right-click menu), or dragged. Websites are read-only in the editor, a save keeps the secrets as they were, and she can't clone the item or link a custom field to its password.
- [ ] As Chloe, the extension still fills that password, but only into a real password field, never a text field; its one-time code fills normally; the save prompt never offers that item's password.
- [ ] As Chloe, its Version history shows only when and by whom. In Court e-filing (Can edit), everything works.

**Liam Walsh (Bluebird Law, accepted without two-step login)**
- [ ] As Liam, the web vault and extension say "Bluebird Law requires two-step login before you can get in", with a button to its settings. No Bluebird items, and no nudge.
- [ ] (changes the seed) As Liam, set up an authenticator app. As Elena, the Members page now lets her confirm him, comparing his fingerprint phrase (approval, since nothing's emailed). As Liam, Bluebird's folders appear.

**Jess Taylor and Kai Anderson (Cedar Ridge Veterinary members)**
- [ ] As Kai, the web vault's Health count and reports show his weak, reused, and exposed logins, and the line about Cedar Ridge's admins. Ravi's report fills in after this (above). The extension and the apps send weak and reused only.
- [ ] As Jess, Line-of-business app is among the templates (after Confirm client), and Cedar Ridge's logins have no "Change password" (Cedar Ridge turned it off).

**Pinecrest Construction: Mike O'Neill, Dana Kowalski, Luis Ortega, Ivy Park**
- [ ] As Ivy Park (authenticator, so no number to type in each browser), sign in to the extension in Chrome: Chrome's payment methods and addresses settings show as controlled by an extension and can't be changed. The popup says once "Pinecrest Construction turned off Chrome's own card and address autofill in this profile, since your account there is signed in here", with "Got it", and shows "Bring your cards and addresses in" (it opens Chrome's payments and addresses pages beside New card and New identity) until "Done". Sign out: Chrome's switches are hers again.
- [ ] As Ivy in Edge: the same, except the offer only says where they are in Edge's settings. In Firefox: nothing changes (only the install command's policies reach Firefox).
- [ ] As Greg Hollis (revoked) in another Chrome profile: Chrome's switches are left alone.
- [ ] As Maya (an owner at Pinecrest) in the extension: note whether her Chrome's card and address autofill is turned off too (DESIGN doesn't exempt staff).
- [ ] As a Field crew member (Pinecrest's Groups page says who; Mike, Dana, or Luis), a "Fuel and company cards" card's number and security code are masked. Filling it on a checkout fills the name and expiry, but the number and code only into password-type fields.
- [ ] As Mike, a second browser waits for the number (no two-step login): approve it from his first.

**Paul Grant and Diego Rivera (Summit Accounting)**
- [ ] As Paul, Summit has Everyone and Tax software; no Members' own passwords line (Summit has it off), and the vault lock Harbor IT requires of every client.
- [ ] As Diego, the menu shows both Summit Accounting and Rivera Family.

**Ben Carter and Greg Hollis (revoked)**
- [ ] As Ben, Northwind Dental shows nothing he can open; an item's history he once saw answers as if it didn't exist.

### Family: the Riveras

Carmen Rivera (owner, no two-step login), Diego Rivera (admin, authenticator), Sofia Rivera (member, no two-step login), Marisol Rivera (invited, no account).

- [ ] As Carmen, Rivera Family has no policies, no Members' own passwords line, and the nudge shows.
- [ ] As Sofia: Household (can edit), Streaming and kids (can view), Travel documents (can view but not see passwords: passport numbers are masked, and her Version history shows only when and by whom), and no Money at all.
- [ ] As Sofia, make an item from the "School account" template: its fields fill in from the template, and hidden defaults stay empty where she can't see passwords.
- [ ] As Sofia, a second device waits for the number; approve it from her first.
- [ ] **Legacy contact:** as Carmen, Settings, Emergency access lists Diego as a trusted emergency contact with Takeover and a 7-day wait. As Diego, "Designated as emergency contact" shows Carmen, with "Request Access". Request it: with no email, Carmen isn't told; as Carmen the request shows on her Emergency access page. "Reject". As Diego, request again; as Carmen "Approve" (no need to wait the 7 days).
- [ ] **Legacy contact, view only:** as Carmen, "Add emergency contact": Sofia, "View", wait 1 day. With no email, it's accepted at once and shows "Needs confirmation": as Carmen "Confirm", checking the fingerprint phrase. As Sofia, request access; as Carmen approve. As Sofia, she sees Carmen's own items, not Rivera Family's.
- [ ] As Diego, sign in by "Sign in with a device" (approved from another of his devices), then try to request access: refused. Emergency access needs a master password sign-in.
- [ ] (changes the seed; do it last) As Diego, take over Carmen's account and set a new master password: Carmen's sessions end, her two-step login (none) and memberships where she isn't an owner go, and she stays owner of Rivera Family. Teardown will leave Carmen and name her.
- [ ] (changes the seed) **Marisol joins:** if her invitation ran out, as Carmen invite her again. Sign up with Marisol's invited email; her join waits: as Carmen or Diego, confirm her on the Members page, comparing her fingerprint phrase. Delete her account before a reset.
- [ ] (changes the seed) As Diego, Settings, Joining and security, turn on "Require two-step login for admins" and then "Everyone else too" (both off for families). It asks for his master password and lists who isn't set up (Carmen, Sofia). Saving signs Carmen and Sofia out at once. As Carmen, the next sign-in goes to "Set up two-step login to continue", naming Rivera Family. Don't set it up: as Diego turn both off again (only someone who meets the rule can), and Carmen and Sofia sign in with their passwords again. Rivera Family's Event logs show each change.
- [ ] As Carmen, Joining and security offers "Create install command" (a family has none).
- [ ] As Carmen, "New organization", a business: "Set up two-step login first", with "Set up two-step login" and "Not now". "Not now" makes nothing.

### On their own: Alex Morgan

- [ ] As Alex, the menu shows Personal with Banking, Shopping, Social, Work, Home, and "No folder"; every category; no organizations, no MSP console. Personal folders have no icon picker (that's later).
- [ ] As Alex, every kind of item opens: logins with websites, usernames, one-time codes, and custom fields; cards; identities; notes; SSH keys; bank accounts, driver's licenses, and passports (the web vault and extension show these three only while the server turns on the new item types); and items from the built-in templates (Wi-Fi network, server, database, router, software license, domain, certificate, API key, email account, membership).
- [ ] As Alex, the nudge shows; a second browser waits for the number.
- [ ] As Alex, "New organization", a business: "Set up two-step login first"; "Not now" makes nothing.
- [ ] As Alex, the web vault keeps the tab unlocked across a reload with no policy to cap it (section 3, web vault).
- [ ] (changes the seed) As Alex, Settings, Security, Two-step login: add an authenticator app. Each dialog asks for the master password once; wait more than 5 minutes before "Turn on" and it asks again; open two dialogs at once and a token from one fails in the other. Sign in with it, then remove it (the nudge comes back).
- [ ] Everything else as Alex is in section 3: templates, expiration, history, health, generator, Send, import and export, and the apps.

## 3. By app

### Web vault

**Signing in**
- [ ] As Alex Morgan, "Sign in" and "Sign out" everywhere, never "log in". An unknown email and a wrong password get the same message. Typing `test.passbundle.com` without https:// works.
- [ ] **Sign in with a device:** as Tom Alvarez, in a browser where he's signed in before, sign out, type his email, and choose "Sign in with a device". A five-word fingerprint phrase shows. Tom's Mac app (and the Pixel, with PassBundle open) shows "Approve sign-in?" within about 10 seconds: check the phrase matches, approve (it asks for the master password, or Windows Hello or the fingerprint where those are set up), and the browser signs in. Try "Deny" once, "Resend" once (it replaces the waiting request), and leave one to expire after 15 minutes. Approving between minute 5 and 15 still works.
- [ ] As Tom, in a browser profile that's never signed in to his account, "Sign in with a device" isn't offered.
- [ ] As Tom, ask from browser B and switch networks (Wi-Fi to a phone hotspot) before approving: the approved sign-in is refused (only the same address counts).
- [ ] As Tom, sign browser B in by approval, then from B try to approve browser C's request: refused. Approving needs a master password sign-in.
- [ ] As Grace Liu, set her generator to include symbols, then use Sign in with a device: it still works.
- [ ] As Grace, Settings, Security, Devices shows a waiting request and approves it in one click (no master password there; that confirmation is only in the apps).
- [ ] As Tom, the web vault approves new-device checks too: "Approve this sign-in?" appears within about 10 seconds while his vault is open and unlocked.

**The vault**
- [ ] As Alex, the left menu reads top to bottom: "Search all items", All items, Favorites (once there's one), Expiring soon (while anything is expired or expiring within 30 days), Health with its to-fix count, Categories (only kinds he has), Folders with "New folder", Personal and its folders, No folder, Archive, Trash, a line, then Generator, Send, Import and export, Settings. As Maya Chen, "MSP console" sits among the tools, and each organization is in bold over its folders.
- [ ] As Alex, the page title is the entry's name, never "All vaults". Reload with a filter in the address: the same view comes back. Delete the last item of a category while it's open: it stays until you leave, then the category goes.
- [ ] As Alex, the Health count matches what Health lists, counts an item that's both weak and expiring once, and turns up 3 seconds after unlock. Offline before unlocking: it shows a "couldn't check" sign.
- [ ] As Alex, an item opens in a side panel beside the list ("Login in Personal · Work"), with Edit in place. With unsaved edits, Close, Escape, or another row asks "Discard edits" first, and "Back to editing" keeps them. Add opens "What are you saving?" with Login, Secure note, Card, Identity, and "More categories" (every kind and template, with a search).
- [ ] As Alex, narrow the window to phone width: a "Menu" button opens the menu over the page.
- [ ] As Alex, search finds items by name, username, and website.
- [ ] As Alex, make a login, a card, a note, and one from a template (Wi-Fi network, server): their tiles and colors match across the web vault, the extension, the phone, and the Mac. Logins show their site's icon, or a letter where there's none.
- [ ] As Alex, Archive, Trash (restore, delete for good), Favorites, and Print work as upstream's. As Tom, "Print" isn't there for an item in a folder that doesn't allow it.

**Item templates**
- [ ] As Alex, Add, More categories: the ten built-in templates with their tiles. An item from Wi-Fi network has its fields, a hint in the editor, a description in the view, and a "Template" badge in the list.
- [ ] As Alex, "Save as template" from a login with hidden custom fields: a new, unsaved template with the field names and kinds, never their values. Then "Create template" from scratch, and "New item from a template" lists his own before the built-ins.
- [ ] As Alex, name a custom field "keykeeper.fill" (or "Keykeeper.x", or with spaces before it): refused ("Names starting with "keykeeper." are reserved.").
- [ ] As Sofia Rivera, an organization template (Rivera Family's School account) is listed before her own and the built-ins.

**Expiration**
- [ ] As Alex, set "Expires" on a login and "Remind me" (30, 7, and 1 day before by default; 90, 30, 7, and 1; 7 and 1; or Don't remind me). The list shows "Expires in N days" or "Expired"; cards use their own expiry. Expiring soon lists expired, a few days out, and this month's card, not later or undated ones. Health, "Expiring items" lists expired first, then soonest.
- [ ] As Grace, the admin console's Reports, "Expiring items" lists Northwind's.

**Item history**
- [ ] As Alex, change a password twice, open Version history: three versions, newest first, "Saved by you". View one: side by side with the item now, changed fields marked, hidden values masked until "Show hidden values". "Restore this version" (the replaced one goes into history too), "Delete this version", "Clear history". Marking a favorite makes no version.
- [ ] As Alex, edit an item in two tabs and restore in the older one: refused as a stale copy, in plain words.
- [ ] As Alex, register a new passkey on webauthn.io into a login that has history, then restore an older version: it warns that restoring removes the passkey, with "Restore anyway".
- [ ] As Grace, "Saved by" names who saved each version; as Tom, others' versions read "Saved by another member".
- [ ] As Grace, move one of her personal items that has history into Northwind Dental: its history is gone.

**Health**
- [ ] As Kai Anderson, the weak, reused, and exposed reports each list his items with their tiles; "Exposed passwords" checks only a 5-character hash prefix (DevTools, Network: requests to api.pwnedpasswords.com). With it blocked, the report says how many couldn't be checked and never "Good news".
- [ ] As Kai, the item editor's Check button checks one password.
- [ ] As Kai, "Change password" on an at-risk item opens the site's change-password page (or the site).
- [ ] As Alex, Settings, Appearance, "Check my passwords against known breaches after unlocking" off: the Health count covers weak and reused only, and DevTools shows nothing sent after unlock. Back on.

**Generator**
- [ ] As Alex, the default is 20 characters with all four kinds and no look-alikes; passphrases are 6 words. Change the length to 32: the extension and the apps follow at their next sync. Change it offline in one place, reconnect: the last save wins. Sign out and in: it stays.
- [ ] As Alex, on a sign-up page for airfrance.com in the extension, the suggested password is 8 to 12 characters with only the symbols that site allows; a site with no rules gets the usual 20.

**Staying unlocked across a reload**
- [ ] As Alex, Settings, Security, Session timeout, "Stay unlocked when I reload" is on: reload (F5 or Cmd+R) within the timeout and it stays unlocked. Reopen a closed tab, open a new tab, a new browser, Back to the page, or type the address again: each asks for the master password. Lock, then reload: it asks.
- [ ] As Alex, turn the setting off: every reload asks, in every tab. Choose "On browser refresh": the setting is off, with a note saying why.
- [ ] As Grace (an owner under the Business preset's vault lock), set 60 minutes, wait 20, and reload: it asks (owners are capped at 15 for this, too).
- [ ] As Alex, in Firefox (and Safari if you have it), reopen a closed tab within 15 seconds: note whether it comes back unlocked (DESIGN's known gap).
- [ ] After a server restart (an update), the next reload asks.

**Import and export**
- [ ] (changes the seed) As Casey Nguyen right after signing up (section 2), the first-run tiles: "the browser and Apple Passwords", 1Password, Bitwarden, LastPass, and anything else, each with export steps and "Skip for now". Offered once, in the tab that signed up.
- [ ] As Alex, each file in `~/Documents/PassBundle-demo/fake-exports/`, through Import and export, Import. Spot-check a few items against the README's notes. A field named like ours arrives visibly ("Imported keykeeper.fill"). The last row of a 1Password 8 CSV shows without forcing a sync.
- [ ] As Alex, Import and export, "Import from your browser": it picks your browser and computer, gives that browser's export steps, and imports into Personal. Run it twice: nothing doubles. Same site and username with a different password go to "Check these: from <browser>". A file that isn't that browser's export is refused by name. It ends with a summary and how to delete the export. (With real passwords: section 4.)
- [ ] As Alex, Export in each format. (changes the seed) A password-protected export of Alex's imports into Tom Alvarez's Personal. As Tom, an export never includes items from folders he can't export.

**Send, emergency access, and the rest of Settings**
- [ ] As Alex, Send: a text and a file Send, opened in another browser.
- [ ] As Alex, Settings, Security, Keys: "View API key" (for the CLI) and "Rotate API key".
- [ ] As Alex, Settings, Appearance, Theme: "System default", "Light", "Dark"; the first paint is already themed, and the choice survives a reload.
- [ ] (changes the seed) As Alex, Settings, Security, Keys, the encryption settings offer only PBKDF2 with 600,000 to 2,000,000 iterations, or Argon2id within its bounds. Switch to Argon2id: the desktop app and the Pixel still sign in and unlock.

**Connector pages**
- [ ] With Alex's security key added (section 4), the web vault's key step runs in a frame from test.passbundle.com itself. Put `https://test.passbundle.com/webauthn-connector.html` in an iframe on a page of your own: the browser refuses to show it. In DevTools, the connector pages carry `X-Frame-Options: SAMEORIGIN` and a Content-Security-Policy with `frame-ancestors`, and every page carries `Strict-Transport-Security`.

**Errors in plain words**
- [ ] As Maya, go offline and use the MSP console, Joining and security, and item history: "Couldn't reach the server. Check your internet connection, then try again.", never "TypeError: Failed to fetch" or "Error: ...".
- [ ] As Tom on "Set up two-step login to continue" (section 2), a wrong code never shows the server's time or IP.

**Organizations and the MSP console** are in section 2: client owners and admins, MSP admins, technicians.

### Browser extension (Chrome, Edge, Firefox)

Do each step in Chrome; repeat the starred ones (*) in Edge and Firefox.

**Signing in and the look**
- [ ] * As Alex Morgan, "Where's your vault?": PassBundle or Self-hosted. With Self-hosted, a typo or a normal website says what's wrong under the field ("Check it for typos, and that you're online"); `http://`, `user@host`, `?query`, and `#frag` are refused; a dead address gives up after 15 seconds; Continue and Enter stay off while it's wrong. The password step names the server ("<email> · test.passbundle.com"). Under the form: "New here? Your admin sends the invite."
- [ ] * As Alex, the Items tab: search and Add (+), category chips with tiles, the folder filter (only once there's more than Personal), "For <site>" items with Fill, Favorites and All items, rows with a copy button. Bottom tabs are restyled. Settings, Appearance, Theme: "System", "Light", "Dark".
- [ ] * As Alex, an item page: its tile, "Login in Personal", "Fill on this page", copy buttons, the password health line ("Password strong · changed ..."), and a history card to "Version history".
- [ ] As Grace Liu, the folder filter lists All folders, Personal and its folders, No folder, then Northwind Dental and its folders with their icons and counts; the picked place shows as a chip ("Northwind Dental · Everyone"). A new item goes where the list shows.

**New-device check, approvals, and the nudge**
- [ ] * As Tom Alvarez, signing in to a new browser shows the number and waits (section 2); closing the popup doesn't lose it.
- [ ] As Tom, the popup shows the "Add two-step login" callout; "Set it up" opens the web vault's two-step settings; "Not now" hides it in the web vault too.
- [ ] As Grace, a "Sign in with a device" request from another browser of hers shows the extension's approval dialog.
- [ ] As Liam Walsh, the extension shows "Bluebird Law requires two-step login before you can get in".

**Autofill**
- [ ] * As Alex, on a site's sign-in page, the menu inside the field offers his logins; Fill fills username and password once. Note any page where it fills the wrong field (section 4 has the real sites).
- [ ] * As Alex, right-click a field: "Fill this field with", the item's Username, Password, Verification code, and custom fields, then "Never fill this field". Pick a custom field for a "Customer number" field: it fills now and next time. The web vault's item view shows the rule in words ("<site>: the field with id ... gets ..."); removing it there stops it. "Never fill this field" moves the value to the next field.
- [ ] * As Alex, "Open and fill <name>" on a login's row (or double-click the row), and "Open and fill" beside a website on the item page: a new tab opens and fills once, never submitting. Reload: no second fill. A redirect to another site ends it. A login that asks for the master password asks before the tab opens.
- [ ] * As Alex, after signing in somewhere he has no login, PassBundle offers to save it, in our colors. On a site that answers instantly, type fast and press Enter: the prompt still comes, with the password exactly as typed.
- [ ] * As Alex, on a second step that asks for a one-time code, paste a code: no "Update password?" offer with the code. The code fills from the item.
- [ ] As Chloe Martin, hidden passwords fill only into password fields (section 2).
- [ ] As Alex, cards and identities fill from the popup, the right-click lists, and the menu in card and address fields ("New card", "New identity"), never on page load. On a checkout that adds payment after Continue, the new fields get the menu. A "Name on card" field gets the cardholder, not the shipping name. Month lists by "03", "March", or "Mar"; a single MM/YY expiry field; a phone split into area code and the rest.

**Site fixes**
- [ ] As Theo Ramirez, Settings, Autofill, "Site fixes": turn on "Share fixes I make with the fill picker" ("Use fixes other people share" is on by default). Use "Fill this field with" on a site's field: Maya's console lists it under "Shared by your staff" (section 2).
- [ ] As Tom, "Report a problem with this site" from the current-tab list: the form shows exactly what goes (field types, ids, names, labels, never values; an email address shows as "(email address)"), with an optional note.
- [ ] As Tom, turn off "Use fixes other people share": note whether the fix Maya used for every client still fills (DESIGN keeps Harbor IT's site rules apart from fixes other people share).

**Passkeys**
- [ ] * As Alex, on webauthn.io register a new passkey (the seeded one isn't known there), then sign in with it. In a second browser signed in as Alex, sign in with the same passkey.
- [ ] As Alex, with the browser window half off the screen or on a second monitor, the passkey popout still opens where you can see it.

**Change password on the site**
- [ ] As Alex, on a login he can edit, "Change password" opens a short dialog first (a new tab, the new password saved first, the old one kept). Not offered for an http website, an item with no password, an item in the trash, or for Chloe on Client portals.
- [ ] As Kai Anderson, the popup has no Health page (section 6), so "Change password" is only in a login's view. Note it if a Health entry appears.
- [ ] Real sites and the "Did the new password work?" card are in section 4.

**Other**
- [ ] As Alex, "Vault settings", "Import from your browser" opens in its own window.
- [ ] As Alex, set an expiry a day away on an item: after unlocking (it checks every 6 hours), a system notification gives a count only ("1 item expires soon"), never the item's name. "Don't remind me" items never notify; signing out and in shows them again.
- [ ] As Alex and Tom, the extension holds up to five accounts (upstream's switcher).
- [ ] As Alex, a PIN unlock works in the extension (the apps have none).
- [ ] As Grace, the item page's "Version history" opens "Item history": restore, delete, and clear as in the web vault; an item that asks for the master password asks again first.
- [ ] As Ivy Park in Chrome and Edge, the card and address switches (section 2). Firefox has none.
- [ ] The join prompt from an install command ("Join Northwind Dental?") can't be tried yet: the install scripts' extension IDs are placeholders, so a loaded-by-hand extension never gets the token (section 4).

### Desktop app (Windows, Mac, Linux)

Do each step on all three unless it names one.

**Signing in**
- [ ] As Alex Morgan, "Sign in to PassBundle": "Self-hosted?" shows Server; a typo or `http://` is explained under the field when you leave it. An unknown email and a wrong password both say "That email or master password isn't right."
- [ ] As Alex, "Create account" on this invite-only server fails with the server's reason in plain words.
- [ ] As Grace Liu, "Two-step login" opens on the strongest method she has; "Use another way" lists the rest and always a recovery code; "Don't ask again on this device for 30 days" works; "Start over" goes back.
- [ ] As Tom Alvarez on a computer he hasn't used: "This device is new to your account." with a number; approve it from his web vault. Quit the app while it waits and sign in again: a new number.

**Unlock and locking**
- [ ] As Alex, unlock with the master password. Settings, Locking: "Lock after" (1, 5, 15, 30 minutes, 1 or 4 hours, "When the app closes"; 15 by default) and "Lock when the computer sleeps" (on). Lock after the time you set while using other apps: it counts the whole computer's idle time (on Linux, only under GNOME).
- [ ] As Alex, "Get your master password hint" on the lock screen: note what it says on this server with no email.
- [ ] Windows: as Alex, Settings, Unlock, "Unlock with Windows Hello" (it needs the desktop agent running; otherwise it says "Needs PassBundle's desktop agent, which isn't running"). Lock, unlock with Windows Hello; cancel the prompt once. Section 4 has the real hardware.
- [ ] Mac and Linux: no Unlock group in Settings (Touch ID waits on Apple signing; Linux has none).

**Approving**
- [ ] As Tom, Settings, "Sign-in requests" lists what's waiting, or "None waiting". "Confirm before approving" is on: approving a "Sign in with a device" request asks for the master password (Windows: Windows Hello or the master password). Turning the switch off asks first; on asks nothing.
- [ ] As Tom, a new-device check shows "Approve this sign-in?" with Device, Where, When, Expires in, and "Number shown on the new device"; Approve stays off until two digits are typed.

**The vault**
- [ ] As Grace, the sidebar: the logo, All items, Favorites, Expiring soon (while any), Health ("N to fix"), Categories, Folders (with +; Rename and Delete on her own), then Generator, Import, Export (these two open the web vault), her email (the account menu), the light and dark button, Settings, and Lock. Shared folders show their icons, grouped by owner.
- [ ] As Grace, Health lists weak, reused, and unsecured (http) logins and expiring items; no exposed check in the apps. A clean list says "Nothing to fix: no weak, reused, or unsecured passwords."
- [ ] As Alex, view and edit a login, note, card, and identity; SSH keys, bank accounts, driver's licenses, and passports show with "Edit in web vault". New item: "What are you saving?" with "Website or app", "Important text", "Credit or debit card", "Personal info", "More categories", and templates grouped as each organization's, "My templates", and "Built-in".
- [ ] As Tom, New item lists Harbor IT's Firewall template under Northwind Dental (after Confirm client).
- [ ] As Alex, the editor's "Expires (optional)" and "Remind me"; after unlocking, a banner "N items expire soon" with Show and Dismiss.
- [ ] As Alex, "Version history": compare, "Show hidden values", "Restore this version", "Delete this version", "Clear history".
- [ ] As Alex, copy a password: "Copied the password. It clears in 30 seconds." On Windows it isn't in clipboard history (Win+V); on the Mac, a clipboard manager treats it as concealed.
- [ ] As Alex, "Save <name>" on an attachment: it lands in Downloads, never overwriting a file of the same name.
- [ ] As Alex, "Move to trash": it says you can restore it from the web vault's trash, with "Open trash".
- [ ] As Chloe Martin, Client portals: "Your organization hides this item's passwords from you." No reveal, copy, or one-time code. Moving it to another shared folder: "Your organization doesn't let you move it to another shared folder."
- [ ] As Alex, turn Wi-Fi off: "Can't reach your server. You're seeing the copy on this device...", with Try again; saving says it needs the server and keeps what you typed.
- [ ] As Alex, edit the same item on two devices within a few seconds: the second save is refused and it syncs.
- [ ] As Alex, a login that asks for the master password shows only its name until it's given.

**Several accounts**
- [ ] As Alex, then add Tom: the account menu (the email at the sidebar's foot) has "Add account" and "Sign out of <email>". Up to five; at five, add can't be chosen. Each keeps its own lock and settings; "Lock" locks only the one shown. "All accounts" lists every unlocked account's items with a colored label; Settings, "This account" names and colors each (more than one signed in). A new item asks "Save it in which account?". Re-adding the same email signs it in again in its place.
- [ ] As Tom with Alex's account locked, a sign-in request for Alex shows once Alex is unlocked.

**Screenshots, updates, the agent, and the window**
- [ ] Mac and Windows, as Alex: a screenshot (Cmd+Shift+4 then Space, or Win+Shift+S), QuickTime or Game Bar recording, and a screen shared in a video call leave PassBundle's window out (black on Windows older than 10 2004). Settings, "Allow screenshots of PassBundle" lets them take it; off again, they don't. Linux has no such switch.
- [ ] As Alex, Settings, Updates: "Version 0.1.<n>", "Check for updates", "Check once a day", and "Update to ..." with what's new. The Mac moves the old copy to the Trash and reopens locked. At startup, at most once a day, "PassBundle X is out." with "See update".
- [ ] Windows and Mac: the agent's tray (menu bar) icon: "PassBundle <version>", "Open PassBundle", "Open web vault", "Quit PassBundle", and "N items expire soon" while any are. "Open web vault" opens vault.passbundle.com unless an install command set the server: note it. Closing the window leaves the agent; on the Mac, after Quit it stays stopped.
- [ ] Mac: the PassBundle menu has "Settings…" (Cmd+comma). Windows and Linux: the window comes back at its size and place.
- [ ] As Alex, the theme follows the system; the window is readable in light and dark.

### Android (Pixel)

- [ ] As Alex Morgan, sign in ("Self-hosted?", Server `test.passbundle.com`). Right after, "Unlock with fingerprint next time?" (or face): "Turn on". Then the "Turn on autofill" sheet: "Use PassBundle for autofill" and "Use PassBundle for passkeys" (Android 14 and later), each "Turn on", then "On" with a check; it closes once both are on. "Later" says "You can turn on autofill in Settings any time." and isn't asked again.
- [ ] As Alex, the lock screen asks for the fingerprint by itself when the app opens locked, but not after you pressed Lock. Settings, Locking: "Lock after a time away" (Immediately, 1, 5, 15, 30 minutes, 1 or 4 hours; 5 by default) and "Lock when the phone locks" (on).
- [ ] As Alex, add a fingerprint in Android's settings: biometric unlock turns itself off and asks for the master password once.
- [ ] As Alex, in Chrome on the phone, a sign-in page's suggestions list his logins by name and username; the password fills only after he picks one. Locked: "Unlock PassBundle" unlocks with the fingerprint without leaving Chrome. Signed out: "Sign in to PassBundle".
- [ ] As Alex, in an app, logins fill only through the item's own `androidapp://` link, or a site the app is linked to (Digital Asset Links). An app that opens web pages gets "Logins for <domain>" and "Trust <app> as a browser?" (Trust waits a second); Settings, "Browsers you trust for autofill" lists it with "Stop trusting".
- [ ] As Alex, sign in somewhere new: Android offers to save to PassBundle, which opens the editor filled in; nothing saves until Save. A new password for a login he has opens that login.
- [ ] As Alex with "Immediately": the vault locks once a fill is handed back.
- [ ] As Alex on Android 14 or later, register a passkey at webauthn.io: "Save a passkey in PassBundle?" names the site; sign in with it (fingerprint). A second passkey for the same account: "PassBundle already has a passkey for this account on this site."
- [ ] As Alex and Tom both signed in: autofill and passkeys offer both accounts' logins, labeled; each fills only from its own account. "Save the passkey in which account?" asks first.
- [ ] As Chloe Martin, Client portals logins fill into apps and browsers without ever showing the password.
- [ ] As Alex, copy a password: hidden from the keyboard's clipboard preview (Android 13 and later), cleared after 30 seconds.
- [ ] As Alex, screenshots and the app switcher show nothing of the vault, and there's no switch to allow it.
- [ ] As Alex, the Generator tab; Folders cards (with shared folder icons, as Grace Liu); Version history; templates; "Expiring soon"; the per-item health line ("Password strong · changed ..."); no Health list on phones.
- [ ] As Tom, with PassBundle open and unlocked, a "Sign in with a device" request or a new-device check shows within about 10 seconds. Approving a sign-in asks for the fingerprint ("Approve sign-in") or the master password; a new-device check needs only the number. Closed, nothing shows (there's no push).
- [ ] As Alex, Settings, "Web vault": Import, Export, and Open the web vault open the browser. Attachments save to Downloads.
- [ ] As Alex, Settings, Updates: Android's installer asks before installing the new version.
- [ ] As Alex, the Back button goes back one step (two-step login to sign in, adding an account to the account shown) before it leaves the app.

### iPhone

On the simulator until a real iPhone is possible (section 1).
- [ ] As Alex Morgan, sign in to the test server, then turn on "Unlock with Face ID" (in the Simulator, Features, Face ID, Enrolled, then Matching Face when it asks). The app switcher shows a plain cover.
- [ ] As Grace Liu, the two-step screen takes her authenticator code; "Use another way" lists "Security key (not on this device yet)", which says "This device can't use a security key with PassBundle yet...". With Duo added to an account (section 4), "Continue with Duo" opens Safari's sign-in sheet and comes back by itself.
- [ ] As Alex, an attachment saves to Files, On My iPhone, PassBundle. No Updates in Settings (updates come from the App Store or TestFlight, later).
- [ ] Not on iPhone yet: AutoFill, passkeys, and security keys or YubiKey codes over NFC at sign-in (section 6).

### Command-line tool

- [ ] As Alex Morgan, `passbundle login --apikey` with `PASSBUNDLE_CLIENTID` and `PASSBUNDLE_CLIENTSECRET` from his web vault's Settings, Security, Keys; then `passbundle unlock --passwordenv PB_MASTER_PASSWORD --raw` gives a session key. `passbundle list items` and `passbundle get password <item>` work.
- [ ] As Alex, `passbundle get totp`, `get item`, `get exposed`, `report password-health` (and `--no-check-exposed`), `generate --length 24 -ulns`, `export`, `get attachment`, `sync`, `lock`, `logout`.
- [ ] As Alex, `passbundle list templates` lists his own, then the built-ins; `get template "Wi-Fi network"`; `get history <item>` shows versions newest first.
- [ ] As Chloe Martin, `get password` and `get totp` on a Client portals item are refused: "You can't see this item's passwords: the shared folder it's in lets you use them, not see them." `get item` shows it without secrets; `edit item` with a password value, even the right one, is refused; `get history` shows when and who only; `export` leaves it out.
- [ ] As Tom Alvarez, `passbundle list collections` shows Vendors' permissions; deleting a Vendors item is refused.
- [ ] As Tom, `passbundle login` with his email and master password on a computer where the CLI hasn't signed in as him: it prints the number and waits; approve it in his web vault. The CLI can never approve others.
- [ ] As Grace Liu, `passbundle login --apikey`: her own items work, but `list org-members` and `confirm org-member` answer 401 (two-step login for admins: admin work needs a password sign-in with two-step login). `passbundle login` with her password and `--method 0 --code <code from code grace>`: they work.
- [ ] As Alex, `export BW_SESSION=...`: ignored. Make the data folder group-writable (Mac and Linux): the tool refuses it. `passbundle update` only says where to download.
- [ ] As Alex, `passbundle serve` listens on localhost; `--hostname all` is refused without `--unsafe-network`.
- [ ] Sign in with single sign-on (`passbundle login --sso <identifier>`) needs a real tenant: section 4.

## 4. Real hardware and real accounts

**YubiKey**
- [ ] (changes the seed) **As a security key:** as Alex Morgan, web vault, Settings, Security, Two-step login, add the YubiKey as a security key. Sign in with it in the web vault (the key step runs in a frame) and the extension (it opens a tab), in Chrome, Edge, and Firefox. Then in each app: the Mac and Linux with it plugged in (touch it when it blinks), Windows through Windows' own dialog (it asks for the key's PIN if it has one), and the Pixel both ways (held to the back, and plugged in by USB-C, allowing PassBundle to use it). The iPhone says it can't yet. Cancel once while it waits. Remove the key afterwards.
- [ ] **A key with a PIN** on the Mac, Linux, or Pixel: "This security key asks for its PIN, which PassBundle can't send it yet. Use another way to sign in, or the web vault." Two keys plugged in at once are asked in turn.
- [ ] **A platform passkey as the second step** (Touch ID or iCloud Keychain on the Mac, Google Password Manager on the Pixel), added in the web vault: note whether the Mac and Android apps can use it (they reach only plugged-in or NFC keys).
- [ ] **YubiKey one-time code (OTP):** only if the test server has Yubico's keys set (otherwise YubiKey isn't offered in Settings, Two-step login). As Alex, add it, then sign in by touching it into the code field in the web vault and each app, and on the Pixel by holding it to the back. A keyboard layout that moves letters gets a sentence, not a refusal. Note that OTP doesn't count for two-step login for admins.
- [ ] **Security key for admins:** as Tom Alvarez promoted to admin (section 2), set up with a security key or passkey on "Set up two-step login to continue". Removing the last key ends his sessions at once.

**Duo**
- [ ] (changes the seed) With your own Duo account (an admin account gives the keys), as Alex add Duo in Settings, Security, Two-step login, then sign in with "Continue with Duo" in the web vault, the extension, and each app: the browser opens Duo's prompt, you approve, and the app finishes by itself (on Windows and Linux the browser may ask to open PassBundle first). Remove it afterwards. Duo with your own keys doesn't count for two-step login for admins; only the server's own Duo account does, if the test server has one.
- [ ] **Recovery code:** as Alex with a method added, sign in once in an app with the recovery code shown when he set it up (typed in capitals or in groups of four works too): the app says two-step login is off now and where to turn it on again.

**A real iPhone**
- [ ] Once a build can go to a device (Apple Developer account), redo the iPhone steps on a real phone: Face ID unlock, the keyboard and large text, Duo, and when they land, AutoFill and passkeys.

**Install commands on real computers**
- [ ] **Windows:** as Maya Chen, copy Northwind Dental's Windows command. On a Windows machine, put this repo's `installer/windows/Install-PassBundle.ps1` in a folder with an `app` folder (the Windows zip's `PassBundle` folder) and an `agent` folder (its `passbundle-agent.exe` and `passbundle-agent-host.exe`), and run the command in an administrator PowerShell. Check: PassBundle and the agent in Program Files, a Start menu shortcut, the agent in the Run key, the "PassBundle agent update" task, chrome://policy and edge://policy (password saving off, the extension's server, token, join secret, and fingerprint, NativeMessagingUserLevelHosts false). The app's sign-in says "Your organization's server: test.passbundle.com" with no Self-hosted choice, and Settings, Updates says it can't update itself and to update it the way it was installed. Run it again: nothing changes. `-Remove` leaves nothing.
- [ ] **Windows, Pinecrest:** Pinecrest Construction's command also turns off card and address autofill in Chrome, Edge, and Firefox (their policy pages show it). Rerun without those options: it takes back only what it set.
- [ ] **The join from a real install:** the scripts force-install placeholder extension IDs until the store listings exist, so the extension you loaded by hand doesn't get the token, and "Join Northwind Dental?" doesn't appear. Note if it does. When it can: the prompt shows Northwind's fingerprint phrase (compare with the console's), "Join" sends a join that waits for Grace's Confirm on the Members page (no email, so no domains, so never automatic here), and "Not now" asks again in 7 days.
- [ ] **Mac:** Northwind's two Mac commands: `make-profile.sh` writes `PassBundle.mobileconfig`, which only takes effect installed by an MDM (if you have one); `install-passbundle.sh` as root with PassBundle.app next to it installs the app with its agent (a menu-bar icon, started at login). `--remove` undoes it.
- [ ] **Linux:** Northwind's Linux command as root, with the tarball's `PassBundle` folder renamed `passbundle` next to `installer/linux/install-passbundle.sh`: the app in /opt/passbundle with a desktop entry, Chrome and Edge policies (chrome://policy), and `/etc/passbundle/policy.json` naming the server, so the app signs in there without asking. The app only says there's a new version.

**Windows Hello and Touch ID**
- [ ] **Windows Hello in the app:** on a Windows computer with a camera, a fingerprint reader, or a PIN-backed key, as Alex Morgan, Settings, Unlock, "Unlock with Windows Hello". Lock and unlock with it; cancel once (it stays locked, and no new prompt for 10 seconds). With "Confirm before approving" on, approving a sign-in uses Windows Hello.
- [ ] **Windows Hello in the extension:** with the "Windows Hello test kit" from a run on main (its README), which brings an extension the agent accepts: turn on "Unlock with biometrics" in the extension, lock, and unlock with Windows Hello. `Try-WindowsHello.ps1 -Remove` cleans up.
- [ ] **Touch ID:** not offered yet (it waits on Apple signing). Note if it appears.

**Autofill on real sites (the part people judge us on)**

On a real computer and the Pixel, with logins saved for each:
- [ ] Your bank, your email (Gmail, Outlook), Microsoft 365 sign-in (email first, password on the next page), a site with a separate username and password page, a site with two-step codes (the code fills or copies).
- [ ] Your router's admin page (an IP address). It gets no site icon and no change-password lookup.
- [ ] **Open and fill** on three real sites: it fills once, never submits, and a sign-in that bounces through another site (an identity provider) ends it.
- [ ] **Change password on the site:** on an account you can afford to lock yourself out of (a throwaway one, not your bank or email), Change password on the login's page in the extension. It opens the site's change-password page, saves a new password to the item first, fills the form, and submits it ("Password changed. The new one is saved in the item."). Sign in with the new password to check. On a site with a CAPTCHA or a code, it fills the form and asks you to finish. When the item asks "Did the new password work?", answer it, and try "Put the old password back" once. Close the tab partway once: the item asks too. Note any site where it couldn't find the form, and any non-English site (it can't tell, so it asks).
- [ ] A site you've never saved: after you sign in, PassBundle offers to save it, in our colors.
- [ ] Android apps: your bank's app, a social app, one that signs in with a WebView.
- [ ] Passkeys: create one on a site that offers it (passkeys.io, or your Google or Microsoft account if you're willing), then sign in with it, in the extension and on the Pixel.
- [ ] A real checkout (don't pay): the card and address fill, including a page that asks for payment after Continue.
- [ ] Note any site where the menu doesn't appear, fills the wrong field, or needs two clicks. These go into the autofill scoreboard; use "Report a problem with this site" for them too.

**Your real browser's passwords**
- [ ] (changes the seed) As Alex Morgan: "Import from your browser" with your real Chrome, Brave, Edge, Firefox, and Safari (Passwords app) on the Mac, and Chrome and Edge on Windows. Counts match what the browser had (on top of Alex's seeded items), nothing doubled, folders sensible, and the reminder says how to delete the export and turn off the browser's own saving. Delete the export, and `reset` afterwards so your real passwords don't stay on the test server.

**A real SIEM**
- [ ] As Grace Liu, Reporting, Event streaming (and as Maya Chen, the console's Event streaming for Harbor IT's feed): send events to a real SIEM you have, set up as docs/event-streaming.md says: Huntress (Syslog over TLS to its collector), Blumira (Webhook to its HTTP ingestion URL, with Authorization if it gives a token), or a Microsoft Sentinel workspace (the Logs Ingestion API destination). Press Test, do something in the organization, and find both in the SIEM. Turn the destination off and on, and note the change events (high severity) arriving.
- [ ] With syslog, try CEF once instead of JSON.

**Microsoft 365 (Entra), when the tenant is ready**
- [ ] **Provisioning:** as Grace Liu, Settings, Provisioning; "Create token"; paste the SCIM URL and token into an Entra enterprise app's Provisioning (Automatic), and "Test connection". Assign a test user in Entra and provision on demand: they appear waiting. "Let them in". Turn them off in Entra: revoked. Delete them in Entra: removed. Revoke the token: Entra quarantines the job after it fails. As Maya, the console's Entra ID sync shows the client's status.
- [ ] **Single sign-on:** register the app and set up Northwind Dental's Settings, Single sign-on with docs/sso-entra.md, verify a domain you control (the seeded .test domains can't be), then work through its "Checking it with a real tenant" list: the setup steps match Entra; Link SSO (Microsoft's account picker, the linking page naming the right account) and then sign in with Microsoft and unlock; someone invited without an account signing in and setting a master password; the ID token carrying email and xms_edov; a user not assigned to the app (AADSTS50105); a wrong or expired secret (AADSTS7000215); Require single sign-on with a member not linked yet (taken through linking after the password), and the owner's password sign-in left alone; Conditional Access requiring MFA; and a guest user linking only by their invited email. Account recovery and the link email need email (section 5).
- [ ] As Tom Alvarez (once linked), `passbundle login --sso <identifier>`: the web vault's page says it's for the command-line tool (Continue), then the server's page names the organization ("Continue to Microsoft"), then `passbundle unlock`.

## 5. Needs email on the test server (waiting on a sending provider)

The test server sends no email. These wait for a sending provider (docs/prelaunch.md, "Waiting on you"); on a server that sends email, try each:

- [ ] **Account recovery:** as Grace Liu, reset Tom Alvarez's master password; he signs in with the new one. Recovery enrollment when joining (the join prompt's paragraph about it), the disclosure at sign-up, Priya Shah's Helpdesk role recovering a member, MSP staff never recoverable, and Harbor IT's people refused recovering a client's own owners.
- [ ] **Invitations by email:** the invitation mail saying how long it works; "<email> joined <org>" to the inviter; upstream's "accepted your invitation, confirm them"; invitations that let people in with no click (invitation seals vouch only where email proves the address).
- [ ] **Install command joins:** email domains on the command ("Only these email domains can join"), joins at those domains let in with no click, the owners' emails about joins ("joined Northwind Dental with your IT provider's install command", "is waiting to join"), and the extension's "verify first" notice.
- [ ] **Email codes:** two-step login by email (set up, sign in, and the setup session after an email code for someone a rule covers); the new-device check's "Email me a code", "Email me a code in 24 hours" after "Can't use your other devices?", and the denial email ("A sign-in on a new device was denied").
- [ ] **Staff invitations by email**, and the limits on them (20 an hour, 3 a day to one address).
- [ ] **Site fixes applying by count:** a fix applies to everyone once three people with verified email addresses share it. With no email nobody is verified, so here only "Use for every client" applies one.
- [ ] **Single sign-on's link email** ("If you didn't do this, tell its administrator").
- [ ] **Event streaming's notice** when the server turns a destination off.
- [ ] **Legacy contacts' emails:** the invitation, a request starting, the reminder the day before, approved, rejected, and timed out.
- [ ] **The master password hint** by email.
- [ ] **Sign-up verification** (a public server verifies email addresses before sign-in by default).

## 6. Not built yet (don't test)

DESIGN or the apps say these aren't built; note it only if one appears:

- The Solo and Family presets (their onboarding, invite links or QR codes, automatic approval), and a legacy contact suggested at onboarding or a printable sheet for the family.
- Automatic import from the browsers (the desktop agent's import helper); guided import is built.
- Touch ID on the Mac; biometrics on Linux; the Linux agent and Linux packages; signed and notarized apps, the signed MSI, and the CLI's signed manifest.
- iPhone AutoFill, iPhone passkeys, security keys and YubiKey codes over NFC on iPhone, and any iPhone release.
- Push to phones while PassBundle is closed; the apps starting "Sign in with a device" themselves; a confirmation in the web vault's and extension's approval dialog; SSO sessions approving.
- Passkeys on computers (the desktop app only shows them); replacing an old passkey or choosing an existing login on phones.
- Single sign-on in the desktop and phone apps; trusted-device unlock; other identity providers.
- The nudge in the desktop and phone apps.
- Send, PIN unlock, archive, exports, imports (other than opening the web vault), custom templates, organization admin, and the MSP console in the desktop and phone apps.
- Filling one-time codes, cards, and identities on Android; filling in desktop apps.
- Typed template fields beyond text, hidden, and yes or no; a template date that sets Expires; a Templates view.
- A system notification from the desktop agent, and phone reminders while the app is closed; email reminders.
- Members' own passwords in the MSP console and in the apps.
- The domain breach report (waits on a Have I Been Pwned key), and upstream's data breach report without a key.
- Fill rules for everyone (PassBundle's signed site rules, "This didn't fill"); upstream's Fill Assist stays off.
- A Health page in the browser extension (upstream's is behind a feature flag this server doesn't turn on).
- Assisted password change in the apps, recipes for real sites, starting it from the web vault or from Health in the extension, and frames.
- Script access in the CLI, tokens bound to a machine, and a technician permission for it.
- The agent's report of browsers and profiles; browser extension management; Firefox's password manager in the install scripts.
- Moving a client between MSPs, linking an existing organization as a client, MSP sign-up on the hosted service, and key fingerprints when staff are added.
- Enrolling account recovery at unlock for organizations that turn it on later; "private items stay with the organization".
- An account key for Solo and Family accounts, and its recovery kit (DESIGN, "Account keys (open)").
- Store listings for the extensions (the install scripts' extension IDs are placeholders).

## 7. How it feels

- [ ] Light and dark on each platform: the web vault's graphite dark mode never reads green, menus are solid, nothing blurs. Anything hard to read, misaligned, or still looking like Bitwarden (slate-blue grays, pill buttons, Bitwarden-style illustrations on empty pages, a "Glass" theme).
- [ ] Words: look for "log in", "Log out", "2FA", "cancelled", "All vaults", "web app", or "vault" and "collection" where a folder is meant.
- [ ] The font is PassBundle's own everywhere (DevTools: no requests to Google's font servers). Switch the browser to Russian or Greek: those letters still draw.
- [ ] Phone at a small size and with large text.
- [ ] Twenty-odd personas signing in from one network, as on an office's onboarding day: nobody gets stuck. Ten wrong passwords for one person: the eleventh is refused even with the right one, while others on the same network sign in fine.
- [ ] Anything that took you longer than it should have.

## 8. When something's off

- [ ] Note the persona, the app and its version (Settings, Updates in the apps; the server's at https://test.passbundle.com/api/config), the time, what you did, what you expected, and a screenshot without anyone's credentials in it. "It feels clunky" is useful too.
- [ ] If it changed seeded data, say which step marked "(changes the seed)" you'd done, and whether you've run `reset` since.
