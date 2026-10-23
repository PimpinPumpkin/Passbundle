# Before launching to companies

The work queue between now and selling PassBundle to MSPs and their clients. Background jobs take items from the top of "Next"; each lands as a pull request that merges when CI is green, after a security review when it touches permissions, keys, sign-in, or updates. The gap ranking comes from docs/parity.md.

## In progress

- **Extension redesign** from the approved mockups: jewel-tone categories, site icons, the "Where's your vault?" sign-in, the items list with a suggested-for-this-site section, and an item view with big copy buttons.
- **Folders and per-folder permissions**: "vault" becomes "folder" (Personal, then each organization's shared folders), with presets plus a grid of ten permissions. Security review fixes in progress.
- **Phone app polish**: settings layout, offering fingerprint or Face ID unlock after sign-in, the shared design pieces (category tiles, site icons, depth) for phone and desktop, and the desktop window opening large enough to show its sidebar.

## Next

1. **Desktop app parity with the web vault**: three panes (menu, list, item), folders, categories and templates, item history, the same icons. Android gets the same pieces in its phone layout.
2. **Web vault redesign** from the mockups: calm solid ground with depth instead of glass, jewel tiles in the menu and list, site icons, a side panel for the selected item.
3. **Entra ID provisioning**: people added and removed in Microsoft 365 appear and leave in the client's organization. Designed against Microsoft's public Graph and SCIM docs and tested with a stand-in; checking it for real needs a Microsoft 365 tenant (see "Waiting on you").
4. **Sign in with Entra (SSO) per organization**, master password still unlocking at first; trusted-device unlock after, as its own design with test vectors.
5. **Item history and the new folders in the extension and the apps**, so every app shows and restores the same versions.
6. **Events to security tools** (a webhook and syslog feed for Huntress, Blumira, Sentinel and similar).
7. **Exposed passwords in the MSP health view**, using the k-anonymity range check (no passwords leave the browser).
8. **Approving a new sign-in from our apps**, and a CLI build for macOS and Linux scripts.
9. **Self-updating Windows and Linux apps**, like the Mac and Android ones.
10. **A full security pass over the whole stack** before the first company: server, web vault, extension, apps, CI and releases.
11. **Hands-on test checklist** for the owner: every platform, sign-in, autofill on common sites, import, sharing, recovery, offboarding.
12. **Website redesign** in the new look.

## Waiting on you

- **Production hosting**: a storage bucket for backups at a second provider (Backblaze or Cloudflare R2), a backup key made on your own computer (ops/hosting/README.md, "The backup key"), and the go-ahead to point vault.passbundle.com at the hosted stack.
- **Email**: a sending provider (Postmark, Amazon SES, or Resend) so invitations, verification and account recovery mail go out.
- **A Microsoft 365 tenant** (a free developer tenant is enough) to check Entra provisioning and SSO for real.
- **Apple Developer account** for the iPhone app, iPhone AutoFill, and a notarized Mac app.
- **Store listings** when you want them (you said not yet): Chrome, Edge, Firefox.
- **Business details for the site and legal pages**: legal name, payment processor, refunds, governing law, prices (marked as placeholders in site/).
- **MSP billing**: Stripe and the pricing model.
