#!/bin/sh
# Key-registry guardian status and veto actions; see scripts/demo/key-guardian.mjs.
set -eu
cd "$(dirname "$0")/../.."
sh scripts/setup.sh stage
node --env-file-if-exists=.env --import ./upstream/snarkjs-algorand/node_modules/tsx/dist/loader.mjs scripts/demo/key-guardian.mjs "$@"
