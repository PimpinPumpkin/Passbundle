# Test tenants

Seeds a PassBundle server with a realistic MSP, its clients, a family, and a person on their own, for hands-on testing (docs/hands-on-testing.md). Everything goes through the server's own API as the apps send it: the accounts' keys, the organizations' keys, and every item are made and encrypted on this computer with the same code the end-to-end tests use (`e2e/tests/support/vault-crypto.ts`), so nothing readable reaches the server.

## Running it

It runs with Node 24 or later and the end-to-end tests' packages (`cd e2e && npm ci` once).

```bash
node tools/test-tenants/test-tenants.ts seed --server https://127.0.0.1:8091
node tools/test-tenants/test-tenants.ts status --server https://127.0.0.1:8091
node tools/test-tenants/test-tenants.ts code maya --server https://127.0.0.1:8091
node tools/test-tenants/test-tenants.ts teardown --server https://127.0.0.1:8091
node tools/test-tenants/test-tenants.ts reset --server https://127.0.0.1:8091
node tools/test-tenants/test-tenants.ts domains
```

- **`seed`** makes everything below. Run it again and it does nothing while what it made is still there; a run that stopped halfway is torn down and made again.
- **`status`** says whether the server has the tenants, and signs in as one person to check.
- **`code <person>`** prints the current two-step login code of someone with an authenticator app (the first name in lowercase, as in the table below), for signing in as them by hand.
- **`teardown`** deletes what `seed` made: the organizations, then the accounts. An MSP can't be deleted through the API, so its empty record (no staff, no clients) stays. People invited who never joined stay as invitations without an account. Someone whose master password was changed by hand can't be signed in as, so teardown leaves them and names them.
- **`reset`** is teardown, then seed.
- **`domains`** prints the email domains it uses, comma-separated, for `SIGNUPS_DOMAINS_WHITELIST`.

### Where the passwords go

Every master password is made by the tool and written only to `credentials.md` in `~/Documents/PassBundle-test-tenants/<server>/` (for example `127.0.0.1-8091` or `test.passbundle.com`), next to `state.json`, which the tool reads to sign in again and tear down. The folder is readable only by you (700) and the files too (600). The tool never prints a password, and refuses a folder inside a git checkout. `--out <folder>` picks another folder.

`credentials.md` has, for each person: their email, master password, and for those with an authenticator app its key (an `otpauth://` link to add to an authenticator app) and their two-step login recovery code.

### Which servers

Only these, so it can't seed a real server by mistake:

- **This computer:** `https://localhost`, `https://127.0.0.1`, or `https://[::1]`, with any port. Its certificate isn't checked (the end-to-end servers make their own). Start one that keeps its data with `KK_DATA_DIR=<folder> node e2e/server.mjs` (see e2e/README.md for the builds it needs), and add `KK_LIKE_TEST_SERVER=1 KK_SIGNUPS_DOMAINS=$(node tools/test-tenants/test-tenants.ts domains)` to set it up as the test server is while the tool seeds it.
- **The test server:** `https://test.passbundle.com`, only with `--test-server`. Seeding needs these in `/etc/passbundle/server.env`, with a restart (`systemctl restart passbundle`) each time they change; `status`, `code`, and `teardown` don't:
  - `SIGNUPS_DOMAINS_WHITELIST=` the output of `domains`: the server lets these domains sign up, and nobody else, as before. The test server doesn't verify email, so while it's set anyone who knows one of these domains could sign up with it: take it out as soon as the tool is done.
  - `MSP_SIGNUPS_ALLOWED=true`, so Maya can set up Harbor IT. Take it out afterwards too.

  The test server sends no email, so nothing is emailed, and the tool lets each person in itself, as an owner approving them on the Members page would. Its new-device check stays on: the tool signs in as a command-line tool, which can't approve sign-ins, so your first sign-in as each person goes straight through, and two-step login covers the rest. It's a small machine: a seed takes a few minutes there.

## Who it makes

Every email is at a domain under `.test`, which is reserved for testing (RFC 2606) and never delivers mail. Each person is named here by their persona; their email is `first.last@<domain>`. Use these names in docs/hands-on-testing.md.

### Harbor IT, the MSP (`harborit.test`)

| Person | Role | Two-step login |
|---|---|---|
| Maya Chen | MSP admin; set up Harbor IT and added every client | Authenticator app |
| Owen Brooks | MSP admin (MSP admins own every client) | Authenticator app |
| Theo Ramirez | Technician: every client, as admin, sees install commands | Authenticator app |
| Priya Shah | Technician: only Northwind Dental and Cedar Ridge Veterinary; "Helpdesk" custom role there (manage members, account recovery), no vault items, no install commands; admin at Cedar Ridge Veterinary | Authenticator app |
| Sam Whitfield | Technician: every client; custom role with vault items and view event logs, no install commands | Authenticator app |
| Jordan Blake | Invited to the staff, hasn't joined (no account) | None |

- **Default policies:** a new MSP's (the Business preset, two-step login for admins included), with vault lock required for every client (locked).
- **Templates** for clients, from Harbor IT's own organization: Firewall and Microsoft 365 tenant for every client, Line-of-business app for Northwind Dental and Cedar Ridge Veterinary. Their copies go out once an MSP admin's web vault or extension trusts each client (Confirm client in the console; the tool can't make the client seals, which only an admin's browser makes).
- **Harbor IT's own organization** "Harbor IT" (Maya and Owen own it; the technicians are members): Vendor portals (Theo and Priya can edit, Sam can view), RMM and tools (the technicians can view), Client templates (the templates above), and Harbor IT finance (owners only).

### The clients

| Client | Size and setup | People |
|---|---|---|
| Northwind Dental (`northwind-dental.test`) | Medium. Follows every default. Groups Front desk and Clinical | Grace Liu (owner, authenticator), Marcus Reed (admin, authenticator), Lena Fischer (custom role: manage members, view event logs; authenticator), Tom Alvarez (member, no two-step login), Aisha Patel (member, authenticator by choice), Ben Carter (member, revoked), Casey Nguyen (invited, hasn't joined) |
| Bluebird Law (`bluebird-law.test`) | Small. Requires two-step login of everyone (its own setting: two-step login for admins, and everyone else too). Its own master password setting (16 characters) | Elena Rossi (owner, authenticator), Noah Bennett (admin, authenticator), Chloe Martin (member, authenticator), Liam Walsh (accepted without two-step login, so waiting and not let in) |
| Cedar Ridge Veterinary (`cedar-vet.test`) | Small. Assisted password change off | Ravi Menon (owner, authenticator), Jess Taylor (member, no two-step login), Kai Anderson (member, no two-step login; his own items have weak, reused, and exposed passwords, for Members' own passwords) |
| Pinecrest Construction (`pinecrest-build.test`) | The largest. The browsers' own card and address autofill off (offering to import them). Groups Field crew and Office | Frank Delgado (owner, authenticator), Rosa Martinez (admin, authenticator), Mike O'Neill, Dana Kowalski, and Luis Ortega (members, no two-step login), Ivy Park (member, authenticator), Greg Hollis (member, revoked) |
| Summit Accounting (`summit-cpa.test`) | Tiny. Added without the default policies: no single organization, no two-step login for admins, Members' own passwords off; only the required vault lock applies | Nora Feld (owner, no two-step login: no rule there asks for it), Paul Grant (member, no two-step login), Diego Rivera (member; also in his family's organization) |

Every Business client (all but Summit Accounting) has single organization, Members' own passwords, and the rest of the defaults. Each client's shared folders have icons and colors, and permissions per person and group, including "Can view but not see passwords" and a Custom grid:

- **Northwind Dental:** Everyone, Admins, Front desk (Front desk group can edit), Practice software (Clinical can view; Front desk can view but not see passwords), Banking and payroll (Marcus manages; nobody else but owners and admins), Vendors (Tom: Custom, see passwords, create, and edit, but not delete; Aisha can view).
- **Bluebird Law:** Everyone, Admins, Court e-filing (Chloe can edit), Client portals (Chloe can view but not see passwords).
- **Cedar Ridge Veterinary:** Everyone, Admins, Clinic systems, Suppliers.
- **Pinecrest Construction:** Everyone, Admins, Job sites (Field crew can edit), Fuel and company cards (Office can edit; Field crew can view but not see passwords), Suppliers, Equipment rental.
- **Summit Accounting:** Everyone, Tax software.

### The Rivera Family (`rivera-family.test`)

A family organization (no policies): Carmen Rivera (owner, no two-step login; Diego is her legacy contact, with takeover after 7 days), Diego Rivera (admin, authenticator; also a member of Summit Accounting), Sofia Rivera (member, a teenager, no two-step login), Marisol Rivera (invited, hasn't joined). Folders: Household (everyone can edit), Streaming and kids (Sofia can view), Money (Sofia has none), Travel documents (Sofia can view but not see passwords), and a School account template.

### Alex Morgan (`morgan-home.test`)

A personal account with no organization and no two-step login, with personal folders (Banking, Shopping, Social, Work, Home) and one of everything.

### The items

Across the tenants, every kind of item: logins (with websites, usernames, one-time codes, and custom fields), cards, identities, secure notes, SSH keys, bank accounts, driver's licenses, and passports; logins with weak, reused, and exposed (known breached) passwords; items expired, expiring in a few days, and expiring later, cards included, one with its own reminder days; items from the built-in templates (Wi-Fi network, server, database, router, software license, domain, certificate, API key, email account, membership) and custom templates; a passkey (on a login for webauthn.io, which that site doesn't know: register a new one there to try signing in); items edited several times, by different people where they share them, so their history has versions; favorites, an item that asks for the master password, and an item in the trash.

## Tests

`e2e/tests/api/test-tenants.spec.ts` runs the tool against the end-to-end test server, as tier 1 does on every pull request: it seeds, checks what it made through the API (and that the database holds none of it readable), seeds again without changing anything, tears down, and seeds again. `e2e/tests/test-tenants-web.spec.ts` signs in to the web vault as some of the people and checks their items open.
