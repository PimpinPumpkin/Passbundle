# Agent instructions

These rules apply to every coding agent working on Keykeeper: in this repo, in `keykeeper-clients`, and in `keykeeper-server`.

## Read first

- [DESIGN.md](DESIGN.md): product decisions.
- [CLEAN_ROOM.md](CLEAN_ROOM.md): what you may and may not read. Binding.

## Hard rules

1. Never open, search, or grep any `bitwarden_license/` directory, or any file whose header names the Bitwarden License or the Bitwarden SDK License. Exclude them from every search, for example `rg --glob '!**/bitwarden_license/**'`.
2. No AI attribution anywhere: no co-author trailers and no "generated with" lines in commits, PRs, release notes, or code comments.
3. Write in US English with no em dashes. Commit subjects are used verbatim as release notes, so write them for users.
4. Encryption, key handling, KDF, and auth code: don't change behavior without a design note in DESIGN.md and a test vector. Prefer leaving upstream code untouched.
5. Never weaken or delete a test to make it pass. A red test is information.
6. Before merging upstream changes, read the diff. Passing tests are not enough.
7. Never put "Bitwarden" in product UI, names, IDs, or domains. Attribution ("based on the open-source Bitwarden clients") is allowed where the Bitwarden trademark guidelines permit it.
8. In the fork repos, run `gh repo set-default` to the PimpinPumpkin fork so PRs never target upstream.

## Layout

All three repos are checked out side by side:

- `~/Documents/keykeeper`: this repo (design, test rig, installer, infrastructure).
- `~/Documents/keykeeper-clients`: fork of `bitwarden/clients`.
- `~/Documents/keykeeper-server`: fork of `dani-garcia/vaultwarden`.

## Branding

Branding is applied at build time from one config (name, colors, icons, URLs), so changing the final product name is a one-file change. Don't hand-edit upstream strings to rebrand. Real feature changes to upstream files are fine.

## Testing

Follow the tiers and determinism rules in [DESIGN.md](DESIGN.md#testing).

- Every change lands with tier 1 tests.
- Anything that touches installs, browsers, or onboarding also gets a tier 2 scenario.

## Product invariants

Each of these must have a test that fails if it breaks:

- Never offer to save or update a password with a one-time code.
- Never fill a field the user marked "never fill".
- Never import from a browser profile the user or admin did not choose.
- The server never receives a key that can decrypt a vault.
- The installer can force-install only Keykeeper's own extension IDs.
- Local state that can't be decrypted (for example after a Windows profile migration) leads to a clean sign-in, never a broken client.
