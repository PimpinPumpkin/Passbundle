#!/usr/bin/env bash
# Builds upstream's Chrome extension (bitwarden/clients, apps/browser) in its
# open-source configuration, for the autofill scoreboard: the corpus is filled
# with it as well as with ours (tests/autofill-corpus.spec.ts, DESIGN.md "How
# it keeps getting better").
#
#   e2e/upstream-extension.sh <upstream checkout> <output folder>
#
# The checkout is upstream's release tag our clients are based on
# (passbundle-clients' .keykeeper-base), made without bitwarden_license/
# (CLEAN_ROOM.md): this script refuses one that has it. The commercial SDK is
# taken out of the package files before installing, so it's never downloaded,
# and install scripts don't run (nothing but the lockfile's packages comes
# down). No branding: it's upstream's extension as upstream builds it.
set -euo pipefail

src=${1:?upstream checkout}
out=${2:?output folder}
cd "$src"

if [ -e bitwarden_license ]; then
  echo "upstream-extension: $src has bitwarden_license/; check it out without it" >&2
  exit 1
fi

node - <<'EOF'
const fs = require("node:fs");
const name = "@bitwarden/commercial-sdk-internal";
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
delete pkg.dependencies?.[name];
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
delete lock.packages[""].dependencies?.[name];
for (const key of Object.keys(lock.packages)) {
  if (key === `node_modules/${name}` || key.startsWith(`node_modules/${name}/`)) {
    delete lock.packages[key];
  }
}
fs.writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
EOF

HUSKY=0 npm ci --ignore-scripts --no-audit --no-fund
(cd apps/browser && npm run build:prod:chrome)

rm -rf "$out"
mkdir -p "$(dirname "$out")"
cp -R apps/browser/build "$out"
find "$out" -name '*.map' -delete
