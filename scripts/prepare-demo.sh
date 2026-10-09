#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p upstream/snarkjs-algorand/src/phase4 upstream/snarkjs-algorand/src/phase6
cp src/phase4/action.mjs upstream/snarkjs-algorand/src/phase4/action.mjs
cp src/phase6/chain.ts upstream/snarkjs-algorand/src/phase6/chain.ts
cp src/phase6/policy.ts upstream/snarkjs-algorand/src/phase6/policy.ts
