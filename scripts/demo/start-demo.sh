#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
node scripts/demo/demo-port.mjs
sh scripts/setup.sh stage
sh scripts/demo/build-demo-app.sh
node --env-file=.env --import ./upstream/snarkjs-algorand/node_modules/tsx/dist/loader.mjs scripts/demo/phase6-server.mjs
