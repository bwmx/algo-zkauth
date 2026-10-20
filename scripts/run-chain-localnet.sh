#!/bin/sh
# packages/chain on LocalNet: shared provider deployment, two apps, key
# registration and a synthetic identity's enrollment and transfer. Does not move
# the block clock and writes no benchmarks.
set -eu
cd "$(dirname "$0")/.."
sh scripts/prepare-demo.sh
node --max-old-space-size=6000 --import ./upstream/snarkjs-algorand/node_modules/tsx/dist/loader.mjs packages/chain/test/chain.localnet.test.ts
