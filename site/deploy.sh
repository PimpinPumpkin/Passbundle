#!/usr/bin/env bash
# Builds, checks, and deploys passbundle.com to Cloudflare Pages (project
# "passbundle"). Until launch it deploys to the preview address,
# https://preview.passbundle.pages.dev, which search engines don't index.
# `--production` deploys the live site, and only once `check.mjs --launch`
# passes. Uses the Cloudflare account wrangler is logged in to, or the one in
# CLOUDFLARE_ACCOUNT_ID with CLOUDFLARE_API_TOKEN. See site/README.md.
set -euo pipefail
cd "$(dirname "$0")"
node build.mjs
if [[ "${1:-}" == "--production" ]]; then
  node check.mjs --launch
  branch=main
else
  node check.mjs
  branch=preview
fi
npx --yes wrangler@4 pages deploy dist --project-name passbundle --branch "$branch" --commit-dirty=true
