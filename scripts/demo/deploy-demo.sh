#!/bin/sh
# Deploys from the committed contract clients; run scripts/build/build-wallets.sh
# first after changing contracts/*.algo.ts.
set -eu
cd "$(dirname "$0")/../.."
sh scripts/setup.sh stage
node --env-file=.env --import ./upstream/snarkjs-algorand/node_modules/tsx/dist/loader.mjs scripts/demo/deploy-demo.mjs "$@"
