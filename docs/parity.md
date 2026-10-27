# How PassBundle compares with Bitwarden and 1Password

Checked October 23, 2026. A feature-by-feature look at where PassBundle stands against Bitwarden and 1Password, and which gaps matter most for MSPs.

## How this was made

- **Bitwarden and 1Password columns** come from their public pages only: help centers, product and pricing pages, blogs, release notes, and a few public forum threads (marked as forum in the sources). No accounts, sign-ins, or trials were used, and no Bitwarden License or SDK code was read (CLEAN_ROOM.md). Everything is summarized in our own words, with a source for each row at the end.
- **The PassBundle column** comes from DESIGN.md, `docs/core.md`, `docs/phones.md`, `docs/script-access.md`, and the code on `main` (this repo and passbundle-apps) and `keykeeper` (passbundle-clients and passbundle-server) on the same day. Where a feature comes from upstream code we ship and haven't changed, the notes say "inherited".
- **Plans** are in parentheses: for Bitwarden Free, Premium, Families, Teams, Enterprise; for 1Password Individual, Families, Teams, Business, Enterprise. Where a plan isn't given, the source didn't name one.

**PassBundle status:**

| Status | Meaning |
|---|---|
| **Built** | Works today in at least one PassBundle app, with tests, or inherited and working on our server. The notes say where. |
| **Partly** | Some platforms or parts only, or present in the code but off by default. |
| **Planned** | DESIGN.md or `docs/` says we'll build it, and it isn't built. |
| **Missing** | Not built and not planned. |
| **Unverified** | We couldn't confirm it from our code or docs. |

**Where things run:** "the extension and web vault" are our builds of upstream's open-source clients (base `web-v2026.8.0`). "Our apps" are the Flutter app for Windows, macOS, Linux, Android, and iOS on the Rust core, plus the desktop agent. "The server" is passbundle-server (Vaultwarden 1.37.4 base).

## Item types and fields

| Feature | Bitwarden | 1Password | PassBundle today | Notes | Sources |
|---|---|---|---|---|---|
| Logins, secure notes, cards, identities | Yes, every plan | Yes, every plan (plus a separate Password item) | **Built** | Inherited in the extension and web vault. Our apps show, copy, edit, and create all four. | [bw-items] [op-categories] |
| SSH key items | Yes (since 2025.1; sharing in orgs since 2025.9) | Yes | **Built** | The web vault makes and edits them. Our apps show the public key and fingerprint and treat the private key as a secret. | [bw-ssh] [op-categories] |
| Passkeys saved on logins | Yes, one per login | Yes, on a login item | **Built** | The extension (tier 1 tested) and our Android app. iOS is designed, not built. | [bw-passkeys] [op-passkeys] |
| File attachments | Yes (Premium or paid org); 500 MB a file, 5 GB a person | Yes; 1 GB a person (5 GB on Business) | **Built** | Inherited upload in the extension and web vault; our apps download and open them (`docs/core.md`, "The format"). Storage limits are server settings. | [bw-attach] [op-files] |
| Document as its own item type | No (attach to any item) | Yes | **Missing** | A secure note with an attachment does the same job. | [bw-items] [op-categories] |
| Custom fields | Text, hidden, checkbox, linked | Text, password, one-time password, date, month and year, URL, email, phone, address, security questions, "sign in with" | **Partly** | Upstream's four kinds are inherited. Typed fields (date, URL, email, phone, number, one-time code) are planned (DESIGN.md, "Item templates"). | [bw-fields] [op-fields] |
| Bank account, passport, driver's license | Not shipped; help docs list five types, and a forum thread spotted the code behind a flag | Yes, built-in categories | **Partly** | Upstream's three types are in our clients and server, but behind the `pm-32009-new-item-types` flag, which our server sends only if `EXPERIMENTAL_CLIENT_FEATURE_FLAGS` names it. Identity items hold passport and license numbers meanwhile. | [bw-items] [bw-newtypes] [op-categories] |
| Server, database, Wi-Fi, router, software license, API key, email account, membership | No | Yes, built-in categories | **Built** | Ten built-in templates: API key, server, database, Wi-Fi network, router, software license, domain, certificate, email account, membership. | [bw-items] [op-categories] |
| Crypto wallet, medical record, outdoor license, reward program, Social Security number | No | Yes, built-in categories | **Partly** | Crypto wallet is planned as a built-in template. The rest can be made as custom templates today. | [op-categories] |
| User-defined item templates | No | No (fixed categories; custom fields or duplicating an item instead) | **Built** | Personal, organization, and MSP-pushed templates, "Save as template", and "New item from a template". | [bw-items] [op-categories] [op-templates-forum] |
| Password history | Yes, last 5 per login | Yes | **Built** | Inherited in the extension and web vault. | [bw-history] [op-history] |
| Item version history and restore | No (password history only) | Yes (Business: "View Item History" permission) | **Built** | The web vault: every edit keeps the version before (the newest 20, then one a day, up to 100 per item), for whoever can open the item, with who saved it, a side-by-side view of what changed, restore, and clearing by whoever can delete the item and view its history in the same shared folder (DESIGN.md, "Item history"). The extension and our desktop and phone apps show, restore, and clear the same versions. | [bw-history] [op-history] |
| Archive | Yes (Premium or paid org, since 2026.2) | Yes, every plan | **Built** | Inherited; our server turns it on for everyone. Not in our apps yet. | [bw-items] [op-archive] |
| Favorites | Yes | Yes | **Built** | Extension, web vault, and our apps. | [bw-fav] [op-tags] |
| Tags | No (folders only; long-running forum request) | Yes, nested, several per item | **Missing** | Folders are inherited, and our apps make, rename, and delete them. | [bw-tags] [bw-folders] [op-tags] |
| Trash | 30 days | 30 days | **Built** | Inherited. Our server keeps trash until it's emptied, unless `TRASH_AUTO_DELETE_DAYS` is set. | [bw-items] [op-archive] |
| Expiration dates and reminders | No | Yes: Watchtower flags expiring items with date fields | **Built** | An "Expires" date on any item, list badges, an Expiring items report, extension notifications at 30, 7, and 1 days, and a cross-client view in the MSP console. | [op-watchtower] |

## Autofill

| Feature | Bitwarden | 1Password | PassBundle today | Notes | Sources |
|---|---|---|---|---|---|
| Inline menu in the browser | Yes | Yes | **Built** | Inherited, plus our username detection and one-time code guards (DESIGN.md, "Autofill"). Our autofill corpus scores 14 of 14 (DESIGN.md, "How it keeps getting better"). | [bw-fill] [op-browser] |
| Choosing which value fills which field | Custom fields fill by matching the field's name; linked fields map to username or password | Not found in public docs | **Built** | Fill picker: "Fill this field with..." or "Never fill this field", from the right-click menu or the inline menu, saved with the item. | [bw-fields] |
| Fixes for sites that fill badly | Fill assist (extension 2026.6): curated rules, a policy to turn it on, and an org's own rules (2026.9) | Not found in public docs | **Built** | Opt-in shared site fixes, applied on a server once 3 people agree; MSPs can apply their staff's fixes to every client; "Report a problem with this site". The curated list we ship is next. | [bw-fillassist] |
| One-time codes | Fill and auto-copy (codes need Premium or a paid org) | Fill after login and auto-copy, every plan | **Built** | Inherited in the extension (our server gives every account those features). Our apps show and copy codes; the phones don't fill them yet. | [bw-totp] [op-otp] |
| Cards and identities | Yes, extension; Android card fill since 2025.8 | Yes, browsers; Android in Chrome and Brave | **Partly** | The extension, inherited. Our phone apps fill logins only. | [bw-fill] [bw-2605] [op-cards] [op-android] |
| Fill on page load and auto-submit | Fill on page load, off by default, with a policy | "Sign in automatically after autofill", with a Business policy | **Partly** | Fill on page load is inherited in the extension; its policy isn't supported by our server. | [bw-fill] [op-policies] |
| Website matching options | Six: base domain, host, starts with, regular expression, exact, never; policy for the default | Three: anywhere on the site, exact host, never | **Built** | Inherited, with the default match policy. Our Android app offers domain, host, and never (Android gives only the domain). | [bw-uri] [op-behavior] |
| Passkeys in the browser | Yes | Yes | **Built** | Make and sign in, tested end to end, including from a second signed-in browser. The extension still uses upstream's AAGUID. | [bw-passkeys] [op-passkeys] |
| Passkeys on phones | iOS 17+, Android 14+ | iOS 18+, Android 14+ | **Partly** | Android 14+ is built (Credential Manager, with Digital Asset Links checks). iOS is designed (`docs/phones.md`). | [bw-passkeys] [op-ios] [op-android] |
| Passkeys for the whole computer (OS provider) | Not shipped; a Windows beta mentioned, "coming soon" | Yes: macOS 14+, Windows 11 (since November 2025) | **Planned** | `docs/core.md` lists passkeys on computers under "Not yet"; the browser extension covers browsers. | [bw-desktop-passkey] [bw-sep26] [op-macos-autofill] [op-win-rn] |
| Android autofill | Yes: autofill service, inline suggestions, overlay | Yes | **Built** | Our app: autofill service, unlock from the fill list, save and update prompts, app and site matching that checks the browser is a real one. | [bw-android] [op-android] |
| iOS AutoFill | Yes | Yes | **Planned** | Designed (`docs/phones.md`, "Autofill"); next after the iOS app itself. | [bw-ios] [op-ios] |
| Filling desktop apps (Quick Access, auto-type) | No; auto-type "coming soon" | Quick Access on Mac, Windows, Linux | **Missing** | Our desktop app copies, clearing after 30 seconds. No global shortcut. | [bw-sep26] [bw-autotype] [op-qa] |
| Filling anywhere on the computer | No | Universal Autofill on Mac; Auto-Type on Windows | **Missing** | | [op-ua] [op-autotype] |

## Sharing and permissions

| Feature | Bitwarden | 1Password | PassBundle today | Notes | Sources |
|---|---|---|---|---|---|
| Shared spaces | Organizations with collections (renamed "shared folders" in the new design); free org: 2 people, 2 collections | Vaults: private, shared, and an Employee vault on Business | **Built** | One word, folder, grouped by owner: Personal holds your own folders, and each organization its shared folders (upstream's collections); to share an item, move it into an organization's folder. The web vault's left menu and item dialog show it that way, and "vault" is gone from the screens except for locking and encryption (DESIGN.md, "Folders and permissions"). The Business preset makes Everyone and Admins. Our apps have no organization folders yet. | [bw-orgs] [bw-sep26] [op-employee] |
| Permission levels per shared space | Five: view, view without passwords, edit, edit without passwords, manage | Teams: view, edit, manage. Business: 13, see the next row | **Built** | Four presets (Can view, Can view but not see passwords, Can edit, Can manage) and Custom, which opens the grid in the next row. Upstream clients see the closest preset. | [bw-collperm] [op-vaults] |
| Granular permissions like 1Password Business | No | View, create, edit, archive, delete, view and copy passwords, view item history, import, export, copy and share, move, print, manage vault | **Built** | Per shared folder, per person or group: see items, see passwords, create, edit, delete, export, share (move out or copy), print, view item history, and manage. The server enforces see items, create, edit, delete, manage, and item history on every write path; the apps enforce see passwords, export, print, and share, since anyone who can decrypt an item can copy it (1Password has the same limit). Several ways in give the most open of each. Custom roles and MSP technicians give only what they have. Archive is per person (upstream); import goes through create. The extension has the folders by owner and enforces see passwords, export, and share like the web vault. Not in our apps yet. | [op-vaults] |
| Groups | Yes (Teams, Enterprise) | Built-in groups; custom groups (Business) | **Partly** | Inherited and on for every organization (a server can turn it off with `ORG_GROUPS_ENABLED`); tests cover who can read and change groups, and the Access page. Custom roles that manage members see groups but can't manage them yet. | [bw-plans] [op-groups] |
| Guests | No guest role | Yes: 5 (Teams, Families), 20 (Business), one vault each | **Missing** | | [bw-roles] [op-guests] |
| Sending a secret to anyone by link | Send: text (free), files (Premium), up to 31 days, password, view limit, email check | Item sharing, every plan: 1 hour to 30 days, one view, anyone or checked emails | **Partly** | Send is inherited in the web vault and extension, text and files. Not in our apps yet. | [bw-send] [op-share] |
| Sharing an item as a link | "Share via link" (Premium or paid org), rolling out from 2026.10 | Yes (see the row above); Business sets who may receive, how long, and one-view | **Missing** | Upstream's version is newer than our clients' base. | [bw-sharing] [op-share-admin] |
| Family plan | Families (6 people) | Families (5 people, plus guests) | **Partly** | A family can use an upstream organization today. The Family preset (approval, emergency access suggestions) isn't built. | [bw-pricing] [op-pricing] |

## Admin: policies

| Policy | Bitwarden | 1Password | PassBundle today | Notes | Sources |
|---|---|---|---|---|---|
| Require two-step login | Yes | Yes (needs a strict password policy) | **Built** | Inherited. Applies to MSP technicians too. Requiring it only for admins isn't possible with upstream's policy. | [bw-policies] [op-policies] |
| Master password requirements | Yes | Yes | **Built** | Business preset: 12 characters and a strength score of 3 of 4. | [bw-policies] [op-policies] |
| Password generator rules | Yes | Not in the policy list | **Built** | Inherited, and our apps' core holds to it, strictest across organizations. | [bw-policies] [op-policies] |
| Single organization | Yes | No equivalent found | **Built** | On in the Business preset. MSP staff are exempt. | [bw-policies] |
| Require SSO | Yes | Yes (SSO policies) | **Missing** | Our server doesn't support the policy. | [bw-policies] [op-policies] |
| Keep work items with the company | "Centralize organization ownership" | Employee vault | **Partly** | Upstream's older "remove individual vault" works. The newer data ownership policy isn't in Vaultwarden, so the Business default "private items stay with the org" isn't built. | [bw-policies] [op-employee] |
| Send and sharing controls | "Manage Send and share" | Item sharing settings | **Built** | Remove Send and Send options, inherited. | [bw-policies] [op-share-admin] |
| Remove export | Yes | "Export Items" vault permission | **Partly** | The export permission of each shared folder (see "Granular permissions"), kept by the apps. No organization-wide policy: Vaultwarden doesn't have it. | [bw-policies] [op-vaults] |
| Account recovery | Yes | Yes | **Built** | Off by default; each organization turns it on. | [bw-policies] [op-recovery] |
| Session timeout | Yes (owners exempt) | Unlock and auto-lock enforcement | **Built** | Ours: server, web vault page, and our apps (`docs/core.md`, "Locking by policy"). The web vault stays unlocked across a reload within the timeout, where Bitwarden's locks at every reload (DESIGN.md, "Staying unlocked across a reload"). | [bw-policies] [op-policies] |
| Remove unlock with PIN | Yes | No equivalent found | **Built** | Inherited. | [bw-policies] |
| Default website matching | Yes | No equivalent found | **Built** | Inherited. | [bw-policies] |
| Fill on page load, fill assist | Yes (two policies) | Autofill and automatic sign-in policies | **Missing** | Site fixes have their own MSP control instead. | [bw-policies] [op-policies] |
| Remove card item type | Yes | No equivalent found | **Built** | Inherited. | [bw-policies] |
| Automatic login with SSO | Yes | No equivalent found | **Missing** | | [bw-policies] |
| Block sign-ups on a company's domains | Yes (claimed domains) | Account creation with verified domains | **Missing** | Needs domain verification first. | [bw-policies] [op-policies] |
| Let people in without a manual confirm | "Automatic user confirmation" (ask Bitwarden to turn it on) | Provisioning confirms people | **Built** | Ours is on by default and checked against seals a hacked server can't forge (DESIGN.md, "Joining"). | [bw-policies] [op-prov] |
| Vault banner | Yes (2026.7) | No equivalent found | **Missing** | | [bw-policies] |
| Network rules (IP ranges, countries, anonymizers) | No | Firewall rules (Business) | **Missing** | Script access tokens can be limited to networks; signing in can't. | [op-firewall] |
| Travel Mode control | No | Yes (Business) | **Missing** | | [op-travel] [op-policies] |
| Sign-in attempt limits | Not a policy | Yes (Business) | **Partly** | Server-wide limits per account (DESIGN.md, "Login limits"), not set per organization. | [op-policies] |
| App behavior (autosave, passkey saving, file storage, required updates) | Partly, through the policies above | Yes (Business) | **Partly** | The installer turns off the browser's password manager, and self-updates can be turned off by policy. No control of saving or passkeys. | [op-policies] |
| Set policies once for many organizations | Not described for providers | MSP policy templates, with chosen policies open to client changes | **Built** | MSP default policies; a client can have its own setting for any one policy. | [bw-providers] [op-msp-companies] |

## Admin: identity and access

| Feature | Bitwarden | 1Password | PassBundle today | Notes | Sources |
|---|---|---|---|---|---|
| Single sign-on | SAML 2.0 and OIDC (Enterprise), many identity providers | OIDC only (Business): Entra ID, Okta, Google, JumpCloud, OneLogin, Duo, Ping, Auth0, others | **Partly** | Vaultwarden's OIDC sign-in is in our server, off by default, one provider per server, and the master password still unlocks the vault. Not set up per organization, not in DESIGN.md, not tested. | [bw-sso] [op-sso] |
| Unlocking without a master password | SSO with trusted devices (Enterprise); Key Connector (self-hosted) | Unlock with SSO; new devices approved from a linked one | **Planned** | An open proposal: trusted-device unlock for Business (DESIGN.md, "Account keys"). | [bw-tde] [bw-kc] [op-sso] |
| Provisioning from a directory (SCIM) | Teams, Enterprise: Entra ID, Okta, OneLogin, JumpCloud, Ping | Business: Entra ID, Okta, Google Workspace, JumpCloud, OneLogin; the self-hosted SCIM bridge is being retired | **Built** | SCIM 2.0 per organization, from the RFCs and Microsoft's SCIM documentation: Entra invites people as regular members, turns them off and on, removes them, and keeps its groups' members in step; owners, admins, custom roles, and an MSP's staff are never changed. A token per organization, made on its Provisioning page and kept only as a hash. People Entra adds get in with no click through the install command at the client's email domains, or once an admin lets them in. Tested with Entra's documented requests replayed; not yet with a real tenant. Okta and others untested (DESIGN.md, "Provisioning from Entra ID"). | [bw-scim] [op-prov] |
| Directory sync app (AD, LDAP, Entra, Google, Okta) | Directory Connector (Teams, Enterprise) | No separate app; provisioning instead | **Partly** | Our server accepts the import call upstream's Directory Connector makes (inherited). We don't ship or test the connector. | [bw-dc] [op-prov] |
| Admin account recovery | Enterprise | Teams, Business, Families organizers | **Built** | Off by default, needs email, never for MSP staff, and enrolls people who join with the install command. Enrolling at unlock after it's turned on is planned. | [bw-recovery] [op-recovery] |
| Approving a new sign-in from another device | Every plan | New devices get a code from a linked one (with SSO) | **Partly** | Inherited in the server, web vault, and extension. Our apps can't ask or approve yet. | [bw-lwd] [op-sso] |
| Admins approving devices | Enterprise, with trusted devices | Not found in public docs | **Missing** | Comes with trusted-device unlock. | [bw-tde] |
| Custom roles | Enterprise: event logs, import and export, reports, collections, groups, SSO, policies, users, account recovery | Business custom groups: create vaults, recover accounts, manage people, suspend, invite and remove, groups, settings, billing | **Built** | Ours, enforced on the server: manage members, account recovery, policies, event logs, import and export. Collections, groups, and reports later. | [bw-roles] [op-customgroups] |
| Domain verification | Claimed domains by DNS record (Enterprise) | By email or DNS record (Teams, Business) | **Partly** | An install command can be limited to verified email addresses at chosen domains. No DNS verification. | [bw-domains] [op-breach] |

## Admin: logs and reports

| Feature | Bitwarden | 1Password | PassBundle today | Notes | Sources |
|---|---|---|---|---|---|
| Organization event log | Teams, Enterprise; kept indefinitely, CSV | Activity log (Business), 365 days, CSV | **Partly** | Inherited and on for every organization (a server can turn it off with `ORG_EVENTS_ENABLED`), exported as CSV or JSON. Custom roles that view event logs see it, with who acted. The MSP console's activity log is built and on. | [bw-events] [op-activity] |
| Sending events to a SIEM | Teams, Enterprise: Splunk, Rapid7, Sentinel, Elastic, Panther, Sumo Logic, Huntress, Blumira, HEC | Events API (Business): Splunk, Datadog, Elastic, Sentinel, CrowdStrike, Huntress, Blumira, Blackpoint, Todyl, and others | **Built** | Pushed as they happen: a signed webhook (with a collector's token header), syslog over TLS as JSON or CEF, or Microsoft Sentinel's Logs Ingestion API. An MSP's feed gets every client's events and its own activity. Not checked against the real services yet, and no Splunk HEC format or pull API (DESIGN.md, "Sending events to security tools"). | [bw-events] [op-events] |
| Password health for a person | Exposed, reused, weak, unsecured websites, inactive two-step login, data breach (Premium or paid org; breach report free) | Watchtower, every plan: compromised sites, vulnerable, reused, weak, unsecured, two-step available, expiring, duplicates | **Built** | Inherited reports plus our Expiring items, and a count of items to fix beside Health in the web vault's menu. Exposed passwords are checked with k-anonymity: only 5 characters of each password's SHA-1 hash leave the browser (DESIGN.md, "Exposed passwords"). The data breach report needs an HIBP key on the server. | [bw-reports] [op-watchtower] |
| Password health across an organization | Org reports; Access Intelligence (Enterprise) flags at-risk apps and asks for changes | Insights and Watchtower report (Business) | **Built** | Upstream's org reports are inherited, on one set of rules shared with the MSP console. The MSP console shows weak, reused, exposed, and expiring per client, and lists each client's items to fix by name. Exposed checks use k-anonymity (DESIGN.md, "Exposed passwords"). No asking members to change an at-risk password yet. | [bw-reports] [bw-ai] [op-insights] |
| Member access report | Enterprise | Team and device reports (Business) | **Built** | The Access page in each organization's admin console: who opens each shared folder, how (directly or through a group), and with what permission, by person or by folder, with item counts. Removing or revoking someone lists the logins whose passwords they could see (DESIGN.md, "Access and offboarding"). No device report. | [bw-reports] [op-reports] |
| Breach monitoring | Data breach report on demand, by email address | Domain breach report (Teams, Business) | **Partly** | The per-person report is inherited (needs an HIBP key). No domain-wide or continuous monitoring. | [bw-reports] [op-breach] |
| Domain breach report | Not found; the data breach report checks one address at a time | Breaches that include addresses at the company's domains (Teams, Business) | **Missing** | Waits on the owner's decision: it needs a paid Have I Been Pwned API key, kept on the server, and the domains verified with Have I Been Pwned (DESIGN.md, "Domain breach report"). | [bw-reports] [op-breach] |
| Admin API | Teams, Enterprise: members, groups, collections, policies, events | Users, Events, and partnership APIs | **Partly** | Only the inherited directory import call. Our own endpoints aren't a documented API. | [bw-api] [op-dev] |

## MSPs

| Feature | Bitwarden | 1Password | PassBundle today | Notes | Sources |
|---|---|---|---|---|---|
| One console for every client | Provider Portal (through sales; needs an Enterprise org) | MSP Edition console | **Built** | The MSP console in the web vault (DESIGN.md, "MSP console"). | [bw-providers] [bw-providers-faq] [op-msp] |
| Adding clients | New client orgs; existing orgs since 2025.2 | New or existing accounts, optional seat cap, same region only | **Partly** | New clients with a preset in one step. Linking an organization that already exists isn't built. | [bw-providers] [bw-rn] [op-msp-companies] |
| Staff roles and least privilege | Provider admin and service user | Technician groups with five permissions, limited to chosen companies; periodic extra MFA | **Built** | MSP admins and technicians; per-technician clients, a role per client (admin or custom), vault item access, and install command access. | [bw-providers] [op-msp-companies] [op-msp] |
| Staff seeing client items | Provider users can't view or create client items (since 2024.7) or export them (since 2025.1) | The MSP can't see client vault names or items | **Built** | A choice per technician. MSP admins own every client, so they see items; whether they may delete a client is an open question (DESIGN.md). | [bw-rn] [op-msp] |
| Policies once for every client | Not described | Policy templates with overrides | **Built** | Default policies; see "Admin: policies". | [bw-providers] [op-msp-companies] |
| Item templates for every client | Not described | Not described | **Built** | MSP templates, kept current in each client automatically. | [bw-providers] [op-msp-companies] |
| Health and expiry across clients | Reports per client | Usage and seat views; breach and weak-password alerts to clients | **Built** | Per-client counts (weak, reused, exposed, expiring), each client's items to fix by name, and one list of expiring items across clients, computed in the browser. Exposed checks send only 5 characters of each password's SHA-1 hash. | [bw-providers] [op-msp] |
| Rolling out to client machines | No RMM integration found | No RMM integration found; PSA links (Autotask, ConnectWise, Kaseya) through Pax8 | **Built** | A per-client install command for any RMM: Windows, macOS, and Linux scripts, browser policies, the agent, and joins with no manual confirm. | [bw-msp] [bw-integrations] [op-pax8] |
| Credentials for RMM scripts | Secrets Manager, a separate product | Service accounts, per account | **Built** | Script access: tokens scoped to chosen fields in one client, a PowerShell module, every read logged. | [bw-sm] [op-sa] |
| A client leaving or changing MSP | Not described | Unlink (14-day trial) or move to another MSP | **Partly** | A client's owners can remove their MSP in one step. Moving to another MSP, or choosing between several, isn't built. | [op-msp-companies] |
| MSP activity log | "Provider event logs" (details not public) | Activity log of technician actions | **Built** | Every MSP action, in plain sentences. | [bw-providers] [op-msp] |
| Billing | Monthly, seat minimums, pooled seats, PDF and per-client CSV | Usage-based, billed after, daily proration, no minimums, one invoice with a line per client | **Planned** | Pooled MSP seats are a proposal (`site/README.md`); no billing code. MSP staff don't take client seats. | [bw-provbill] [op-msp-billing] |
| MSP pricing | Not published ("tiered discounting") | An undated FAQ: $5 a managed user a month, 5 free internal seats | **Planned** | Proposals only. | [bw-msp] [bw-providers-faq] [op-msp-faq] |
| Partner and marketplace channels | Reseller program | Pax8, Renaissance | **Missing** | | [bw-partners] [op-pax8] |

## Security

| Feature | Bitwarden | 1Password | PassBundle today | Notes | Sources |
|---|---|---|---|---|---|
| Secret Key mixed into the account key | No | Yes, 128 bits | **Planned** | An open proposal: an optional account key for Solo and Family after an outside crypto review (DESIGN.md, "Account keys"). | [bw-white] [op-secretkey] |
| Key derivation | PBKDF2-SHA256 600,000 (default and minimum), or Argon2id | PBKDF2, 650,000, with the Secret Key | **Built** | Inherited: PBKDF2 at 600,000, Argon2id in the web vault. Our apps refuse settings below safe bounds. | [bw-kdf] [op-pbkdf2] |
| Emergency access | Premium: view or takeover after a wait | No trusted-contact feature found; organizer recovery and Emergency Kit | **Built** | Inherited, for every account. Legacy contact improvements are planned (DESIGN.md, "Legacy contacts"). | [bw-ea] [op-kit] [op-organizer] |
| Recovery codes | Two-step login recovery code | Account recovery codes (Individual, Families) | **Built** | The two-step recovery code, inherited. | [bw-recode] [op-recoverycodes] |
| Printable recovery sheet | Not found in public docs | Emergency Kit | **Planned** | A printable sheet for legacy contacts, and a recovery kit in the account key proposal. | [op-kit] |
| Travel Mode | No (forum requests) | Yes, every plan | **Missing** | | [bw-travel] [op-travel] |
| Biometric unlock | Windows Hello, Touch ID, Linux, iOS, Android | Touch ID, Apple Watch, Face ID, Windows Hello, Android, Linux | **Partly** | Windows Hello for the extension and our app through the agent (not yet tried on real hardware); Android and iOS. Touch ID waits on code signing. None on Linux. | [bw-bio] [op-unlock] |
| PIN unlock | Yes, with a policy to remove it | Device passcode on phones | **Partly** | Inherited in the extension. Not in our apps. | [bw-pin] [op-pin] |
| Lock timing | Many choices; lock or log out | Per-platform choices | **Built** | Our apps lock after idle time, on sleep or screen lock, and by policy. | [bw-timeout] [op-unlock] |
| Signing in to the vault with a passkey | Yes (web app and Chromium extensions) | Beta, new Individual accounts | **Missing** | Our server doesn't support it. | [bw-passkeylogin] [op-passkey-unlock] |
| Two-step login methods | Authenticator, email, security keys (free); Duo, YubiKey OTP (Premium) | Authenticator, security keys, Duo (Business) | **Partly** | The server has all five of Bitwarden's, inherited, for every account; organization-wide Duo isn't supported. Our apps sign in with authenticator and email codes only. | [bw-2fa] [op-2fa] |
| New-device protection | Email code for accounts without two-step login | Secret Key plus two-step login | **Partly** | An email on each new-device sign-in (inherited, `REQUIRE_DEVICE_EMAIL`), not a code. | [bw-ndv] [op-signin-report] |

## Developers

| Feature | Bitwarden | 1Password | PassBundle today | Notes | Sources |
|---|---|---|---|---|---|
| Command-line client | Yes | Yes | **Partly** | Upstream's CLI is in our clients fork, not shipped; its dependencies need another look first (DESIGN.md, "Keeping up with upstream"). | [bw-cli] [op-dev] |
| SSH agent | Desktop app (since 2025.1) | Mac, Windows, Linux | **Missing** | Upstream's agent needs a crate with no declared license, which our agent doesn't link. | [bw-sshagent] [op-ssh-agent] |
| Git commit signing | Through the SSH agent | Yes | **Missing** | | [bw-sshagent] [op-ssh] |
| Secrets for scripts and automation | Secrets Manager (separate product) | Service accounts, Connect server | **Built** | Script access, with a PowerShell module. The CLI version is later. | [bw-sm] [op-sa] |
| SDKs, CI, Kubernetes, Terraform, editor plugins | SDKs for Secrets Manager | SDKs, GitHub Actions, Kubernetes, Terraform, VS Code, shell plugins | **Missing** | "CI integrations if developers ask" (DESIGN.md). | [bw-sm] [op-gha] [op-k8s] [op-tf] [op-vscode] |
| AI agent features | MCP server (proof of concept) | Agentic autofill (early access), MCP docs server | **Missing** | | [bw-mcp] [op-dev] |

## Platforms

| Feature | Bitwarden | 1Password | PassBundle today | Notes | Sources |
|---|---|---|---|---|---|
| Browser extensions | Chrome, Edge, Firefox, Safari, Opera, Brave, Vivaldi, DuckDuckGo, Tor | Chrome, Firefox, Edge, Brave, Safari, Arc | **Partly** | Chromium is tested end to end; Edge and Firefox builds are made and linted in CI. No store listings yet, no Safari build. | [bw-download] [op-sysreq] [op-addl-browsers] |
| Desktop apps | Windows, macOS, Linux (Electron) | Mac, Windows, Linux (deb, rpm, AUR, Snap, Flatpak) | **Partly** | Our Flutter app and Rust agent on all three, installed by RMM scripts. Early, unreleased, unsigned; no Linux packages yet. | [bw-download] [bw-stack] [op-linux] |
| Phones | iOS, Android (native; Google Play and F-Droid) | iOS 18+, Android 12+ | **Partly** | Android test releases on GitHub with autofill, passkeys, and biometrics. The iOS app runs in CI without AutoFill. Neither is in a store. | [bw-download] [op-sysreq] |
| Watch | Apple Watch codes (Premium) | Apple Watch | **Planned** | `docs/phones.md` lists watchOS and Wear OS under "Not yet". | [bw-watch] [op-watch] |
| Web vault | Yes | 1Password.com | **Built** | | [bw-download] [op-sysreq] |
| Self-hosting | Docker or Kubernetes | No self-hosted option found | **Built** | One container image (server and web vault), SQLite or PostgreSQL. | [bw-selfhost] |

## Import and export

| Feature | Bitwarden | 1Password | PassBundle today | Notes | Sources |
|---|---|---|---|---|---|
| Importing files from other managers | 68 formats | Browsers, Bitwarden, Dashlane, Delinea, KeePass, KeePassXC, Keeper, LastPass, RoboForm, Dropbox, CSV, 1PUX (the web app takes CSV only) | **Built** | Upstream's 72 import choices in the web vault, a step right after sign-up, and a guided import from each browser. | [bw-importfaq] [op-import] |
| Importing without a file | LastPass, Keeper, Chromium browsers, KeePass, Delinea | Credential Exchange on phones | **Planned** | Automatic browser import through the desktop agent (DESIGN.md, "Browser import"). Upstream's direct LastPass import is in the clients; Unverified on our build. | [bw-lastpass] [bw-rn] [op-import] |
| Apple Passwords | CSV, or Credential Exchange on iOS 26 | Credential Exchange on iOS 26 | **Partly** | The CSV from a Mac, through the guided import. Credential Exchange is planned. | [bw-import] [op-import] |
| Credential Exchange (FIDO) | iOS 26 (2025.9), Android (2026.7) | iOS 26+, Android 14+; phones only | **Planned** | Waits on the iPhone app and the Apple Developer account. | [bw-export] [op-import] |
| Exporting | JSON, CSV, encrypted JSON, ZIP with attachments | 1PUX, CSV (unencrypted); Credential Exchange on phones | **Built** | Inherited in the web vault and extension, all four formats. Not in our apps. | [bw-export] [op-export] |
| Bulk import of shared vaults into collections | Organization import | Not found in public docs | **Planned** | Mapping a source's shared folders to collections (DESIGN.md, "Importing from other password managers"). | [bw-import] |

## Integrations

| Feature | Bitwarden | 1Password | PassBundle today | Notes | Sources |
|---|---|---|---|---|---|
| Email aliases from the generator | SimpleLogin, addy.io, Firefox Relay, Fastmail, Forward Email, DuckDuckGo | Fastmail Masked Email | **Built** | The same six, inherited in the extension and web vault. Not in our apps. | [bw-gen] [op-fastmail] |
| Duo | Personal (Premium), organization-wide (Teams, Enterprise) | Business | **Partly** | Personal Duo, inherited. No organization-wide Duo. | [bw-2fa] [op-duo] |
| YubiKey and security keys | Security keys (free), YubiKey OTP (Premium) | Security keys | **Built** | Inherited. YubiKey OTP needs Yubico keys on the server. | [bw-fido] [op-2fa] |
| Chat alerts | Not found in public docs | Slack (Teams, Business) | **Missing** | | [op-slack] |
| Virtual payment cards | Not found in public docs | Privacy Cards (US) | **Missing** | | [op-privacy] |
| Device trust | Not found in public docs | Device Trust (sold separately) | **Missing** | | [op-xam] |

## Prices, for reference

From the public pricing pages, billed yearly, in US dollars.

| | Bitwarden | 1Password |
|---|---|---|
| Free | Yes | No |
| One person | Premium, $19.80 a year | Individual, $3.99 a month |
| Family | Families (6), $3.99 a month | Families (5), $5.99 a month |
| Small team | Teams, $4 a person a month | Teams Starter Pack (up to 10), $24.95 a month |
| Business | Enterprise, $6 a person a month | Business, $8.99 a person a month |

PassBundle's prices are proposals (`site/README.md`). Sources: [bw-pricing] [bw-pricing-biz] [op-pricing] [op-pricing-biz].

## What PassBundle has that the public pages we read don't describe

- MSP item templates that reach every client and stay current there, and custom item templates for anyone.
- A per-client install command for any RMM that enrolls people with no manual confirm, and joins a hacked server can't forge.
- Script access: tokens scoped to chosen fields of chosen items in one client, with a PowerShell module.
- Site-aware password generation from Apple's published password rules.
- Generator settings that follow the account to every device.

Bitwarden's Fill assist and 1Password's MSP policy templates are close to our site fixes and default policies.

## Gaps worth closing first for MSPs

Ranked by how often an MSP will hit them when choosing between the three.

1. **Entra ID provisioning (SCIM).** Adding and removing people is an MSP's daily work, and both others automate it from the directory. Built since this list was made (DESIGN.md, "Provisioning from Entra ID"); what's left is checking it with a real Microsoft 365 tenant.
2. **SSO per organization with Entra, then trusted-device unlock.** Clients on Microsoft 365 expect one sign-in; ours is one OIDC provider per server, and the master password still unlocks.
3. **iOS AutoFill and passkeys.** Without them our iPhone app is copy and paste, and many client staff carry iPhones.
4. **MSP billing: pooled seats and one monthly invoice with a line per client.** Both others have it, and MSPs won't resell without it.
5. **Events sent to SIEM and MDR tools** (Huntress, Blumira, Sentinel). MSP security stacks expect it, and both others ship connectors. Built (webhook, syslog over TLS, Sentinel, and an MSP-wide feed); still to check against the real services.
6. **Signed, store-listed releases:** extensions in the Chrome, Edge, and Firefox stores, a signed MSI, a notarized Mac app, and a Safari extension. Force-installing needs store IDs, and Mac clients use Safari.
7. **Linking an existing organization to an MSP, and moving a client between MSPs.** Both others allow it; without it, a client that started on its own can't be taken over.
8. **Exposed passwords in the MSP health view, and a domain breach report.** "Your client's passwords are in a breach" is how MSPs sell security work, and both others report it. Exposed passwords are built since this list was made (DESIGN.md, "Exposed passwords"); the domain breach report waits on the owner's decision about a paid Have I Been Pwned key.
9. **A remove-export policy.** Clients' compliance asks for it, and Vaultwarden doesn't support the policy; each shared folder's export permission (built) covers part of it.
10. **Groups manageable by custom roles.** Clients' departments map to groups; ours are on, but only owners and admins manage them.
11. **Filling Windows desktop apps** (Quick Access or auto-type style). Many small businesses run desktop line-of-business apps; 1Password fills them, and Bitwarden is building it.
12. **Firewall rules per organization** (allowed networks and countries). MSPs like to keep a client's vault to its offices; 1Password offers it.
13. **Item version history in the extension and our apps.** Technicians editing shared documentation need more undo than password history; the web vault has it, and the rest should show and restore the same versions.
14. **Guests for contractors:** one shared vault, no seat. Clients' outside vendors need a few credentials; 1Password includes guests.
15. **Approving new sign-ins from our apps, and a CLI release for macOS and Linux scripts.** The extension and web vault already approve sign-ins, and script access has PowerShell only.

## Things to skip

- **Travel Mode:** a border-crossing feature for individuals; small-business clients rarely need it, and it complicates sync.
- **A typed Secret Key for business accounts:** the trusted-device unlock proposal does a Secret Key's job for Business without anyone typing one, which is the onboarding step we set out to remove.
- **SAML alongside OIDC:** Entra, Google, and Okta all speak OIDC, and 1Password ships OIDC only.
- **Key Connector:** a key server per client is a self-hosting niche that trusted-device unlock covers.
- **Virtual payment cards:** a US consumer partnership with nothing for an MSP.
- **Watch apps** (listed under "Not yet" in `docs/phones.md`): little business value for the effort; phones already show one-time codes.
- **Developer tooling** (Kubernetes, Terraform, SDKs, shell plugins, CI): a different market; script access covers RMM scripts.
- **SSH agent and Git commit signing:** a developer feature, and upstream's version needs a crate we can't link.
- **AI agent integrations:** early on both sides, and not what MSP clients buy.
- **Device trust and SaaS management:** a separate product category; MSPs already run RMM and EDR for device health.
- **A Document item type:** attachments on a note do the same.
- **Business-unit portals for large enterprises:** the MSP console already covers many organizations.

## What we couldn't verify

- **Bitwarden:** the bank account, passport, and driver's license types are only a forum sighting; desktop auto-type and the desktop passkey provider are "coming soon" with no date; the provider event log's contents; MSP discounts; whether Share via link works on phones; any guest role; continuous email breach monitoring.
- **1Password:** how long item history is kept; file size limits outside Business; the current MSP price (only an undated $5 figure); passkey unlock for existing accounts; Rippling provisioning; whether shared vaults can be exported; any per-person email breach alerts; email forwarders other than Fastmail; a self-hosted option (none found); per-field fill mapping and fixes for problem sites (none found).
- **PassBundle:** whether the hosted service turns on SSO, an HIBP key, or the new item types flag (that configuration isn't in these repos); whether upstream's direct LastPass import works on our build; Windows Hello on real hardware.

## Sources

Bitwarden:

- `bw-items` Managing items: <https://bitwarden.com/help/managing-items/>
- `bw-ssh` SSH keys: <https://bitwarden.com/help/about-ssh/>
- `bw-rn` Release notes: <https://bitwarden.com/help/releasenotes.md>
- `bw-2605` 2026.5.0 release notes (forum): <https://community.bitwarden.com/t/2026-5-0-release-notes/97160>
- `bw-passkeys` Storing passkeys: <https://bitwarden.com/help/storing-passkeys/>
- `bw-attach` Attachments: <https://bitwarden.com/help/attachments/>
- `bw-fields` Custom fields: <https://bitwarden.com/help/custom-fields/>
- `bw-newtypes` New item types spotted (forum): <https://community.bitwarden.com/t/new-vault-item-types-passport-dl-bank-account-spotted-in-2026-5-0-has-anyone-seen-these-yet/97383>
- `bw-history` Password and generator history: <https://bitwarden.com/help/password-and-generator-history/>
- `bw-fav` Favorites: <https://bitwarden.com/help/favorites/>
- `bw-folders` Folders: <https://bitwarden.com/help/folders/>
- `bw-tags` Tags request (forum): <https://community.bitwarden.com/t/vault-item-labels-tags/132>
- `bw-fill` Autofill in the browser: <https://bitwarden.com/help/auto-fill-browser/>
- `bw-totp` Authenticator keys: <https://bitwarden.com/help/authenticator-keys/>
- `bw-fillassist` Fill assist: <https://bitwarden.com/help/fill-assist/>
- `bw-desktop-passkey` Desktop passkeys (forum): <https://community.bitwarden.com/t/desktop-app-native-use-of-passkeys-macos-windows/71975>
- `bw-sep26` September 2026 product update: <https://bitwarden.com/blog/september-2026-product-update-for-bitwarden-business-plans/>
- `bw-autotype` Auto-type (forum): <https://community.bitwarden.com/t/auto-type-for-windows-and-macos-desktop-apps/93873>
- `bw-android` Autofill on Android: <https://bitwarden.com/help/auto-fill-android/>
- `bw-ios` Autofill on iOS: <https://bitwarden.com/help/auto-fill-ios/>
- `bw-uri` URI match detection: <https://bitwarden.com/help/uri-match-detection/>
- `bw-orgs` About organizations: <https://bitwarden.com/help/about-organizations/>
- `bw-sharing` Sharing: <https://bitwarden.com/help/sharing/>
- `bw-collperm` Collection permissions: <https://bitwarden.com/help/collection-permissions/>
- `bw-plans` Password Manager plans: <https://bitwarden.com/help/password-manager-plans/>
- `bw-send` About Send: <https://bitwarden.com/help/about-send/>
- `bw-roles` Member roles: <https://bitwarden.com/help/user-types-access-control/>
- `bw-policies` Enterprise policies: <https://bitwarden.com/help/policies/>
- `bw-sso` SSO FAQs: <https://bitwarden.com/help/sso-faqs/>
- `bw-tde` Trusted devices: <https://bitwarden.com/help/about-trusted-devices/>
- `bw-kc` Key Connector: <https://bitwarden.com/help/about-key-connector/>
- `bw-scim` SCIM: <https://bitwarden.com/help/about-scim/>
- `bw-dc` Directory Connector: <https://bitwarden.com/help/directory-sync/>
- `bw-recovery` Account recovery: <https://bitwarden.com/help/account-recovery/>
- `bw-lwd` Log in with device: <https://bitwarden.com/help/log-in-with-device/>
- `bw-events` Event logs: <https://bitwarden.com/help/event-logs/>
- `bw-reports` Reports: <https://bitwarden.com/help/reports/>
- `bw-ai` Access Intelligence: <https://bitwarden.com/help/access-intelligence/>
- `bw-domains` Domain verification: <https://bitwarden.com/help/domain-verification/>
- `bw-api` Public API: <https://bitwarden.com/help/public-api/>
- `bw-providers` Providers: <https://bitwarden.com/help/providers/>
- `bw-providers-faq` Provider FAQs: <https://bitwarden.com/help/providers-faqs/>
- `bw-provbill` Provider billing: <https://bitwarden.com/help/provider-billing/>
- `bw-partners` Partner program: <https://bitwarden.com/partners/become-a-partner/>
- `bw-msp` For MSPs: <https://bitwarden.com/msp/>
- `bw-integrations` Integrations: <https://bitwarden.com/integrations/>
- `bw-travel` Travel mode request (forum): <https://community.bitwarden.com/t/travel-mode/50779>
- `bw-ea` Emergency access: <https://bitwarden.com/help/emergency-access/>
- `bw-recode` Two-step recovery code: <https://bitwarden.com/help/two-step-recovery-code/>
- `bw-white` Security white paper: <https://bitwarden.com/help/bitwarden-security-white-paper/>
- `bw-kdf` KDF algorithms: <https://bitwarden.com/help/kdf-algorithms/>
- `bw-bio` Biometrics: <https://bitwarden.com/help/biometrics/>
- `bw-pin` Unlock with PIN: <https://bitwarden.com/help/unlock-with-pin/>
- `bw-timeout` Vault timeout: <https://bitwarden.com/help/vault-timeout/>
- `bw-passkeylogin` Log in with passkeys: <https://bitwarden.com/help/login-with-passkeys/>
- `bw-2fa` Two-step login: <https://bitwarden.com/help/setup-two-step-login/>
- `bw-fido` Security keys: <https://bitwarden.com/help/setup-two-step-login-fido/>
- `bw-ndv` New device verification: <https://bitwarden.com/help/new-device-verification/>
- `bw-cli` CLI: <https://bitwarden.com/help/cli/>
- `bw-sshagent` SSH agent: <https://bitwarden.com/help/ssh-agent/>
- `bw-sm` Secrets Manager: <https://bitwarden.com/products/secrets-manager/>
- `bw-mcp` MCP server: <https://bitwarden.com/blog/bitwarden-mcp-server/>
- `bw-download` Downloads: <https://bitwarden.com/download/>
- `bw-stack` Tech stack: <https://bitwarden.com/blog/the-bitwarden-tech-stack-built-for-security-and-scalability/>
- `bw-watch` Apple Watch: <https://bitwarden.com/help/apple-watch-totp/>
- `bw-selfhost` Self-hosting on Linux: <https://bitwarden.com/help/install-on-premise-linux/>
- `bw-importfaq` Import FAQs: <https://bitwarden.com/help/import-faqs/>
- `bw-import` Import data: <https://bitwarden.com/help/import-data/>
- `bw-lastpass` Import from LastPass: <https://bitwarden.com/help/import-from-lastpass/>
- `bw-export` Export your data: <https://bitwarden.com/help/export-your-data/>
- `bw-gen` Generator: <https://bitwarden.com/help/generator/>
- `bw-pricing` Pricing: <https://bitwarden.com/pricing/>
- `bw-pricing-biz` Business pricing: <https://bitwarden.com/pricing/business/>

1Password:

- `op-categories` Item categories: <https://support.1password.com/item-categories/>
- `op-passkeys` Save and use passkeys: <https://support.1password.com/save-use-passkeys/>
- `op-fields` Custom fields: <https://support.1password.com/custom-fields/>
- `op-templates-forum` Custom item templates (community): <https://www.1password.community/1password-at-home-31/custom-item-templates-23902>
- `op-files` Files: <https://support.1password.com/files/>
- `op-history` Item history: <https://support.1password.com/item-history/>
- `op-archive` Archive and delete items: <https://support.1password.com/archive-delete-items/>
- `op-tags` Favorites and tags: <https://support.1password.com/favorites-tags/>
- `op-watchtower` Watchtower: <https://support.1password.com/watchtower/>
- `op-browser` Getting started in the browser: <https://support.1password.com/getting-started-browser/>
- `op-otp` One-time passwords: <https://support.1password.com/one-time-passwords/>
- `op-cards` Credit cards and addresses: <https://support.1password.com/credit-card-address-filling/>
- `op-android` Android autofill: <https://support.1password.com/android-autofill/>
- `op-ios` iOS AutoFill: <https://support.1password.com/ios-autofill/>
- `op-macos-autofill` macOS AutoFill: <https://support.1password.com/macos-autofill/>
- `op-win-rn` Windows 8.11.18 release notes: <https://releases.1password.com/windows/stable/8.11.18/>
- `op-qa` Quick Access: <https://support.1password.com/quick-access/>
- `op-ua` Universal Autofill (Mac): <https://support.1password.com/mac-universal-autofill/>
- `op-autotype` Auto-Type (Windows): <https://support.1password.com/windows-auto-type/>
- `op-behavior` Autofill behavior: <https://support.1password.com/autofill-behavior/>
- `op-policies` Team policies: <https://support.1password.com/team-policies/>
- `op-employee` Employee vault: <https://support.1password.com/employee-vault/>
- `op-vaults` Vault permissions: <https://support.1password.com/create-share-vaults-teams/>
- `op-groups` Groups: <https://support.1password.com/groups/>
- `op-guests` Guests: <https://support.1password.com/guests-teams/>
- `op-share` Share items: <https://support.1password.com/share-items/>
- `op-share-admin` Manage item sharing: <https://support.1password.com/manage-item-sharing/>
- `op-organizer` Family organizer: <https://support.1password.com/family-organizer/>
- `op-firewall` Firewall rules: <https://support.1password.com/firewall-rules/>
- `op-travel` Travel Mode: <https://support.1password.com/travel-mode/>
- `op-sso` Unlock with SSO: <https://support.1password.com/sso/>
- `op-prov` Provisioning: <https://support.1password.com/provisioning/>
- `op-recovery` Account recovery: <https://support.1password.com/recovery/>
- `op-customgroups` Custom groups: <https://support.1password.com/custom-groups/>
- `op-activity` Activity log: <https://support.1password.com/activity-log/>
- `op-events` Events reporting: <https://support.1password.com/events-reporting/>
- `op-reports` Reports: <https://support.1password.com/reports/>
- `op-insights` Insights: <https://support.1password.com/insights/>
- `op-breach` Domain breach report: <https://support.1password.com/breach-report/>
- `op-xam` Extended Access Management: <https://1password.com/extended-access-management>
- `op-msp` MSP Edition: <https://1password.com/product/enterprise-password-manager-msp-edition>
- `op-msp-companies` Managed companies: <https://support.1password.com/msp-manage-companies/>
- `op-msp-billing` MSP billing: <https://support.1password.com/msp-billing/>
- `op-msp-faq` MSP FAQ (PDF): <https://support.1password.com/files/msp/faq-msp.pdf>
- `op-pax8` MSP Edition on Pax8: <https://1password.com/blog/msp-edition-1password-enterprise-password-manager-available-on-pax8-marketplace>
- `op-kit` Emergency Kit: <https://support.1password.com/emergency-kit/>
- `op-secretkey` Secret Key: <https://support.1password.com/secret-key-security/>
- `op-pbkdf2` PBKDF2: <https://support.1password.com/pbkdf2/>
- `op-recoverycodes` Recovery codes: <https://support.1password.com/recovery-codes/>
- `op-unlock` Unlock and auto-lock: <https://support.1password.com/unlock-auto-lock/>
- `op-pin` Passcode unlock: <https://support.1password.com/password-passcode-unlock/>
- `op-2fa` Two-factor authentication: <https://support.1password.com/two-factor-authentication/>
- `op-duo` Duo: <https://support.1password.com/duo/>
- `op-passkey-unlock` Passkeys: <https://1password.com/product/passkeys>
- `op-signin-report` Sign-in attempts report: <https://support.1password.com/sign-in-attempts-report/>
- `op-dev` Developer docs: <https://www.1password.dev/>
- `op-ssh-agent` SSH agent: <https://www.1password.dev/ssh/agent/>
- `op-ssh` SSH and Git: <https://www.1password.dev/ssh/>
- `op-sa` Service accounts: <https://www.1password.dev/service-accounts/>
- `op-gha` GitHub Actions: <https://developer.1password.com/docs/ci-cd/github-actions/>
- `op-k8s` Kubernetes Operator: <https://www.1password.dev/k8s/operator>
- `op-tf` Terraform: <https://developer.1password.com/docs/terraform/>
- `op-vscode` VS Code: <https://www.1password.dev/vscode/>
- `op-sysreq` System requirements: <https://support.1password.com/system-requirements/>
- `op-addl-browsers` Other browsers: <https://support.1password.com/additional-browsers/>
- `op-linux` Install on Linux: <https://support.1password.com/install-linux/>
- `op-watch` Apple Watch: <https://support.1password.com/apple-watch/>
- `op-import` Import: <https://support.1password.com/import/>
- `op-export` Export: <https://support.1password.com/export/>
- `op-fastmail` Fastmail: <https://support.1password.com/fastmail/>
- `op-privacy` Privacy Cards: <https://support.1password.com/privacy-cards/>
- `op-slack` Slack: <https://support.1password.com/slack/>
- `op-pricing` Pricing: <https://1password.com/pricing/password-manager>
- `op-pricing-biz` Business pricing: <https://1password.com/pricing/business>

[bw-items]: https://bitwarden.com/help/managing-items/
[bw-ssh]: https://bitwarden.com/help/about-ssh/
[bw-rn]: https://bitwarden.com/help/releasenotes.md
[bw-2605]: https://community.bitwarden.com/t/2026-5-0-release-notes/97160
[bw-passkeys]: https://bitwarden.com/help/storing-passkeys/
[bw-attach]: https://bitwarden.com/help/attachments/
[bw-fields]: https://bitwarden.com/help/custom-fields/
[bw-newtypes]: https://community.bitwarden.com/t/new-vault-item-types-passport-dl-bank-account-spotted-in-2026-5-0-has-anyone-seen-these-yet/97383
[bw-history]: https://bitwarden.com/help/password-and-generator-history/
[bw-fav]: https://bitwarden.com/help/favorites/
[bw-folders]: https://bitwarden.com/help/folders/
[bw-tags]: https://community.bitwarden.com/t/vault-item-labels-tags/132
[bw-fill]: https://bitwarden.com/help/auto-fill-browser/
[bw-totp]: https://bitwarden.com/help/authenticator-keys/
[bw-fillassist]: https://bitwarden.com/help/fill-assist/
[bw-desktop-passkey]: https://community.bitwarden.com/t/desktop-app-native-use-of-passkeys-macos-windows/71975
[bw-sep26]: https://bitwarden.com/blog/september-2026-product-update-for-bitwarden-business-plans/
[bw-autotype]: https://community.bitwarden.com/t/auto-type-for-windows-and-macos-desktop-apps/93873
[bw-android]: https://bitwarden.com/help/auto-fill-android/
[bw-ios]: https://bitwarden.com/help/auto-fill-ios/
[bw-uri]: https://bitwarden.com/help/uri-match-detection/
[bw-orgs]: https://bitwarden.com/help/about-organizations/
[bw-sharing]: https://bitwarden.com/help/sharing/
[bw-collperm]: https://bitwarden.com/help/collection-permissions/
[bw-plans]: https://bitwarden.com/help/password-manager-plans/
[bw-send]: https://bitwarden.com/help/about-send/
[bw-roles]: https://bitwarden.com/help/user-types-access-control/
[bw-policies]: https://bitwarden.com/help/policies/
[bw-sso]: https://bitwarden.com/help/sso-faqs/
[bw-tde]: https://bitwarden.com/help/about-trusted-devices/
[bw-kc]: https://bitwarden.com/help/about-key-connector/
[bw-scim]: https://bitwarden.com/help/about-scim/
[bw-dc]: https://bitwarden.com/help/directory-sync/
[bw-recovery]: https://bitwarden.com/help/account-recovery/
[bw-lwd]: https://bitwarden.com/help/log-in-with-device/
[bw-events]: https://bitwarden.com/help/event-logs/
[bw-reports]: https://bitwarden.com/help/reports/
[bw-ai]: https://bitwarden.com/help/access-intelligence/
[bw-domains]: https://bitwarden.com/help/domain-verification/
[bw-api]: https://bitwarden.com/help/public-api/
[bw-providers]: https://bitwarden.com/help/providers/
[bw-providers-faq]: https://bitwarden.com/help/providers-faqs/
[bw-provbill]: https://bitwarden.com/help/provider-billing/
[bw-partners]: https://bitwarden.com/partners/become-a-partner/
[bw-msp]: https://bitwarden.com/msp/
[bw-integrations]: https://bitwarden.com/integrations/
[bw-travel]: https://community.bitwarden.com/t/travel-mode/50779
[bw-ea]: https://bitwarden.com/help/emergency-access/
[bw-recode]: https://bitwarden.com/help/two-step-recovery-code/
[bw-white]: https://bitwarden.com/help/bitwarden-security-white-paper/
[bw-kdf]: https://bitwarden.com/help/kdf-algorithms/
[bw-bio]: https://bitwarden.com/help/biometrics/
[bw-pin]: https://bitwarden.com/help/unlock-with-pin/
[bw-timeout]: https://bitwarden.com/help/vault-timeout/
[bw-passkeylogin]: https://bitwarden.com/help/login-with-passkeys/
[bw-2fa]: https://bitwarden.com/help/setup-two-step-login/
[bw-fido]: https://bitwarden.com/help/setup-two-step-login-fido/
[bw-ndv]: https://bitwarden.com/help/new-device-verification/
[bw-cli]: https://bitwarden.com/help/cli/
[bw-sshagent]: https://bitwarden.com/help/ssh-agent/
[bw-sm]: https://bitwarden.com/products/secrets-manager/
[bw-mcp]: https://bitwarden.com/blog/bitwarden-mcp-server/
[bw-download]: https://bitwarden.com/download/
[bw-stack]: https://bitwarden.com/blog/the-bitwarden-tech-stack-built-for-security-and-scalability/
[bw-watch]: https://bitwarden.com/help/apple-watch-totp/
[bw-selfhost]: https://bitwarden.com/help/install-on-premise-linux/
[bw-importfaq]: https://bitwarden.com/help/import-faqs/
[bw-import]: https://bitwarden.com/help/import-data/
[bw-lastpass]: https://bitwarden.com/help/import-from-lastpass/
[bw-export]: https://bitwarden.com/help/export-your-data/
[bw-gen]: https://bitwarden.com/help/generator/
[bw-pricing]: https://bitwarden.com/pricing/
[bw-pricing-biz]: https://bitwarden.com/pricing/business/
[op-categories]: https://support.1password.com/item-categories/
[op-passkeys]: https://support.1password.com/save-use-passkeys/
[op-fields]: https://support.1password.com/custom-fields/
[op-templates-forum]: https://www.1password.community/1password-at-home-31/custom-item-templates-23902
[op-files]: https://support.1password.com/files/
[op-history]: https://support.1password.com/item-history/
[op-archive]: https://support.1password.com/archive-delete-items/
[op-tags]: https://support.1password.com/favorites-tags/
[op-watchtower]: https://support.1password.com/watchtower/
[op-browser]: https://support.1password.com/getting-started-browser/
[op-otp]: https://support.1password.com/one-time-passwords/
[op-cards]: https://support.1password.com/credit-card-address-filling/
[op-android]: https://support.1password.com/android-autofill/
[op-ios]: https://support.1password.com/ios-autofill/
[op-macos-autofill]: https://support.1password.com/macos-autofill/
[op-win-rn]: https://releases.1password.com/windows/stable/8.11.18/
[op-qa]: https://support.1password.com/quick-access/
[op-ua]: https://support.1password.com/mac-universal-autofill/
[op-autotype]: https://support.1password.com/windows-auto-type/
[op-behavior]: https://support.1password.com/autofill-behavior/
[op-policies]: https://support.1password.com/team-policies/
[op-employee]: https://support.1password.com/employee-vault/
[op-vaults]: https://support.1password.com/create-share-vaults-teams/
[op-groups]: https://support.1password.com/groups/
[op-guests]: https://support.1password.com/guests-teams/
[op-share]: https://support.1password.com/share-items/
[op-share-admin]: https://support.1password.com/manage-item-sharing/
[op-organizer]: https://support.1password.com/family-organizer/
[op-firewall]: https://support.1password.com/firewall-rules/
[op-travel]: https://support.1password.com/travel-mode/
[op-sso]: https://support.1password.com/sso/
[op-prov]: https://support.1password.com/provisioning/
[op-recovery]: https://support.1password.com/recovery/
[op-customgroups]: https://support.1password.com/custom-groups/
[op-activity]: https://support.1password.com/activity-log/
[op-events]: https://support.1password.com/events-reporting/
[op-reports]: https://support.1password.com/reports/
[op-insights]: https://support.1password.com/insights/
[op-breach]: https://support.1password.com/breach-report/
[op-xam]: https://1password.com/extended-access-management
[op-msp]: https://1password.com/product/enterprise-password-manager-msp-edition
[op-msp-companies]: https://support.1password.com/msp-manage-companies/
[op-msp-billing]: https://support.1password.com/msp-billing/
[op-msp-faq]: https://support.1password.com/files/msp/faq-msp.pdf
[op-pax8]: https://1password.com/blog/msp-edition-1password-enterprise-password-manager-available-on-pax8-marketplace
[op-kit]: https://support.1password.com/emergency-kit/
[op-secretkey]: https://support.1password.com/secret-key-security/
[op-pbkdf2]: https://support.1password.com/pbkdf2/
[op-recoverycodes]: https://support.1password.com/recovery-codes/
[op-unlock]: https://support.1password.com/unlock-auto-lock/
[op-pin]: https://support.1password.com/password-passcode-unlock/
[op-2fa]: https://support.1password.com/two-factor-authentication/
[op-duo]: https://support.1password.com/duo/
[op-passkey-unlock]: https://1password.com/product/passkeys
[op-signin-report]: https://support.1password.com/sign-in-attempts-report/
[op-dev]: https://www.1password.dev/
[op-ssh-agent]: https://www.1password.dev/ssh/agent/
[op-ssh]: https://www.1password.dev/ssh/
[op-sa]: https://www.1password.dev/service-accounts/
[op-gha]: https://developer.1password.com/docs/ci-cd/github-actions/
[op-k8s]: https://www.1password.dev/k8s/operator
[op-tf]: https://developer.1password.com/docs/terraform/
[op-vscode]: https://www.1password.dev/vscode/
[op-sysreq]: https://support.1password.com/system-requirements/
[op-addl-browsers]: https://support.1password.com/additional-browsers/
[op-linux]: https://support.1password.com/install-linux/
[op-watch]: https://support.1password.com/apple-watch/
[op-import]: https://support.1password.com/import/
[op-export]: https://support.1password.com/export/
[op-fastmail]: https://support.1password.com/fastmail/
[op-privacy]: https://support.1password.com/privacy-cards/
[op-slack]: https://support.1password.com/slack/
[op-pricing]: https://1password.com/pricing/password-manager
[op-pricing-biz]: https://1password.com/pricing/business
