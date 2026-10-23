# Fake exports for testing import

One fake vault, written out the way each password manager and browser exports it, and what PassBundle should hold after importing each file. `tests/import-formats.spec.ts` imports every file into a new account through the screens people use (the import step at sign-up, the guided browser import, or Tools, Import), reads the vault back with the web vault's own `.json` export, and compares it item by item with `expected/`.

Everything here is made up: `example.com`, `.example`, and `.test` addresses, documentation IP ranges (192.168.1.1, 10.0.0.5, 203.0.113.10), "Test Person", and the card networks' published test numbers. No real people, accounts, or passwords.

## Files

- `dataset.mjs`: the vault. 76 items: 63 logins, 6 secure notes, 4 cards, 3 identities, in 5 folders (`Work/Servers` inside `Work`), 6 of them favorites and 1 archived. The awkward cases are there on purpose: a login for three sites, one with no website, IP addresses with ports, an Android app with no website, Unicode names, passwords, and notes, a 5 KB note, TOTP as an `otpauth://` link and as a bare secret, text, hidden, and on/off custom fields, a field on more than one line, passwords with commas, quotes, a line break, markup, backslashes, emoji, and spaces at both ends, an empty password, a username with nothing else, two accounts on one site, an exact duplicate, and password history. The rest are ordinary logins made from word lists with a seeded random generator, so every run makes the same files. (A zip's compressed bytes can differ between zlib builds, so zips are compared by what's in them.)
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
| 1Password 8 (CSV) | `1password-csv/1PasswordExport-TESTPERSON-20261001-120000.csv` | Sign-up, 1Password, "Have a CSV from 1Password instead?" ("1Password 8 (csv)") | 1Password's help on exporting (logins and passwords only: title, website, username, password, one-time password, favorite, archived, tags, notes) and the header 1Password 8 writes, `Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes`, with standard CSV quoting. |
| Bitwarden | `bitwarden/bitwarden_export_20261001120000.json` | Sign-up, Bitwarden | Upstream's own export code (`libs/common/src/models/export`) and `bitwarden-json` spec data: unencrypted `.json`, two-space indents. |
| LastPass | `lastpass/lastpass_export.csv` | Sign-up, LastPass | Upstream's LastPass importer and spec data: columns `url,username,password,totp,extra,name,grouping,fav`; secure notes, cards, and addresses are rows whose url is `http://sn`, their details in `extra` as `NoteType:` and `Key:value` lines; subfolders with a backslash; the TOTP column holds the secret. |
| Dashlane | `dashlane/credentials.csv`, `securenotes.csv`, `payments.csv`, `personalInfo.csv` | Tools, Import, "Dashlane (csv)", one file at a time | Upstream's `dashlane-csv` spec data: Dashlane's CSV export is a zip of these files; this is them unzipped. |
| KeePass 2 | `keepass/Fake vault.xml` | Tools, Import, "KeePass 2 (xml)" | KeePass's File, Export, KeePass XML (2.x), as in upstream's `keepass2-xml` spec data: tabs, CRLF, no byte order mark, the Recycle Bin included. TOTP as KeePass 2.47 and later keep it (`TimeOtp-Secret-Base32`); more websites as `KP2A_URL_1`, the way KeePass2Android and KeePassXC keep them; secure notes, cards, and identities as entries with no password. |
| Proton Pass | `protonpass/Proton Pass_export_2026-10-01.zip` | Tools, Import, "ProtonPass (zip/json)" | Upstream's Proton Pass importer types and `protonpass-json` spec data: a zip with `Proton Pass/data.json`, vaults instead of folders, and an item in the trash. |

## What doesn't come over

The tests check these as they are, so a change to them shows up. Each is in that format's `expected/` file.

- **Browsers (Chrome, Edge, Brave, Firefox):** only logins with a website or an Android app, no folders, favorites, TOTP, custom fields, or password history. A login for three sites is three logins. Firefox also has no notes and names each login after its site. The guided import skips a login with no password and repeats of one already imported.
- **Apple Passwords:** only logins with a password, each named "site (username)", a login for three sites is three logins, and an Android app's login isn't exported. No folders, favorites, custom fields, or history.
- **1Password (1PUX):** an identity's title (1Password has none). A field on more than one line goes to the notes, after the item's own notes.
- **1Password 8 (CSV):** only logins, and only their first website (that's all the CSV has); the first tag is the folder, and with more than one tag, every tag is in the notes.
- **LastPass:** only the first website, no custom fields or password history.
- **Dashlane:** no favorites, custom fields, password history, or folders inside folders (`Work/Servers` is `Work`). An identity is named after the person, and its email type and address recipient are text fields; a card is named like "Visa ending 1111" (the export has no name for it), and its country is a text field.
- **KeePass 2:** KeePass has only entries, so an entry with nothing to sign in with is a secure note with its fields as they were: secure notes, cards, and identities, except an identity with a username, which stays a login. Favorites and history aren't kept.
- **Proton Pass:** each vault is a folder when items come from more than one vault (so items with no folder are in "Personal" here, and `Work/Servers` is `Work`); with everything in one vault, nothing is in a folder. On/off fields are text fields, and history isn't kept. The item in Proton Pass's trash is left out.
- **Archive:** only Bitwarden and 1Password (1PUX and CSV) have one; from those, the archived item stays archived (in Archive, not All items). The other apps have no archive, so it's an ordinary item.
- **Most formats:** an address with no `https://` gets `http://` (Bitwarden keeps it as it was).

## Fixed in our fork (passbundle-clients)

Found with these files; each has a unit test in `libs/importer`.

- 1PUX: only the first favorite stayed a favorite.
- 1PUX: a field on more than one line was lost when the item had notes.
- 1Password CSV: the `Url` column's address was dropped, and the notes kept a newline at each end.
- Dashlane: the TOTP secret in `otpUrl` was also a plain text field.
- KeePass 2: the Recycle Bin came back as a folder, with the deleted entries in it.
- Every importer: a value moved to the notes ran on from the notes already there.
- KeePass 2: the TOTP was a hidden field. KeePass 2.47's `TimeOtp-Secret*` fields (base32, text, hex, or base64, with `TimeOtp-Period`, `TimeOtp-Length`, and `TimeOtp-Algorithm`), KeeOtp's and KeePassXC's `otp` field, and TrayTOTP's `TOTP Seed` are the TOTP: the secret alone with the default settings, otherwise an `otpauth://` URI.
- KeePass 2: more websites (`KP2A_URL*`, fields named like "URL 2") were text fields; they're websites after the main one.
- KeePass 2: every entry was a login, and the notes ended with a line break. An entry with nothing to sign in with is a secure note, and the notes are as they were.
- 1Password 8 (CSV): there was no importer for it, and the 6 and 7 one read a quote in a value twice and kept the one-time password, Favorite, and Archived as text fields. "1Password 8 (csv)" reads it with standard quoting: the one-time password is the TOTP, favorites and archived items stay so, and the first tag is the folder.
- LastPass: cards had no brand, and LastPass's Language, the card's Type, and an empty Start Date were text fields, as was an address's phone. The brand comes from the number (or the type), and the phone is the identity's.
- Dashlane: with more than one person in `personalInfo.csv`, each row was a secure note; each person is an identity. A card was named after its holder, with "credit_card" as a text field; it's named like "Visa ending 1111".
- Proton Pass: an identity's street was the second address line; it's the first. And everything in one vault (most people's "Personal") went into a folder named after it; with one vault, nothing is in a folder. (This file has four vaults, so its items are in folders.)
