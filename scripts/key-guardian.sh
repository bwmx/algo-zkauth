#!/bin/sh
# Key-registry guardian status and veto actions; see scripts/key-guardian.mjs.
set -eu
cd "$(dirname "$0")/.."
sh scripts/prepare-demo.sh
node --env-file-if-exists=.env --import ./upstream/snarkjs-algorand/node_modules/tsx/dist/loader.mjs scripts/key-guardian.mjs "$@"
