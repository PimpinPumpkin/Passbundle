// Where the harness finds the builds. Defaults assume the three repos are
// checked out side by side; CI overrides them with environment variables.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sibling = (...p) => path.resolve(here, "../..", ...p);

export const port = process.env.KK_PORT ?? "8091";
export const paths = {
  serverBin: process.env.KK_SERVER_BIN ?? sibling("keykeeper-server/target/debug/vaultwarden"),
  webVault: process.env.KK_WEB_VAULT ?? sibling("keykeeper-clients/apps/web/build"),
  extension: process.env.KK_EXTENSION ?? sibling("keykeeper-clients/apps/browser/build"),
  brand: process.env.KK_BRAND ?? sibling("keykeeper-clients/brand/brand.json"),
};
export const brand = JSON.parse(fs.readFileSync(paths.brand, "utf8"));
