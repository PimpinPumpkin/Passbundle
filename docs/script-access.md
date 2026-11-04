# Script access

Design, October 2026, with the decisions at the end made on October 20. It changes how keys are handled, so per the rule in DESIGN.md, this note and its test vectors (`docs/vectors/script-access-v1.json`) come before the code.

Designed from public descriptions of how such tools work in general. Never from Bitwarden's Secrets Manager code or SDK, which we don't read (CLEAN_ROOM.md).

## The problem

An MSP's RMM (NinjaOne, Datto, ConnectWise, Intune) runs scripts on clients' machines, and many of those scripts need a credential: a domain admin account to join a machine, a Wi-Fi password to push, an API key for a backup agent. Today that credential is pasted into the RMM, where anyone with RMM access can read it, it never changes, and nobody knows when it was used.

Script access lets a script fetch exactly the credential it needs, at run time, from PassBundle, still end-to-end encrypted.

## What people do

1. **An admin makes a token.** In the MSP console, on a client (or on an organization's Settings page, for a company's own IT): Script access, New token. They name it ("Join domain"), choose the items it may read, choose what it gets from each (username, password, one-time code, named custom fields), and set when it expires. Optionally they limit it to networks (IP ranges), such as the client's office.
2. **The console shows the token once**, as a single string, `pbs1_…`. The admin pastes it into the RMM as a masked script variable (every RMM has one).
3. **The script asks for what it needs:**

   ```powershell
   Import-Module PassBundle
   $cred = Get-PassBundleCredential -Item "Domain admin"
   ```

   The module reads the token from an environment variable, fetches the item's copy, decrypts it on the machine, and returns a `PSCredential` (or a single field with `-Field`).
4. **The console shows every read**: which token, which item, when, and from which address, and a token's last use. Admins revoke a token at once; it stops working on the next request.

## What a token can and can't do

- It reads only its own grants: the items an admin chose for it, and only the fields chosen. It can list its grants (item ids and the names inside its copies) so a script can ask by name.
- It can't do anything else: no vault, no sync, no other item, no other API. It isn't a person's login and has no key to anything but its copies.
- It belongs to one organization (one client), never across clients.
- It expires (required, at most a year) and can be revoked.
- With networks set, the server refuses requests from anywhere else.

## How it stays end-to-end encrypted

Org items are encrypted with the organization key. A script must not get that key: it decrypts every item in the organization.

**Why not wrap each item's own key for the token.** Upstream can give each item its own key, encrypted with the organization key; a token could then get just those item keys. We checked: with our server and apps today, items don't have their own keys, and turning that on changes how every item in every vault is encrypted. Too big a change for this feature.

**What we do instead: copies.** A grant is a copy of just the chosen fields, encrypted with a key only the token holder has. The server stores copies it can't read and gives them only to the token.

### Keys

All in the admin's browser when the token is made; the server never sees the seed or the token key.

- **Seed:** 32 random bytes. The token string is `pbs1_<token id, 32 hex digits>_<seed, base64url>`.
- **Auth secret:** HKDF-SHA256(seed, no salt, "passbundle script auth v1", 32 bytes). The script sends it to prove it holds the token. The server stores only its SHA-256.
- **Token key:** HKDF-SHA256(seed, no salt, "passbundle script key v1", 64 bytes), used as upstream's symmetric key (AES-256-CBC with HMAC-SHA256, the "type 2" encrypted string every PassBundle app already reads). It never leaves the admin's browser and the script's machine, except sealed (next).
- **Sealed token key:** the token key encrypted with the organization key, stored on the server, so any app that holds the organization key can write and refresh the token's copies later. This exposes nothing new: whoever holds the organization key can already decrypt every item in the organization. Version 2 (below) seals it together with the token's id.

Deriving the auth secret and the token key separately from the seed means the server, which sees the auth secret on every request, still can't compute the token key.

### A copy

A grant on the server is: the token, the item's id, the copy, the item revision the copy was made from (so apps know when it's out of date), and the **spec** (which fields it copies, and the token and item it's for), sealed with the organization key so a refreshing app knows what to copy without the server knowing field names.

The copy is the token key's encryption of:

```json
{"v":1,"token":"<token id>","item":"<item id>","revision":"<item revision>","name":"Domain admin","username":"…","password":"…","totp":"…","fields":{"Break-glass PIN":"…"}}
```

The script checks that `token` is its own token and `item` is the item it asked for, so a server can't hand it another item's copy, or another token's.

### Version 2 seals (October 2026)

Version 1 sealed the token key and the spec on their own: `{"v":1,"username":…}` and the bare key. A hacked server could then hand a refreshing app any organization's sealed token key (one whose seed an owner or admin of that organization knows, a client's own admin for an MSP's staff) next to any item the person can open, their own or another organization's, and the app would write a copy of it the attacker can read. Version 2 binds each seal to what it's for:

- **Sealed token key:** the organization key's encryption (upstream's type 2 encrypted string) of `{"v":2,"token":"<token id>","key":"<the 64-byte token key, base64>"}`.
- **Sealed spec:** the organization key's encryption of `{"v":2,"token":"<token id>","item":"<item id>","username":…,"password":…,"totp":…,"fields":[…]}`.
- **An app refreshing a copy** opens both with the key of the item's own organization and goes on only if both are version 2, both name the grant's token, and the spec names the item it's about to copy. It refuses version 1 seals: nothing was made with them that needs keeping (no one uses PassBundle yet), so tokens made before this need making again.
- **The copy** is unchanged (version 1 above), so scripts and the module are unchanged.

The test vectors are `docs/vectors/script-grants-v2.json` (made by `make-script-grants-v2.mjs`, checked with upstream's own crypto by `check-script-grants-vectors.mjs`): the token key and spec sealed for their token and item, and pairs an app must refuse (a spec for another item, a spec for another token, another token's key, version 1 seals, seals with another organization's key).

### Keeping copies current

- **When someone edits a granted item in a PassBundle app**, the app updates that item's copies right after saving: it can, since it holds the organization key, and the server lets it only if the person can edit the item and the copy is for the item's new revision. Someone who can edit the item could put a different password in the copy, but they could equally change the password itself.
- **When an item changes elsewhere** (an upstream app, the CLI), the background work that already runs in owners', admins', and MSP admins' apps (every five minutes and on unlock, see "MSP templates") refreshes copies whose revision is behind. Until then the script gets the previous value, and the console marks the grant out of date.
- **What an app refreshes, whatever the server lists:** the server says which grants are behind, and a hacked one could list anything. An app remakes a copy only from an item that is in the grant's organization (never the person's own item or another organization's), not in the trash, that the person can edit and see the passwords of, with version 2 seals for that token and that item. Anything else is left as it is.
- **Making a token** offers only items whose passwords the admin can see, since the token's copy would show them.
- **A deleted or trashed item** loses its copies; its grants say so in the console.

### What a hacked server can and can't do

- It can't read copies or the token key, and can't make copies a script accepts.
- It can't have an app copy an item to a token it wasn't granted to, or with another token's key (version 2 seals), or copy someone's own items or another organization's.
- It can keep a grant alive that was ended. Revoking a token, taking an item out of it (narrowing), and its expiry are enforced by the server only: version 2 seals bind a grant to its token and item, not to a time or to the token still being live. So a hacked server can keep listing an old version 2 grant as behind, and apps that hold the organization key keep refreshing its copy with the item's current values, for whoever holds that token's seed, until an expiry is bound into the seal (planned, with the token's expiry inside the sealed spec and key).
- It can refuse requests, or serve an older copy of the right item. Scripts can't tell an old copy from the latest; the console's read log and "out of date" marks are the check.
- It learns which items are granted to which tokens, and when scripts read them. That's inherent in a server that logs reads.
- Someone who steals the token string from the RMM can read its grants until it expires or is revoked, from its allowed networks. That's the cost of any credential in an RMM; the limits are the scope, the networks, the expiry, and the read log.

## Server

- Tables: `script_tokens` (id, organization, name, created by, created, expires, revoked, auth hash, networks, sealed token key, last used), `script_grants` (token, item, copy, revision, sealed spec), `script_reads` (token, item, time, address, result).
- Admin endpoints, for an organization's owners and admins and its MSP's admins: create, list, revoke, add and remove grants, and the read log. Refreshing a copy: anyone who can edit the item, with the item's current revision.
- Script endpoints, authenticated by `Authorization: PassBundleScript <token id>.<auth secret>` and nothing else: list the token's grants, read one copy. Checked every time: the token exists, isn't revoked or expired, the secret matches (constant time), the address is in its networks, and the organization is enabled. At most 60 reads a minute per token, in any minute: counted over the last 60 seconds, so 60 at once means none more until the first of them is a minute old (not one more each second, as a token bucket would allow). Past that, 429.
- Every read, allowed or refused, goes in `script_reads`. The MSP console shows reads and a token's first use from a new address in the MSP's activity log.

## The PowerShell module

- One file, `PassBundle.psm1`, plain PowerShell with .NET's AES and HMAC (and HKDF written out with HMAC, since Windows PowerShell 5.1's .NET has none), so it runs on Windows PowerShell 5.1 and PowerShell 7 with nothing to install. The server serves it, and the console shows the line to fetch it.
- `Get-PassBundleCredential -Item <name or id>` returns a `PSCredential`; `Get-PassBundleSecret -Item <name or id> -Field password|username|totp|<custom field>` returns one value (a one-time code is computed on the machine from the copied secret). The token comes from `$env:PASSBUNDLE_TOKEN` or `-Token`.
- It isn't signed until code signing exists; RMMs run scripts with an execution policy that allows that, and the console says so.
- Later: the same in the command-line client for macOS and Linux scripts.

## Tests

- The vectors: the token string, the auth secret and its hash, the token key, a sealed token key and spec, a copy, and copies the script must refuse (tampered, sealed with the wrong key, another item's, another token's). `node docs/vectors/make-script-access-v1.mjs` makes them with plain Node; upstream's own crypto opens them (the clients' tests check that, as for the native-messaging vectors).
- Clients: unit tests for making a token, copies, specs, and refreshing, against both sets of vectors: each pair `script-grants-v2.json` refuses, and each item a hacked server could list (the person's own, another organization's, in the trash, not editable, passwords hidden, another item under a grant's seals) is left alone (`script-refresh.spec.ts`). The lines the settings page shows for a script name the item by its id, single-quoted, with its name only in a comment of letters, digits, and plain punctuation, tested with hostile names (`script-usage.spec.ts`).
- Server: unit tests for the checks; API tests for every endpoint against every role, a token reading only its grants, expiry, revocation, networks, the rate limit, and refresh permissions.
- The module: tier 1 runs it under PowerShell 7 on Linux against the test server, decrypting real copies and refusing bad ones and a revoked token. `docs/vectors/check-script-module.ps1` checks it against the vectors and RFC 6238's codes, on Windows under Windows PowerShell 5.1 and PowerShell 7.
- End to end: an owner makes a token in the web vault with real keys, a script reads just the granted fields, an edit in the web vault reaches the script, the reads show, and revoking stops it. The API tests cover MSP admins and everyone else.

## Decisions (October 20, 2026)

1. **Copies, as above, instead of turning on per-item keys for every vault.** They change nothing about how items are encrypted and expose only the fields chosen. The cost: an edit made outside PassBundle's apps reaches scripts only after an admin's app next runs.
2. **Expiry required, at most a year, 90 days by default.**
3. **Who makes tokens: an organization's owners and admins, and its MSP's admins.** Technicians could later get it as a permission.
4. **Networks now, machine binding later.** IP ranges in version 1; binding a token to a machine needs a key kept on the machine, which is the desktop agent's job and waits on code signing.
5. **PowerShell first.** Most RMM scripts on Windows are PowerShell, and the module needs no install.
