# The command-line tool

`passbundle` reads and changes your vault from a terminal or a script: pull a password into a deployment script, create items from a template while setting up a client, or check what a folder lets you do. It's PassBundle's build of the open-source Bitwarden command-line tool (passbundle-clients, `apps/cli`), so its commands are the ones Bitwarden's documents, under PassBundle's name, with PassBundle's rules on top: folder permissions, item templates, item history, and the sign-in rules your organization sets.

It runs on macOS (Apple silicon and Intel), Linux (x64 and arm64), and 64-bit Windows, as one program with nothing else to install.

## Install

Get the newest release from https://github.com/PimpinPumpkin/Passbundle/releases?q=cli-v&expanded=true (tagged `cli-v0.1.N`). Each has one archive per platform:

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

`SHA256SUMS` lists each file's SHA-256, and `manifest.json` names each archive with its size and SHA-256 and the passbundle-clients commit it was built from. When a release has `manifest.json.sig`, it's an Ed25519 signature with PassBundle's release key, over the line `PassBundle CLI release v1` and then the manifest's exact bytes. To check it with OpenSSL 3:

```sh
key=5db5f4827dab67b3d7ef0726a202921728e5159ee70199d6e4ea059a1e72b0c5
printf "$(printf '302a300506032b6570032100%s' "$key" | sed 's/../\\x&/g')" > release-key.der
{ printf 'PassBundle CLI release v1\n'; cat manifest.json; } > signed
openssl base64 -d -A -in manifest.json.sig > signature
openssl pkeyutl -verify -pubin -keyform DER -inkey release-key.der -rawin -in signed -sigfile signature
```

Then check your archive's SHA-256 against the manifest's. It's the same key the desktop apps' updates are signed with, over a different first line, so a signature for one can't pass for the other.

### Updates

The tool doesn't update itself. `passbundle --version` prints its version, and `passbundle update` says where to get the newest one (the releases page above); install it the same way.

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

`--passwordenv` names the variable that holds the master password, and `--passwordfile` a file whose first line it is, so neither shows up in your shell history or the process list.

### With your email and master password

```sh
passbundle login ana@example.com                       # asks for the password and the code
passbundle login ana@example.com --passwordenv PB_PW --method 0 --code 123456
```

`--method` is the two-step login method (0 an authenticator app, 1 email); `--code` its code.

### With your organization's single sign-on

If your organization signs you in with Microsoft Entra ID, link your account once in the web vault (the organization's menu, Link SSO), then:

```sh
passbundle login --sso contoso      # your organization's SSO identifier
```

The tool opens your browser to the web vault's sign-in page, which says it's for the command-line tool: press Continue, sign in with Microsoft, and the browser hands the sign-in back to the tool, which listens on `http://localhost` (the first free port of 8065 to 8070) on the computer you run it on. It also prints the address, for when no browser opens; open it in a browser on the same computer. Your master password still unlocks your vault: `passbundle unlock`.

The page never goes on by itself, so a link someone sends you can't start a sign-in for the tool: only press Continue for a sign-in you just started.

### What your organization's rules do here

- **Require single sign-on:** your password sign-in is sent to single sign-on. In a terminal, the tool opens it for you; with `--nointeraction` it says to run `passbundle login --sso <identifier>`. If your account isn't linked yet, it says to link it in the web vault first. An API key still signs in, as Bitwarden's does; your organization's Single sign-on page can replace members' API keys when it turns the requirement on.
- **Two-step login for admins:** where your organization or MSP requires it of your role, set up an authenticator app, a security key, or Duo in the web vault. Until you have, the server refuses your password and API key sign-ins and says why (the tool prints its message); once you have, `passbundle login` asks for its code (`--method 0 --code ...`). Email codes don't count for these roles.
- **Your vault timeout** doesn't apply: a session lasts until you `passbundle lock` or `passbundle logout`, or the server ends it.

## Sessions and environment variables

`unlock` prints a session key; every command that reads your vault needs it, from `PASSBUNDLE_SESSION` or `--session`. Anyone with the key and your data folder can read your vault, so keep it in a variable of the script that needs it, never in a file, and `passbundle lock` when you're done (which makes it useless).

| Variable | What it does |
|---|---|
| `PASSBUNDLE_SESSION` | The session key from `unlock` (or `--session <key>`) |
| `PASSBUNDLE_CLIENTID`, `PASSBUNDLE_CLIENTSECRET` | Your API key, for `login --apikey` |
| `PASSBUNDLE_NOINTERACTION` | `true`: never wait for someone to type (or `--nointeraction`); set it in every script |
| `PASSBUNDLE_RAW`, `PASSBUNDLE_RESPONSE`, `PASSBUNDLE_PRETTY`, `PASSBUNDLE_QUIET`, `PASSBUNDLE_CLEANEXIT` | `true`: as `--raw`, `--response`, `--pretty`, `--quiet`, `--cleanexit` |
| `PASSBUNDLE_APPDATA_DIR` | Where the tool keeps its data (below) |
| `PASSBUNDLE_DEBUG` | `true`: log more |

Scripts written for the Bitwarden tool work once `bw` becomes `passbundle` and `BW_` becomes `PASSBUNDLE_`. The tool ignores Bitwarden's own `BW_` variables, so a Bitwarden session or API key left in a shell is never sent to a PassBundle server.

Its data (the server, your encrypted vault, and tokens) is in `~/Library/Application Support/PassBundle CLI` on a Mac, `$XDG_CONFIG_HOME/PassBundle CLI` or `~/.config/PassBundle CLI` on Linux, and `%AppData%\PassBundle CLI` on Windows; a `passbundle-data` folder next to the program wins, for a portable copy. Use a data folder per account to run several at once.

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

`passbundle serve` answers the same commands over HTTP on `localhost` (`--port`, default 8087), for tools that would rather call an API; anything on the computer can reach it while it runs, so start it only where that's fine.

## See passwords

A shared folder can let someone use its items' passwords without seeing them (the "Can view but not see passwords" preset, or "See passwords" off in a custom grid; DESIGN.md, "Folders and permissions"). The tool follows the same rule as the web vault, the extension, and the apps, from the same list of what's plain (`libs/common/src/vault/keykeeper/hidden-secrets.ts`): only an item that says you may see its passwords shows them.

For an item you can't see the passwords of:

- `get item`, `list items`, and `serve` give its plain values only: its name, notes, websites, username, a card's holder, brand, and expiry, an identity's name and contact details, an SSH key's public key, and the like. Its secrets (password, one-time code, card number and code, SSN, passport and license numbers, private key, bank account number, PIN, IBAN, SWIFT, hidden fields, linked fields that fill a secret) are empty, and its passkeys and password history aren't there at all. Hidden fields stay listed by name, without values.
- `get password`, `get totp`, and `get exposed` refuse it: "You can't see this item's passwords: the shared folder it's in lets you use them, not see them."
- `edit item` keeps its secrets as they are: send them back empty, as `get item` shows them, and they're kept. A request with any value for one is refused, even its real value (so an edit can't be used to check a guess), and so is adding or removing a hidden field, or changing the item's type.
- `report password-health` leaves it out, so it can't tell you whether its password is weak, breached, or the same as one of yours.
- `get history` shows when it changed and by whom, never earlier values.

Anyone who can decrypt an item can take it apart with their own tools, which is why the server enforces what it can (who reaches a folder, and who can edit, delete, or read history there) and the apps enforce the rest; see DESIGN.md, "What the server enforces, and what the apps do".

## Templates and history

- `passbundle list templates` lists what the web vault's "New item from a template" offers: each MSP's templates, each organization's, your own, then the built-in ones (API key, server, database, Wi-Fi network, router, software license, domain, certificate, email account, membership). `passbundle get template <id or name>` gives a new item from one, to fill in and `create`. Upstream's JSON templates (`get template item`, `get template folder`) are still there.
- `passbundle get history <item>` lists an item's earlier versions, newest first, with when and by whom (by name where you may list the organization's members). The server shows them only where a folder lets you view the item's history. Restoring or deleting versions is in the web vault and the extension.

## What it doesn't do

- Updating itself (see Updates).
- Secrets Manager: upstream's separate tool isn't part of PassBundle. Script access tokens, for scripts that shouldn't hold a person's account, are the PowerShell module in docs/script-access.md.
- Signing in with a device's approval, and unlocking with a key connector or a trusted device (PassBundle has neither yet).
- Making accounts or organizations, and organization administration beyond what upstream's tool does (listing and confirming members, folders and their access).

## Building it yourself

From a passbundle-clients checkout with its dependencies installed (`npm ci`), and this repository's `tools/cli` with its own (`npm ci --ignore-scripts`):

```sh
tools/cli/pack.sh ../passbundle-clients 0.1.0-local macos-arm64 out
```

It applies the brand with that version (`BRAND_CLI_VERSION`, for `brand/apply.mjs`), builds `apps/cli` for production, packs it with Node.js 24 for the platform (with pkg, as upstream packs its open-source build, at a version pinned in `tools/cli/package-lock.json`; pkg downloads its Node.js build from its own GitHub releases and checks its SHA-256), checks the program's version and help, and puts the brand back. Platforms are `linux-x64`, `linux-arm64`, `macos-x64`, `macos-arm64`, and `win-x64`, each built on a computer of that kind. Without packing, `npm run build:oss:prod` in `apps/cli` after `node brand/apply.mjs` gives `apps/cli/build/bw.js`, which runs with `node`.

## Releases

`.github/workflows/cli-release.yml`, started by hand from main with the passbundle-clients branch or commit to build (by default `keykeeper`, whose tier 1 checks have passed): a plan job, a build per platform with no secrets, a sign job that alone may hold the release key and runs nothing from any repository, and a publish job that alone can write. Releases are tagged `cli-v<major>.<minor>.<run number>`, never marked as this repository's latest, and carry the five archives, `manifest.json`, `SHA256SUMS`, and, once this repository has the release key, `manifest.json.sig`.

## Tests

Jest in passbundle-clients for everything PassBundle changes in the tool (`apps/cli/src/keykeeper/*.spec.ts`, and upstream's specs for the commands it touches), and tier 1 here, which builds the tool as a release does (`tools/cli/pack.sh`, Linux x64) and runs `e2e/tests/cli` against the test server: a member signs in with an API key, unlocks, lists items, gets a password from a folder where she may see passwords and is refused one where she may not (by id, by search, its code, its breach count), gets that item's plain values, each folder's permissions, item history with and without earlier values, and templates; Bitwarden's variables are ignored and the brand's work; every command's help names PassBundle, never Bitwarden; single sign-on through the web vault and the Entra stand-in back to the tool's listener; and, with Require single sign-on, what a script is told, and an API key still signing in. `e2e/tests/api/sso.spec.ts` checks the server takes the tool's listener for the tool only.
