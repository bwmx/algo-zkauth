#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
sh scripts/prepare-demo.sh
node --env-file=.env --import ./upstream/snarkjs-algorand/node_modules/tsx/dist/loader.mjs scripts/phase6-server.mjs
