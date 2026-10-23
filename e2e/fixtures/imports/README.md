# Fake exports for testing import

One fake vault, written out the way each password manager and browser exports it, and what PassBundle should hold after importing each file. `tests/import-formats.spec.ts` imports every file into a new account through the screens people use (the import step at sign-up, the guided browser import, or Tools, Import), reads the vault back with the web vault's own `.json` export, and compares it item by item with `expected/`.

Everything here is made up: `example.com`, `.example`, and `.test` addresses, documentation IP ranges (192.168.1.1, 10.0.0.5, 203.0.113.10), "Test Person", and the card networks' published test numbers. No real people, accounts, or passwords.

## Files

- `dataset.mjs`: the vault. 76 items: 63 logins, 6 secure notes, 4 cards, 3 identities, in 5 folders (`Work/Servers` inside `Work`), 6 of them favorites. The awkward cases are there on purpose: a login for three sites, one with no website, IP addresses with ports, an Android app with no website, Unicode names, passwords, and notes, a 5 KB note, TOTP as an `otpauth://` link and as a bare secret, text, hidden, and on/off custom fields, a field on more than one line, passwords with commas, quotes, a line break, markup, backslashes, emoji, and spaces at both ends, an empty password, a username with nothing else, two accounts on one site, an exact duplicate, and password history. The rest are ordinary logins made from word lists with a seeded random generator, so every run makes the same files. (A zip's compressed bytes can differ between zlib builds, so zips are compared by what's in them.)
- `formats.mjs`: a writer for each format, and a model of what our importer does with it (`expect`), which reads the records the writer made the way the importer does.
- `vault.mjs`: the one shape both sides are compared in.
- `zip.mjs`: a small zip writer, for 1PUX and Proton Pass.
- `generate.mjs`: writes `files/` and `expected/`. Run `node fixtures/imports/generate.mjs` from `e2e/` after changing any of the above, and commit the result; the first test fails if they're out of date.
- `files/<format>/`: the exports. Try them by hand too.
- `expected/<format>.json`: what the vault should hold after importing that format, one item per line.

## Formats

| Format | File | Imported through | Where its shape comes from |
| --- | --- | --- | --- |
| Google Chrome | `chrome/Chrome Passwords.csv` | Sign-up, Your browser, Google Chrome | Chromium's `password_csv_writer.cc` and `csv_writer.cc` (BSD-3-Clause): columns `name,url,username,password,note`; a row for each site; rows sorted by every column; a value quoted only when it has a comma, quote, or line break; LF line endings on a Mac or Linux. The Android row's `android://<hash>@<package>/` form is from upstream's `chrome-csv` spec data. |
| Microsoft Edge | `edge/Microsoft Edge Passwords.csv` | Tools, Import from your browser, Microsoft Edge | The same Chromium writer, on Windows: CRLF line endings. |
| Brave | `brave/Brave Passwords.csv` | Tools, Import from your browser, Brave | The same Chromium writer. |
| Chrome, saved again in Excel | `chrome-excel/Chrome Passwords (saved in Excel).csv` | Tools, Import from your browser, Google Chrome | Chrome's export with what Excel's "CSV UTF-8" adds: a byte order mark and CRLF. It doesn't imitate Excel changing values that start with `=`, `+`, `-`, or `@`, or long numbers. |
| Firefox | `firefox/logins.csv` | Sign-up, Your browser, Firefox | Firefox's `LoginExport.sys.mjs` (MPL-2.0): columns `url,username,password,httpRealm,formActionOrigin,guid,timeCreated,timeLastUsed,timePasswordChanged`; every value quoted, a missing one left empty; CRLF between rows and none at the end. The `chrome://FirefoxAccounts` row older versions export is from upstream's `firefox-csv` spec data. |
| Apple Passwords | `apple/Passwords.csv` | Sign-up, Apple Passwords (on a computer that isn't a Mac) | Columns `Title,URL,Username,Password,Notes,OTPAuth`, from upstream's `safari-csv` spec data and public reports of what the Passwords app writes; titles as "site (username)". Apple doesn't document line endings or quoting: LF, quoted only when needed. |
| 1Password 8 (1PUX) | `1password-1pux/TESTPERSONFAKEACCOUNT00000.1pux` | Sign-up, 1Password | 1Password's public 1PUX format page (support.1password.com/1pux-format) and upstream's `onepassword-1pux` spec data: a zip named for the account with `export.attributes`, `export.data` (accounts, vaults, items), and `files/`. `favIndex` is an item's place among the favorites; tags hold the folders. |
| 1Password 8 (CSV) | `1password-csv/1PasswordExport-TESTPERSON-20261001-120000.csv` | Sign-up, Something else, "1Password 6 and 7 Mac (csv)" | 1Password's help on exporting (logins and passwords only: title, website, username, password, one-time password, favorite, archived, tags, notes) and the header 1Password 8 writes, `Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes`. There's no importer for 1Password 8's CSV; the 6 and 7 one is the closest. |
| Bitwarden | `bitwarden/bitwarden_export_20261001120000.json` | Sign-up, Bitwarden | Upstream's own export code (`libs/common/src/models/export`) and `bitwarden-json` spec data: unencrypted `.json`, two-space indents. |
| LastPass | `lastpass/lastpass_export.csv` | Sign-up, LastPass | Upstream's LastPass importer and spec data: columns `url,username,password,totp,extra,name,grouping,fav`; secure notes, cards, and addresses are rows whose url is `http://sn`, their details in `extra` as `NoteType:` and `Key:value` lines; subfolders with a backslash; the TOTP column holds the secret. |
| Dashlane | `dashlane/credentials.csv`, `securenotes.csv`, `payments.csv`, `personalInfo.csv` | Tools, Import, "Dashlane (csv)", one file at a time | Upstream's `dashlane-csv` spec data: Dashlane's CSV export is a zip of these files; this is them unzipped. |
| KeePass 2 | `keepass/Fake vault.xml` | Tools, Import, "KeePass 2 (xml)" | KeePass's File, Export, KeePass XML (2.x), as in upstream's `keepass2-xml` spec data: tabs, CRLF, no byte order mark, the Recycle Bin included. TOTP as KeePass 2.47 and later keep it (`TimeOtp-Secret-Base32`); more websites as `KP2A_URL_1`, the way KeePass2Android and KeePassXC keep them. |
| Proton Pass | `protonpass/Proton Pass_export_2026-10-01.zip` | Tools, Import, "ProtonPass (zip/json)" | Upstream's Proton Pass importer types and `protonpass-json` spec data: a zip with `Proton Pass/data.json`, vaults instead of folders, and an item in the trash. |

## What doesn't come over

The tests check these as they are, so a change to them shows up. Each is in that format's `expected/` file.

- **Browsers (Chrome, Edge, Brave, Firefox):** only logins with a website or an Android app, no folders, favorites, TOTP, custom fields, or password history. A login for three sites is three logins. Firefox also has no notes and names each login after its site. The guided import skips a login with no password and repeats of one already imported.
- **Apple Passwords:** only logins with a password, each named "site (username)", a login for three sites is three logins, and an Android app's login isn't exported. No folders, favorites, custom fields, or history.
- **1Password (1PUX):** an identity's title (1Password has none). A field on more than one line goes to the notes, after the item's own notes.
- **1Password 8 (CSV):** only logins, and only their first website; no folders. The one-time password, Favorite, and Archived columns come in as text fields, and a double quote in any value comes in twice: the 6 and 7 importer reads quotes the way those versions wrote them.
- **LastPass:** only the first website, no custom fields or password history. Cards have no brand, and a card's Type, Start Date, and Language come in as text fields; an address's phone and Language too.
- **Dashlane:** no favorites, custom fields, password history, or folders inside folders (`Work/Servers` is `Work`). A card is named after its cardholder, and its `type` and `country` are text fields. With more than one person's details in `personalInfo.csv`, each row is a secure note with its values as fields, not an identity.
- **KeePass 2:** every entry is a login (KeePass has no notes, cards, or identities), favorites aren't kept, the notes end with a line break, the TOTP secret is a hidden field (`TimeOtp-Secret-Base32`) rather than the TOTP, more websites are text fields, and history isn't kept.
- **Proton Pass:** each vault is a folder (so items with no folder are in "Personal", and `Work/Servers` is `Work`), on/off fields are text fields, an identity's street is its second address line, and history isn't kept. The item in Proton Pass's trash is left out.
- **Most formats:** an address with no `https://` gets `http://` (Bitwarden keeps it as it was).

## Fixed in our fork (passbundle-clients)

Found with these files; each has a unit test in `libs/importer`.

- 1PUX: only the first favorite stayed a favorite.
- 1PUX: a field on more than one line was lost when the item had notes.
- 1Password CSV: the `Url` column's address was dropped, and the notes kept a newline at each end.
- Dashlane: the TOTP secret in `otpUrl` was also a plain text field.
- KeePass 2: the Recycle Bin came back as a folder, with the deleted entries in it.
- Every importer: a value moved to the notes ran on from the notes already there.
