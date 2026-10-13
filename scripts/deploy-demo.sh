#!/bin/sh
# Deploys from the committed contract clients; run scripts/build-wallets.sh
# first after changing contracts/*.algo.ts.
set -eu
cd "$(dirname "$0")/.."
sh scripts/prepare-demo.sh
node --env-file=.env --import ./upstream/snarkjs-algorand/node_modules/tsx/dist/loader.mjs scripts/deploy-demo.mjs "$@"
