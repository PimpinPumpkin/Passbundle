# End-to-end tests

Tier 1 runs on every commit (see [DESIGN.md](../DESIGN.md#testing)). The harness starts the server (`passbundle-server`) itself, over HTTPS with a throwaway certificate and an empty data folder, then drives the branded web vault and browser extension with Playwright.

## Run locally

The three repos sit side by side, in folders named `keykeeper`, `keykeeper-clients`, and `keykeeper-server` (or `passbundle-*`). Use Node 24.

```bash
cd ../keykeeper-server && cargo build --features sqlite
```

```bash
cd ../keykeeper-clients && npm ci && node brand/apply.mjs
```

```bash
cd ../keykeeper-clients/apps/web && npm run build:oss:selfhost:prod
```

```bash
cd ../keykeeper-clients/apps/browser && npm run build:prod:chrome
```

```bash
cd ../keykeeper-clients && node brand/apply.mjs --revert
```

```bash
npm ci && npx playwright install chromium && npx playwright test
```

Override any build location with `KK_SERVER_BIN`, `KK_WEB_VAULT`, `KK_EXTENSION`, or `KK_BRAND`, and the port with `KK_PORT` (default 8091).

## Rules

- No retries. A flaky test gets fixed, not rerun.
- No sleeps. Wait on what the page shows.
- No live network beyond the local server.
- Timezone UTC, locale en-US.

## Windows (tier 2)

`installer/windows/tests/Test-Install.ps1` applies the policies on a disposable Windows machine, then `npx playwright test -c playwright.windows.config.ts` checks that real Chrome and Edge report them. CI runs both nightly on `windows-latest`.
