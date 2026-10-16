# Clean-room rules

PassBundle ships only code we are allowed to ship under the GPL and AGPL. Some upstream code is source-available but not open source, and some competitors forbid using their service to build a competing product. These rules keep us clear of both.

## Never read or copy

- Any directory named `bitwarden_license` in any Bitwarden repository. In `bitwarden/clients` and `bitwarden/server` it holds code under the Bitwarden License (SSO, SCIM, Providers, the admin console UI for those, and more). In `bitwarden/sdk-internal` it holds crates under the Bitwarden SDK License only.
- Any other file whose header names the Bitwarden License or the Bitwarden SDK License.
- Code from any closed-source password manager.

Do not open these files to "just check how they did it". If you already have, do not work on the matching PassBundle feature.

## Do not use competitor services for research

- 1Password's business terms forbid accessing the service "to build a competitive product or service" and copying its "features, functions or graphics". Do not use a 1Password Business account or trial to study features for PassBundle.
- Do not run a Bitwarden enterprise trial for research either. Their terms are vaguer, but there is no need.

## What we may use

- Public documentation, help centers, and admin guides.
- What you already know from administering these products in your normal job.
- Code under a compatible license, credited properly: the GPL parts of Bitwarden, Vaultwarden (AGPL-3.0), Chromium (BSD-3-Clause), Firefox (MPL-2.0), and `apple/password-manager-resources` (MIT).

## Builds

Build the Bitwarden clients and SDK in their open-source configuration only. `sdk-internal` checks at compile time that no commercial crate ends up in an open-source build. Keep that check on.

## Test fixtures

Autofill fixtures are reduced reproductions of real login patterns. Never commit a wholesale copy of a third-party site.
