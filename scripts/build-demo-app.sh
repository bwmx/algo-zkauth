#!/bin/sh
# Builds the React demo (web/app) that the demo server serves at /demo/.
# Dependencies are pinned by web/app/package-lock.json.
set -eu
cd "$(dirname "$0")/../web/app"
[ -e node_modules/.package-lock.json ] || npm ci --no-audit --no-fund
npm run build
