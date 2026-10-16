#!/usr/bin/env bash
# Builds, checks, and deploys passbundle.com to Cloudflare Pages (project
# "passbundle"). Uses the Cloudflare account wrangler is logged in to, or the
# one in CLOUDFLARE_ACCOUNT_ID with CLOUDFLARE_API_TOKEN. See site/README.md.
set -euo pipefail
cd "$(dirname "$0")"
node build.mjs
node check.mjs
npx --yes wrangler@4 pages deploy dist --project-name passbundle --branch main --commit-dirty=true
