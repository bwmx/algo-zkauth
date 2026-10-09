#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
sh scripts/build-wallets.sh
node --max-old-space-size=6000 scripts/run-recovery-localnet.mjs
