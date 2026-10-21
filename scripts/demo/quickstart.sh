#!/bin/sh
# Runs the TestNet demo from a fresh clone: installs the pinned dependencies,
# downloads the proving artifacts, creates a TestNet account if .env has none,
# deploys this clone's own contracts and starts http://localhost:8765/demo/.
# Rerun it at any point; finished steps are skipped.
set -eu
cd "$(dirname "$0")/../.."

step() { printf '\n==> %s\n' "$1"; }
configured() { [ -f .env ] && grep -q "^$1=." .env; }
# This clone's run records stay in .local/ instead of the published benchmarks/.
export DEMO_EVIDENCE_DIR=.local/evidence

step "Checking Node"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || {
  echo "Node 24 or newer is required; found $(node --version)." >&2
  exit 1
}

step "Checking port 8765"
node scripts/demo/demo-port.mjs

step "Installing pinned dependencies"
sh scripts/setup.sh checkout

step "Configuring .env"
if ! configured GOOGLE_CLIENT_ID; then
  id=${GOOGLE_CLIENT_ID:-}
  if [ -z "$id" ] && [ -t 0 ]; then
    cat <<'TEXT'
Sign-in needs a Google OAuth client ID. In Google Cloud Console, create an
OAuth client of type "Web application" whose Authorized JavaScript origins
include http://localhost:8765: https://console.cloud.google.com/apis/credentials
TEXT
    printf 'Google OAuth client ID: '
    read -r id
  fi
  case "$id" in
    *.apps.googleusercontent.com) ;;
    *) echo "Set GOOGLE_CLIENT_ID in .env to a Google OAuth client ID (…apps.googleusercontent.com)." >&2; exit 1 ;;
  esac
  if [ -s .env ] && [ -n "$(tail -c 1 .env)" ]; then echo >> .env; fi
  printf 'GOOGLE_CLIENT_ID=%s\n' "$id" >> .env
fi
node scripts/demo/testnet-account.mjs create
chmod 600 .env

# Google is required; every other provider whose <PREFIX>_CLIENT_ID is in .env
# (Slack: a Slack app and its client secret, see the runbook) is set up too.
providers=$(node --env-file=.env scripts/providers.mjs configured)

step "Downloading proving artifacts"
# shellcheck disable=SC2086
node scripts/artifacts.mjs fetch $providers

step "Deploying this clone's contracts on TestNet"
needed=0
for provider in $providers; do
  record=$(node scripts/providers.mjs field "$provider" deployment)
  # Each new deployment requires 5 spendable test ALGO; an existing one is reused.
  if [ ! -f "$record" ]; then needed=$((needed + 5000000)); fi
done
if [ "$needed" -gt 0 ]; then node scripts/demo/testnet-account.mjs wait "$needed"; fi
# shellcheck disable=SC2086
sh scripts/demo/deploy-demo.sh $providers

step "Starting the demo at http://localhost:8765/demo/"
exec sh scripts/demo/start-demo.sh
