// Where the harness finds the builds. Defaults assume the three repos are
// checked out side by side; CI overrides them with environment variables.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sibling = (...p) => path.resolve(here, "../..", ...p);
// A sibling repo, under its PassBundle folder name or the code name.
const repo = (name, ...p) =>
  fs.existsSync(sibling(`passbundle-${name}`))
    ? sibling(`passbundle-${name}`, ...p)
    : sibling(`keykeeper-${name}`, ...p);

export const port = process.env.KK_PORT ?? "8091";
export const fixturePort = process.env.KK_FIXTURE_PORT ?? "8093";
// A second test server that sends email, to the mail catcher.
export const mailServerPort = process.env.KK_MAIL_SERVER_PORT ?? "8094";
export const smtpPort = process.env.KK_SMTP_PORT ?? "2525";
export const mailHttpPort = process.env.KK_MAIL_HTTP_PORT ?? "8096";
export const paths = {
  serverBin:
    process.env.KK_SERVER_BIN ??
    repo("server", "target/debug/vaultwarden"),
  webVault:
    process.env.KK_WEB_VAULT ?? repo("clients", "apps/web/build"),
  extension:
    process.env.KK_EXTENSION ?? repo("clients", "apps/browser/build"),
  brand: process.env.KK_BRAND ?? repo("clients", "brand/brand.json"),
};
export const brand = JSON.parse(fs.readFileSync(paths.brand, "utf8"));

// Chromium flag: *.example.test goes to the local fixture server, and every
// other hostname except the test server fails to resolve. No live network.
export const hostResolverRules = `--host-resolver-rules=MAP *.example.test 127.0.0.1:${fixturePort}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`;
