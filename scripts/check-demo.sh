#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
node --import ./upstream/snarkjs-algorand/node_modules/tsx/dist/loader.mjs scripts/check-demo.mjs
