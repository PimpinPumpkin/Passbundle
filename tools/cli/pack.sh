#!/usr/bin/env bash
# Builds PassBundle's command-line tool from a passbundle-clients checkout and
# packs it as one program, with Node.js inside it, the way upstream packs its
# open-source build (pkg); see docs/cli.md. Tier 1 and the release workflow
# (cli-release.yml) both build with it.
#
#   tools/cli/pack.sh <clients checkout> <version> <platform> <output folder>
#
# The checkout has its dependencies installed (npm ci) and no branding
# applied; this applies it with the tool's version, builds, packs, and puts
# the branding back. <platform> is one of linux-x64, linux-arm64, macos-x64,
# macos-arm64, and win-x64, for a program that runs there (pkg makes it on a
# computer of that kind). Run `npm ci --ignore-scripts` in tools/cli first.
set -euo pipefail

if [ $# -ne 4 ]; then
  echo "usage: $0 <clients checkout> <version> <platform> <output folder>" >&2
  exit 2
fi
clients=$(cd "$1" && pwd)
version=$2
platform=$3
mkdir -p "$4"
out=$(cd "$4" && pwd)
here=$(cd "$(dirname "$0")" && pwd)

case "$platform" in
  linux-x64 | linux-arm64 | macos-x64 | macos-arm64) program=passbundle ;;
  win-x64) program=passbundle.exe ;;
  *)
    echo "unknown platform $platform" >&2
    exit 2
    ;;
esac
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  echo "version $version isn't one such as 0.1.2" >&2
  exit 2
fi
command=$(node -p 'require(process.argv[1]).cli.command' "$clients/brand/brand.json")
if [ "$command.exe" != "$program" ] && [ "$command" != "$program" ]; then
  echo "brand.json's command is $command; update this script's program name" >&2
  exit 1
fi

cleanup() { (cd "$clients" && node brand/apply.mjs --revert > /dev/null); }
trap cleanup EXIT
(cd "$clients" && BRAND_CLI_VERSION="$version" node brand/apply.mjs)
(cd "$clients/apps/cli" && npm run build:oss:prod)
# Deprecation warnings would go to every script's stderr; pkg bakes the flag in.
"$here/node_modules/.bin/pkg" "$clients/apps/cli" \
  --targets "node24-$platform" \
  --options no-deprecation \
  --output "$out/$program"

# What it says about itself: the version, and no upstream name in its help.
# Its data folder is a throwaway one here.
prefix=$(node -p 'require(process.argv[1]).cli.envPrefix' "$clients/brand/brand.json")
data=$(mktemp -d)
export "${prefix}APPDATA_DIR=$data"
reported=$("$out/$program" --version)
if [ "$reported" != "$version" ]; then
  echo "the program says it's $reported, not $version" >&2
  exit 1
fi
if "$out/$program" --help | grep -i -E 'bitwarden|\bbw\b'; then
  echo "the program's help names upstream" >&2
  exit 1
fi
rm -rf "$data"
echo "packed $out/$program ($version, $platform)"
