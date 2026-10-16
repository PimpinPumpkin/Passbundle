# PassBundle

A password manager for individuals, families, and the managed service providers (MSPs) who run IT for small businesses.

PassBundle is built for MSPs first: one console for every client, with staff and technician access, default policies every client follows, item templates every client gets, onboarding through an RMM install command, custom roles for a client's point of contact, and an audit log. Vaults are end-to-end encrypted, and the server never holds a key that can decrypt one.

It's built on two widely used open-source codebases: the [Bitwarden clients](https://github.com/bitwarden/clients) and [Vaultwarden](https://github.com/dani-garcia/vaultwarden). We follow their releases and their security fixes.

> PassBundle is in development and not ready for production use.

## Repositories

| Repo | Based on | License | What |
|---|---|---|---|
| [Passbundle](https://github.com/PimpinPumpkin/Passbundle) (this one) | | AGPL-3.0 | Design, tests, installer, infrastructure |
| [passbundle-clients](https://github.com/PimpinPumpkin/passbundle-clients) | [bitwarden/clients](https://github.com/bitwarden/clients) | GPL-3.0 | Web vault, browser extension, CLI |
| [passbundle-server](https://github.com/PimpinPumpkin/passbundle-server) | [dani-garcia/vaultwarden](https://github.com/dani-garcia/vaultwarden) | AGPL-3.0 | Server |
| Mobile apps (later) | bitwarden/android, bitwarden/ios | GPL-3.0 | Android and iOS |

Start with [DESIGN.md](DESIGN.md). Before contributing, read [CLEAN_ROOM.md](CLEAN_ROOM.md).

PassBundle isn't affiliated with or endorsed by Bitwarden, Inc. or the Vaultwarden project. Bitwarden is a trademark of Bitwarden, Inc.
