# Before launching to companies

The work queue between now and selling PassBundle to MSPs and their clients. Background jobs take items from the top of "Next"; each lands as a pull request that merges when CI is green, after a security review when it touches permissions, keys, sign-in, or updates. The gap ranking comes from docs/parity.md.

## Done

- **Folders and per-folder permissions**: Personal plus each organization's shared folders, with presets and a grid of ten permissions, enforced by the server and the apps.
- **Entra ID provisioning** over SCIM 2.0 (DESIGN.md, "Provisioning from Entra ID"). Checking it with a real tenant waits on a Microsoft 365 tenant.
- **Phone app polish**: settings layout, offering fingerprint or Face ID unlock after sign-in, and a Mac window large enough for its sidebar.
- **The apps' logo and icons**, and Windows and Linux windows that remember their size and place.
- **Hands-on test checklist** for the owner: docs/hands-on-testing.md.
- **Extension redesign** from the approved mockups: jewel-tone categories, site icons, the "Where's your vault?" sign-in, and an item view with big copy buttons.

## In progress

- **Desktop and phone parity with the web vault**: folders and their permissions, templates, site icons, item history, password health, and a Generator tab on phones. Security review fixes in progress.
- **Web vault redesign** from the approved mockups: the menu as a card with jewel tiles, rows of site icons and tiles, the selected item in a side panel beside the list, and graphite glass, a neutral dark mode, for the web vault and the extension. Pull requests open.
- **Exposed passwords in the MSP health view**, using the k-anonymity range check, with an off switch for the check after unlocking. Security review fixes in progress.
- **Events to security tools**: a signed webhook, syslog over TLS (JSON or CEF), and Microsoft Sentinel, per organization or one feed for an MSP. Security review fixes in progress.
- **Sign in with Entra (SSO) per organization**: built and tested against a stand-in for Entra (DESIGN.md, "Sign in with Microsoft Entra ID"; setup in docs/sso-entra.md): each client's own tenant, domain verification, Require single sign-on, the master password still unlocking. Its client secret is sealed with event streaming's module under a key of its own; a verification review next. Trusted-device unlock after, as its own design with test vectors.

## Next

1. **Self-updating Windows and Linux apps**, like the Mac and Android ones.
2. **Item history and the new folders in the extension**, so every app shows and restores the same versions.
3. **Approving a new sign-in from our apps**, and a CLI build for macOS and Linux scripts.
4. **A full security pass over the whole stack** before the first company: server, web vault, extension, apps, CI and releases.
5. **Website redesign** in the new look.

## Waiting on you

- **Production hosting**: a storage bucket for backups at a second provider (Backblaze or Cloudflare R2), a backup key made on your own computer (ops/hosting/README.md, "The backup key"), and the go-ahead to point vault.passbundle.com at the hosted stack.
- **Email**: a sending provider (Postmark, Amazon SES, or Resend) so invitations, verification and account recovery mail go out.
- **A Microsoft 365 tenant** (a free developer tenant is enough) to check Entra provisioning (built; the checks are in DESIGN.md, "Provisioning from Entra ID", "Status") and single sign-on (built; the checks are in docs/sso-entra.md, "Checking it with a real tenant") for real.
- **Apple Developer account** for the iPhone app, iPhone AutoFill, and a notarized Mac app.
- **Store listings** when you want them (you said not yet): Chrome, Edge, Firefox.
- **Business details for the site and legal pages**: legal name, payment processor, refunds, governing law, prices (marked as placeholders in site/).
- **A paid Have I Been Pwned key** for the report of breached accounts at a client's email domain.
- **MSP billing**: Stripe and the pricing model.
