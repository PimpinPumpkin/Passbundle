# Before launching to companies

The work queue between now and selling PassBundle to MSPs and their clients. Background jobs take items from the top of "Next"; each lands as a pull request that merges when CI is green, after a security review when it touches permissions, keys, sign-in, or updates. The gap ranking comes from docs/parity.md.

## Done

- **Folders and per-folder permissions**: Personal plus each organization's shared folders, with presets and a grid of ten permissions, enforced by the server and the apps.
- **Entra ID provisioning** over SCIM 2.0 (DESIGN.md, "Provisioning from Entra ID"). Checking it with a real tenant waits on a Microsoft 365 tenant.
- **Phone app polish**: settings layout, offering fingerprint or Face ID unlock after sign-in, and a Mac window large enough for its sidebar.
- **The apps' logo and icons**, and Windows and Linux windows that remember their size and place.
- **Hands-on test checklist** for the owner: docs/hands-on-testing.md.
- **Extension redesign** from the approved mockups: jewel-tone categories, site icons, the "Where's your vault?" sign-in, and an item view with big copy buttons.
- **Approving a new sign-in from our apps** (DESIGN.md, "Approving a sign-in from another device"): "Log in with device" on the web vault or the extension, approved on the phone or computer after comparing the fingerprint phrase, with the security review's fixes. Later: a notice on a closed phone (push), and SSO sessions approving.
- **Self-updating Windows and Linux apps** (October 26): test releases on GitHub with a signed manifest, which the apps update themselves from, as the Mac and Android ones do (DESIGN.md, "Desktop updates (Windows and Linux)"; the newest are windows-v0.1.8 and linux-v0.1.8).
- **Desktop and phone parity with the web vault**: folders and their permissions, templates, site icons, item history, password health, and a Generator tab on phones, with the security review's fixes.
- **Web vault redesign** from the approved mockups: the menu as a card with jewel tiles, rows of site icons and tiles, the selected item in a side panel beside the list, and graphite glass, a neutral dark mode, for the web vault and the extension.
- **Exposed passwords in the MSP health view**, using the k-anonymity range check, with an off switch for the check after unlocking.
- **Events to security tools**: a signed webhook, syslog over TLS (JSON or CEF), and Microsoft Sentinel, per organization or one feed for an MSP.
- **Two-step login for admins** (DESIGN.md, "Two-step login for admins"): a client's owners, admins, custom roles that manage members, policies, or account recovery, and every MSP's staff sign in with an authenticator app, a security key or passkey, Duo, or the client's own single sign-on. On by default for the Business preset and every MSP.
- **Item history and the new folders in the extension**: version history with restore, folders by owner, and see passwords, export, and share enforced on every extension path.
- **Command-line tool** (`passbundle`, docs/cli.md) for macOS, Linux, and Windows scripts, with folder permissions enforced on every command, released from this repository (`cli-release.yml`). Its releases are signed once the CLI release key is made (below).
- **Offboarding that holds** (DESIGN.md, "Offboarding"): removing an MSP, or one of its people, revokes what they made and holds; a client's own owners stay the client's; joining seals (version 2) and script grant seals (version 3) a hacked server can't steer.
- **Sign in with Entra (SSO) per organization** (DESIGN.md, "Sign in with Microsoft Entra ID"; setup in docs/sso-entra.md), tested against a stand-in for Entra. Checking it with a real tenant waits on a Microsoft 365 tenant. Later: trusted-device unlock, as its own design with test vectors.
- **Website redesign** in the new look (October 27): passbundle.com's pages in the apps' look, with the MSP story up front, on the preview address (https://preview.passbundle.pages.dev) until launch.
- **The pre-launch security pass** (October 27 to November 4) over the server, web vault, extension, apps, CI, and releases, with its fixes merged: connector pages that refuse other sites, PassBundle's own extension IDs, HSTS, the server's pass (DESIGN.md, "Running the server safely"), autofill, import, and extension hardening, offboarding and seal follow-ups, and Android vaults that autofill unlocked locking on time. Its low findings followed in pull requests of their own.

## In progress

Nothing right now.

## Next

Fixes from the owner's hands-on testing (docs/hands-on-testing.md) come first.

## Waiting on you

- **Production hosting**: a storage bucket for backups at a second provider (Backblaze or Cloudflare R2), a backup key made on your own computer (ops/hosting/README.md, "The backup key"), and the go-ahead to point vault.passbundle.com at the hosted stack.
- **Email**: a sending provider (Postmark, Amazon SES, or Resend) so invitations, verification and account recovery mail go out.
- **A Microsoft 365 tenant** (a free developer tenant is enough) to check Entra provisioning (built; the checks are in DESIGN.md, "Provisioning from Entra ID", "Status") and single sign-on (built; the checks are in docs/sso-entra.md, "Checking it with a real tenant") for real.
- **Apple Developer account** for the iPhone app, iPhone AutoFill, and a notarized Mac app and command-line tool.
- **The command-line tool's release key**: its own Ed25519 key, made on your computer and added as the `PASSBUNDLE_CLI_RELEASE_KEY` secret, with its public key pinned in `cli-release.yml` (docs/cli.md, "The CLI release key", has the commands). Until then its releases carry SHA256SUMS and an unsigned manifest.
- **Store listings** when you want them (you said not yet): Chrome, Edge, Firefox.
- **Business details for the site and legal pages**: legal name, payment processor, refunds, governing law, prices (marked as placeholders in site/).
- **A paid Have I Been Pwned key** for the report of breached accounts at a client's email domain.
- **MSP billing**: Stripe and the pricing model, including what an MSP's invoice is based on (proposed: each client's most seats on any day; DESIGN.md, "Seats by client").
- **GitHub environments for the signing secrets**: `android-release`, `macos-release`, and `desktop-release` in passbundle-apps, and `cli-release` here, each holding its release workflow's signing secrets and deployable only from `main`; then uncomment the `environment:` line in each sign job. Until then only the way the workflows are written keeps other workflows from reading them (DESIGN.md, "Desktop updates (Windows and Linux)", "The key").
- **Approval for every outside contributor's pull request** to run workflows (each repository's Settings, Actions, General), so a fork's pull request runs nothing until you've looked at it.
- **Versioning on the backups bucket**, once it's made, so a backup that's overwritten or deleted can still be got back.
