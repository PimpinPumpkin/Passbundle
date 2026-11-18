# The command-line tool

`passbundle` reads and changes your vault from a terminal or a script: pull a password into a deployment script, create items from a template while setting up a client, or check what a folder lets you do. It's PassBundle's build of the open-source Bitwarden command-line tool (passbundle-clients, `apps/cli`), so its commands are the ones Bitwarden's documents, under PassBundle's name, with PassBundle's rules on top: folder permissions, item templates, item history, and the sign-in rules your organization sets.

It runs on macOS (Apple silicon and Intel), Linux (x64 and arm64), and 64-bit Windows, as one program with nothing else to install.

## Install

No release has been published yet. Until the first one, build it yourself ("Building it yourself" below). Releases will be at https://github.com/PimpinPumpkin/Passbundle/releases?q=cli-v&expanded=true (tagged `cli-v0.1.N`), each with one archive per platform:

| File | For |
|---|---|
| `passbundle-<version>-macos-arm64.tar.gz` | Macs with Apple silicon |
| `passbundle-<version>-macos-x64.tar.gz` | Intel Macs |
| `passbundle-<version>-linux-x64.tar.gz` | 64-bit Intel and AMD Linux |
| `passbundle-<version>-linux-arm64.tar.gz` | 64-bit ARM Linux |
| `passbundle-<version>-windows-x64.zip` | 64-bit Windows 10 and 11 |

macOS and Linux, for yourself:

```sh
version=0.1.5   # the release you picked
curl -LO "https://github.com/PimpinPumpkin/Passbundle/releases/download/cli-v$version/passbundle-$version-linux-x64.tar.gz"
curl -LO "https://github.com/PimpinPumpkin/Passbundle/releases/download/cli-v$version/SHA256SUMS"
shasum -a 256 -c SHA256SUMS --ignore-missing
mkdir -p ~/.local/bin && tar -xzf "passbundle-$version-linux-x64.tar.gz" -C ~/.local/bin passbundle
passbundle --version
```

For everyone on the computer, extract it into `/usr/local/bin` instead (with `sudo`). On a Mac, a copy downloaded with a browser is quarantined and Gatekeeper stops it (it's signed ad hoc, not by Apple yet): download with `curl` as above, or run `xattr -d com.apple.quarantine passbundle` once.

Windows (PowerShell): extract the zip, put `passbundle.exe` in a folder of your own such as `%LOCALAPPDATA%\Programs\PassBundle`, and add that folder to your PATH. SmartScreen may warn the first time (it isn't code-signed yet): More info, then Run anyway.

### Checking a download

`SHA256SUMS` lists each file's SHA-256, and `manifest.json` names each archive with its size and SHA-256 and the passbundle-clients commit it was built from. When a release has `manifest.json.sig`, it's an Ed25519 signature with the CLI release key, over the line `PassBundle CLI release v1` and then the manifest's exact bytes. The CLI release key is its own key, not the desktop apps' update key. Its public key is:

```
(not made yet: until it is, a release has no manifest.json.sig, so check it against SHA256SUMS)
```

To check a signature with OpenSSL 3, with that public key's 64 hex digits:

```sh
key=<the CLI release key's public key>
printf "$(printf '302a300506032b6570032100%s' "$key" | sed 's/../\\x&/g')" > cli-release-key.der
{ printf 'PassBundle CLI release v1\n'; cat manifest.json; } > signed
openssl base64 -d -A -in manifest.json.sig > signature
openssl pkeyutl -verify -pubin -keyform DER -inkey cli-release-key.der -rawin -in signed -sigfile signature
```

Then check your archive's SHA-256 against the manifest's.

### Updates

`passbundle update --check` says whether there's a newer release, and `passbundle update` installs it in place of the program you ran. Nothing checks by itself: a script's tool never changes under it. `passbundle --version` prints the version you have.

```sh
passbundle update --check          # says what's available; changes nothing
passbundle update --check --raw    # only the newer version, or nothing
passbundle update
```

Until the CLI release key is made (below), releases aren't signed, and both say updates aren't available yet: install the newest release the way you installed this one.

What `update` checks before it changes anything (DESIGN.md, "Command-line tool", "Updating itself"):

- It asks GitHub's API for this repository's releases tagged `cli-v...` that are newer than your copy, and takes files only from GitHub's own addresses over HTTPS, never anywhere a redirect points elsewhere.
- The release's `manifest.json` must be signed with the CLI release key, which is compiled into the tool; a release without `manifest.json.sig` is refused as unsigned.
- The manifest must be the command-line tool's, for that release's tag and version, newer than your copy, and name exactly one archive for your computer. The archive must have the manifest's size and SHA-256, and hold only the program, `LICENSE.txt`, and `README.txt`.
- The new program must start and say it's that version.

Where it puts it:

- **macOS and Linux:** it writes the new program next to the old one and renames it over the old one in one step, keeping the old one's permissions. A copy that's running keeps running.
- **Windows:** a running program can't be replaced, so it renames `passbundle.exe` to `passbundle.exe.old` and puts the new one in its place; the next time the tool starts, it deletes the `.old` file. If an earlier update's `.old` is still running, `update` stops and says so: close it and run `update` again.

Where it won't, it says how to update instead and changes nothing: when you run it as root (or `sudo`), or as an administrator on Windows; when the program is in a system or package manager's place (`/usr/local/bin`, `/opt`, Homebrew's, Program Files, Scoop's, and the like); or when the program or its folder isn't yours alone (someone else owns it, or others can change it). Install the new release there the way you installed this one. So a copy you installed for yourself (`~/.local/bin`, `%LOCALAPPDATA%\Programs\PassBundle`) updates itself, and one installed for everyone on the computer is updated by whoever installed it. `update --check` still reports in either case.

It goes through `https_proxy` (or `http_proxy`) when one is set, and sends no GitHub token.

## Sign in

The tool talks to PassBundle's own service, `https://vault.passbundle.com`, unless you point it at your MSP's or your own server:

```sh
passbundle config server https://vault.example.com
passbundle config server                    # shows the server it uses
passbundle config server vault.passbundle.com   # back to PassBundle's
```

Sign out first to change it. A server with a certificate from a private certificate authority needs that authority's certificate: `export NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.

### With an API key (for scripts)

Each person's API key is under Settings, Security, Keys, View API key in the web vault. It signs in without the master password or two-step login, but the vault stays locked until the master password unlocks it:

```sh
export PASSBUNDLE_CLIENTID='user.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
export PASSBUNDLE_CLIENTSECRET='...'
passbundle login --apikey
export PASSBUNDLE_SESSION="$(passbundle unlock --passwordenv PB_MASTER_PASSWORD --raw)"
```

`--passwordenv` names the variable that holds the master password, and `--passwordfile` a file whose first line it is, so neither shows up in your shell history or the process list. Typed as an argument instead (`passbundle unlock <password>`), it still works, and the tool warns that other programs on the computer can read it.

### With your email and master password

```sh
passbundle login ana@example.com                       # asks for the password and the code
passbundle login ana@example.com --passwordenv PB_MASTER_PASSWORD --method 0 --code 123456
```

`--method` is the two-step login method (0 an authenticator app, 1 email); `--code` its code.

### With another device's approval

On a computer where the tool has signed in to your account before, it can sign in again without your master password: a device where you're signed in with your master password (the web vault, the browser extension, or PassBundle's app) approves it.

```sh
passbundle login ana@example.com --device
```

The tool prints a fingerprint phrase first (five words), then waits up to 15 minutes. On the other device, open the request (in the web vault: Settings, Security, Devices, then the device with "Request pending"; the extension and the app show it themselves), and approve it only if it shows the same phrase and you started this sign-in yourself. The tool then signs in and unlocks, and prints your session key as a password sign-in does. Ctrl-C stops it; nothing is signed in, and the request expires on the server.

- It works only on a computer where the tool signed in to your account before (with your password or an API key) and kept its data folder, as the web vault and the extension only offer it on a browser that signed in before. Elsewhere it says to sign in once first.
- Two-step login still applies: the tool asks for its code as after a password (`--method` and `--code` in a script).
- If your organization requires single sign-on, an approval doesn't stand in for it: the tool says to run `passbundle login --sso <identifier>`. Where two-step login for admins refuses it, the tool prints the server's message.
- A session the tool starts this way can't approve another device's sign-in.

### With your organization's single sign-on

If your organization signs you in with Microsoft Entra ID, link your account once in the web vault (the organization's menu, Link SSO), then:

```sh
passbundle login --sso contoso      # your organization's SSO identifier
```

The tool opens your browser to the web vault's sign-in page, which says it's for the command-line tool: press Continue. Then PassBundle's server asks once more, on a page of its own naming the organization and the address the sign-in goes back to: press Continue to Microsoft, sign in, and the browser hands the sign-in back to the tool, which listens on `http://localhost` (the first free port of 8065 to 8070) on the computer you run it on. The tool also prints the first address, for when no browser opens; open it in a browser on the same computer. Your master password still unlocks your vault: `passbundle unlock`.

Neither page goes on by itself, whatever the link that opened it says (an organization's identifier, or your email), and the server's Continue works only from its own page, in the browser it was shown in, once, within ten minutes. So a link someone sends you can't sign in the tool, or something else listening on that port (another person's program, on a shared server), without your two clicks: press Continue only for a sign-in you just started.

### What your organization's rules do here

- **Require single sign-on:** your password sign-in is sent to single sign-on. In a terminal, the tool opens it for you; with `--nointeraction` it says to run `passbundle login --sso <identifier>`. If your account isn't linked yet, it says to link it in the web vault first. An API key still signs in, as Bitwarden's does; your organization's Single sign-on page can replace members' API keys when it turns the requirement on.
- **Two-step login for admins** (DESIGN.md, "Two-step login for admins"): where your organization requires it of your role (owners, admins, custom roles that manage members, policies, or account recovery, and an MSP's staff; or every member, where it requires it of everyone, DESIGN.md "Two-step login for everyone"), a password sign-in needs an authenticator app, a security key, or Duo; email codes don't count. With one set up, `passbundle login` asks for its code (`--method 0 --code ...` for an authenticator app). Without one, the server refuses, and the tool prints its message, which says to set it up in the web vault; the tool can't set it up. Your organization's own single sign-on meets the requirement for admins and custom roles, never for owners or an MSP's staff. An API key skips two-step login, as Bitwarden's does, so it's refused for someone the rule covers who has no method that counts; once they have one it signs in, but the server refuses its session any admin work (`list org-members`, `confirm org-member`, creating or editing an organization's collections, the MSP console's own endpoints) with a 401. Your own vault's items and folders work as usual. For admin work, sign in with your password and two-step login.
- **Your vault timeout** doesn't apply: a session lasts until you `passbundle lock` or `passbundle logout`, or the server ends it.
- **Master password re-prompt:** an item marked for it asks for your master password again in the tool too ("Items that ask for the master password again" below).

## Sessions and environment variables

`unlock` prints a session key; every command that reads your vault needs it, from `PASSBUNDLE_SESSION`. Anyone with the key and your data folder can read your vault, so keep it in a variable of the script that needs it, never in a file or on a command line, and `passbundle lock` when you're done (which makes it useless). Give the session key and the master password through variables only: the tool still takes `--session <key>` and a password typed as an argument, and warns each time, since other programs on the computer can read a command line and your shell may keep it.

| Variable | What it does |
|---|---|
| `PASSBUNDLE_SESSION` | The session key from `unlock` |
| `PASSBUNDLE_CLIENTID`, `PASSBUNDLE_CLIENTSECRET` | Your API key, for `login --apikey` |
| `PASSBUNDLE_NOINTERACTION` | `true`: never wait for someone to type (or `--nointeraction`); set it in every script |
| `PASSBUNDLE_RAW`, `PASSBUNDLE_RESPONSE`, `PASSBUNDLE_PRETTY`, `PASSBUNDLE_QUIET`, `PASSBUNDLE_CLEANEXIT` | `true`: as `--raw`, `--response`, `--pretty`, `--quiet`, `--cleanexit` |
| `PASSBUNDLE_APPDATA_DIR` | Where the tool keeps its data (below) |
| `PASSBUNDLE_DEBUG` | `true`: log more |

Scripts written for the Bitwarden tool work once `bw` becomes `passbundle` and `BW_` becomes `PASSBUNDLE_`. The tool ignores Bitwarden's own `BW_` variables, so a Bitwarden session or API key left in a shell is never sent to a PassBundle server.

Its data is in `~/Library/Application Support/PassBundle CLI` on a Mac, `$XDG_CONFIG_HOME/PassBundle CLI` or `~/.config/PassBundle CLI` on Linux, and `%AppData%\PassBundle CLI` on Windows, or wherever `PASSBUNDLE_APPDATA_DIR` says (one per account to run several at once). Its `data.json` holds the server's address, your encrypted vault, your session's tokens, and, after `login --apikey`, your API key's client secret, readable as it is. Anyone who can read it can sign in as you without your master password (and read your vault with your session key too), so:

- The tool refuses a data folder someone else owns, or that others can change (Mac and Linux), and says how to fix it. It makes a new one yours alone (0700 on Mac and Linux; on Windows, an access list for you alone), and sets `data.json` to 0600 every time it starts.
- Replace your API key (Settings, Security, Keys, Rotate API key) if a copy of the folder may have got out, and `passbundle logout` on a computer you're done with.
- There's no portable mode: a folder next to the program isn't used.

## Common scripting

Everything prints JSON (`--pretty` to read it, `--raw` for a single value, `--response` for `{"success": ..., "data": ...}` with errors as JSON too). A command that fails exits with 1, unless `--cleanexit`.

```sh
export PASSBUNDLE_NOINTERACTION=true

# A password into a variable, by id, or by a search that finds one item.
db_password="$(passbundle get password 7cbd0d22-87c5-4c6d-b2a1-ae6f0115d1a3)"
db_password="$(passbundle get password 'SQL prod')"

# The username and a one-time code.
passbundle get username 'SQL prod'
passbundle get totp 'Domain admin'

# Every item in a shared folder, as names and usernames (with jq).
passbundle list items --collectionid "$folder_id" | jq -r '.[] | [.name, .login.username] | @tsv'

# A custom field's value.
passbundle get item 'Router' | jq -r '.fields[] | select(.name == "Wi-Fi password") | .value'

# What you can do in each shared folder.
passbundle list collections | jq '.[] | {name, permissions}'

# A new item from one of your templates, into a client's folder.
passbundle list templates | jq -r '.[] | [.id, .group, .name] | @tsv'
passbundle get template "Wi-Fi network" \
  | jq --arg org "$org_id" --arg folder "$folder_id" \
      '.name = "Office Wi-Fi" | .organizationId = $org | .collectionIds = [$folder]
       | (.fields[] | select(.name == "Network name")).value = "Contoso-Guest"
       | (.fields[] | select(.name == "Password")).value = "correct horse staple"' \
  | passbundle encode | passbundle create item

# Generate a password and change an item's.
new="$(passbundle generate --length 24 -ulns)"
passbundle get item "$id" | jq --arg p "$new" '.login.password = $p' | passbundle encode | passbundle edit item "$id"

# An item's earlier versions (who changed it and when; the old values where you may see them).
passbundle get history "$id" | jq '.[] | {revisionDate, savedBy, password: .item.login.password}'

passbundle sync     # get changes made elsewhere since unlocking
passbundle lock
```

PowerShell:

```powershell
$env:PASSBUNDLE_NOINTERACTION = 'true'
$env:PASSBUNDLE_SESSION = passbundle unlock --passwordenv PB_MASTER_PASSWORD --raw
$item = passbundle get item 'SQL prod' | ConvertFrom-Json
$cred = [pscredential]::new($item.login.username, (ConvertTo-SecureString $item.login.password -AsPlainText -Force))
```

## Items that ask for the master password again

An item marked "Master password re-prompt" (in the web vault's or the app's item editor) asks for your master password before the tool shows or changes its secrets: `get item`, `get password`, `get totp`, `get notes`, `get exposed`, `get attachment`, and `edit item`, and an `export` that would write one. In a terminal, the tool asks once for the command; a wrong password refuses.

```sh
passbundle get password 'Domain admin'          # in a terminal: asks for the master password
passbundle get password 'Domain admin' --reprompt-ok   # a script approved to read such items
```

- **In a script** (with `--nointeraction` or `PASSBUNDLE_NOINTERACTION`, or when its input or error output isn't a terminal, as under cron, CI, or an RMM), it can't ask, so it refuses and says so. Add `--reprompt-ok` to each command of a script that was approved to read or change such items. There's no environment variable for it, so it can't be switched on for a whole shell by accident.
- **Everywhere else** (`list items`, `get history`, and the item `create` and `edit` answer with), such an item shows its plain values only, as an item you can't see the passwords of does (below), and its notes empty too.
- **`serve`** never asks: it refuses those routes for such an item, and lists its plain values only, unless you start it with `passbundle serve --reprompt-ok`. A request can't turn that on.
- An account without a master password (one that unlocks with a key connector) isn't asked, as in the web vault.

Re-prompt is a second check against someone using your unlocked session, not encryption: anyone with your session key and data folder could decrypt the item with their own tools.

## The local API

`passbundle serve` answers the same commands over HTTP (`--port`, default 8087), for tools that would rather call an API. Whatever reaches it can read and change your vault while it's unlocked, without your session key or master password, so:

- It listens only where this computer alone can reach it: `localhost` (the default), `127.x.x.x`, `::1`, or a Unix socket (`--hostname unix:///path`). Any other address, every interface (`all`) included, needs `--unsafe-network`, and is your call: only behind something else that limits who reaches it.
- Even on `localhost`, every program and every person on the computer can reach it while it runs, so start it only where that's fine (not on a shared server or jump box) and stop it when you're done. It refuses requests from web pages (their `Origin`) and to host names it doesn't expect.
- It never asks for the master password: an item marked "Master password re-prompt" gives its plain values only, and its secrets are refused, unless you start it with `--reprompt-ok` (above).

## See passwords

A shared folder can let someone use its items' passwords without seeing them (the "Can view but not see passwords" preset, or "See passwords" off in a custom grid; DESIGN.md, "Folders and permissions"). The tool follows the same rule as the web vault, the extension, and the apps, from the same list of what's plain (`libs/common/src/vault/keykeeper/hidden-secrets.ts`): only an item that says you may see its passwords shows them.

For an item you can't see the passwords of:

- `get item`, `list items`, and `serve` give its plain values only: its name, notes, websites, username, a card's holder, brand, and expiry, an identity's name and contact details, an SSH key's public key, and the like. Its secrets (password, one-time code, card number and code, SSN, passport and license numbers, private key, bank account number, PIN, IBAN, SWIFT, hidden fields, linked fields that fill a secret) are empty, and its passkeys and password history aren't there at all. Hidden fields stay listed by name, without values.
- `get password`, `get totp`, and `get exposed` refuse it: "You can't see this item's passwords: the shared folder it's in lets you use them, not see them."
- `edit item` keeps its secrets as they are: send them back empty, as `get item` shows them, and they're kept. A request with any value for one is refused, even its real value (so an edit can't be used to check a guess), and so is adding or removing a hidden field, or changing the item's type.
- `report password-health` leaves it out, so it can't tell you whether its password is weak, breached, or the same as one of yours.
- `get history` shows when it changed and by whom, never earlier values.
- `export` never puts it in a file: your own export holds only your own items, and an organization's export needs the export permission in every one of its folders you reach, which only comes with see passwords (owners and admins, who see everything, export everything).
- Item templates made from it come without its hidden defaults.
- Its attachments still download (`get attachment`), as in the web vault and the extension: they're part of seeing the item, which the server decides, not of seeing its passwords.

Breach checks: `get exposed` and `report password-health` ask Have I Been Pwned's Pwned Passwords service (`api.pwnedpasswords.com`) about passwords you can see, sending only the first 5 characters of each one's SHA-1 hash (k-anonymity); `report password-health --no-check-exposed` sends nothing.

Anyone who can decrypt an item can take it apart with their own tools, which is why the server enforces what it can (who reaches a folder, and who can edit, delete, or read history there) and the apps enforce the rest; see DESIGN.md, "What the server enforces, and what the apps do".

## Templates and history

- `passbundle list templates` lists what the web vault's "New item from a template" offers: each MSP's templates, each organization's, your own, then the built-in ones (API key, server, database, Wi-Fi network, router, software license, domain, certificate, email account, membership). `passbundle get template <id or name>` gives a new item from one, to fill in and `create`. Upstream's JSON templates (`get template item`, `get template folder`) are still there.
- `passbundle get history <item>` lists an item's earlier versions, newest first, with when and by whom (by name where you may list the organization's members). The server shows them only where a folder lets you view the item's history. Restoring or deleting versions is in the web vault and the extension.

## What it doesn't do

- Checking for updates by itself (`passbundle update` does when you run it; see Updates).
- Secrets Manager: upstream's separate tool isn't part of PassBundle. Script access tokens, for scripts that shouldn't hold a person's account, are the PowerShell module in docs/script-access.md.
- Approving another device's sign-in (it only asks), and unlocking with a key connector or a trusted device (PassBundle has neither yet).
- Making accounts or organizations, and organization administration beyond what upstream's tool does (listing and confirming members, folders and their access).

## Building it yourself

From a passbundle-clients checkout with its dependencies installed (`npm ci`), and this repository's `tools/cli` with its own (`npm ci --ignore-scripts`):

```sh
tools/cli/pack.sh ../passbundle-clients 0.1.0-local macos-arm64 out
```

It applies the brand with that version (`BRAND_CLI_VERSION`, for `brand/apply.mjs`), builds `apps/cli` for production, packs it with Node.js 24 for the platform (with pkg, as upstream packs its open-source build, at a version pinned in `tools/cli/package-lock.json`; pkg downloads its Node.js build from its own GitHub releases and checks its SHA-256), checks the program's version and help, and puts the brand back. Platforms are `linux-x64`, `linux-arm64`, `macos-x64`, `macos-arm64`, and `win-x64`, each built on a computer of that kind. Without packing, `npm run build:oss:prod` in `apps/cli` after `node brand/apply.mjs` gives `apps/cli/build/bw.js`, which runs with `node`.

## Releases

`.github/workflows/cli-release.yml`, started by hand from main with the passbundle-clients branch or commit to build (by default `keykeeper`; it refuses anything that isn't on `keykeeper`, whose tier 1 checks have passed): a plan job, a build per platform with no secrets (Node.js 24.21.0 pinned for the build), a sign job that alone may hold the CLI release key and runs nothing from any repository, and a publish job that alone can write. Releases are tagged `cli-v<major>.<minor>.<run number>`, never marked as this repository's latest, and carry the five archives, `manifest.json`, `SHA256SUMS`, and, once the CLI release key is made, `manifest.json.sig`. No release has been published yet: the first is a run the owner starts.

### The CLI release key

An Ed25519 key of its own, for the command-line tool's releases only (the desktop apps' update key stays theirs). Until it's made, releases go out with `SHA256SUMS` and an unsigned manifest. The owner makes it once, on their own computer, with OpenSSL 3:

```sh
umask 077
openssl genpkey -algorithm ed25519 -out passbundle-cli-release.pem
# Its public key, as 64 hex digits:
openssl pkey -in passbundle-cli-release.pem -pubout -outform DER | tail -c 32 | od -An -tx1 | tr -d ' \n'; echo
```

Then:

1. Add the private key as a secret named `PASSBUNDLE_CLI_RELEASE_KEY`, best in an environment named `cli-release` whose deployment rule allows only `main` (Settings, Environments; then uncomment `environment: cli-release` in the workflow's sign job), or as a repository secret: `gh secret set PASSBUNDLE_CLI_RELEASE_KEY -R PimpinPumpkin/Passbundle --env cli-release < passbundle-cli-release.pem` (without `--env` for a repository secret).
2. Put the public key's 64 hex digits in the workflow (`CLI_RELEASE_PUBLIC_KEY`) and in "Checking a download" above, in one commit, and in passbundle-clients' `brand/brand.json` (`cli.releaseKeys`, a list), which compiles it into the tool for `passbundle update`. Tier 1 checks the workflow's key is in that list, and that the list is empty while the workflow pins none. A secret without that pin, or that doesn't match it, stops the release rather than signing. Copies built before the key was in `releaseKeys` say updates aren't available: install the first signed release by hand.
3. Keep `passbundle-cli-release.pem` offline (a password manager's attachment or an encrypted drive), and delete the copy you made it in.

Replacing it: make a new one the same way. First add its public key to `cli.releaseKeys` in passbundle-clients (keeping the old one) and release that, signed with the old key, so copies learn the new key. Once copies have had time to update, change the secret and both pins in one commit. Drop the old key from `cli.releaseKeys` in a later release. Releases signed with the old key still check with the old public key, which "Checking a download" should then list as the key for releases before the change. If the key leaks, do it all at once: a release signed with the old key that lists only the new one.

## Tests

Jest in passbundle-clients for everything PassBundle changes in the tool (`apps/cli/src/keykeeper/*.spec.ts`, and upstream's specs for the commands it touches), and tier 1 here, which builds the tool as a release does (`tools/cli/pack.sh`, Linux x64) and runs `e2e/tests/cli` against the test server: a member signs in with an API key, unlocks, lists items, gets a password from a folder where she may see passwords and is refused one where she may not (by id, by search, its code, its breach count), gets that item's plain values, each folder's permissions, item history with and without earlier values, and templates; Bitwarden's variables are ignored and the brand's work; every command's help names PassBundle, never Bitwarden; every kind of item's plain values only, through `get`, `list`, `serve`, and export; `serve` refusing to listen beyond this computer; a warning for a session key on the command line; a data folder others can change refused; single sign-on through the web vault's page and the server's own page and the Entra stand-in back to the tool's listener (on the next port when the first is taken), and a link with only an email never starting it; and, with Require single sign-on, what a script is told, and an API key still signing in; a sign-in the web vault approves (`login --device`), after which the tool lists items; an item marked "Master password re-prompt" refused to a script's `get password` and given with `--reprompt-ok`; and `update` saying updates aren't available while no key is made, with the workflow's key and the tool's agreeing. Jest covers each of `update`'s checks against a stand-in for GitHub (never a real release) and its test vectors (`docs/vectors/cli-update-v1.json`), putting the program in place on macOS, Linux, and Windows with a stand-in file system, the device sign-in's phrase, waits, denial, expiry, and Ctrl-C, and re-prompt in each command and in `serve`. `e2e/tests/api/sso.spec.ts` checks the server takes the tool's listener for the tool only, and that its authorize answers with a page, never Microsoft, whose Continue works only same-origin, with its cookie, once.
