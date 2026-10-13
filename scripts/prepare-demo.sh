#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p upstream/snarkjs-algorand/src/phase4 upstream/snarkjs-algorand/src/phase6 upstream/snarkjs-algorand/contracts/clients
cp src/phase4/action.mjs upstream/snarkjs-algorand/src/phase4/action.mjs
cp src/phase6/chain.ts upstream/snarkjs-algorand/src/phase6/chain.ts
cp src/phase6/policy.ts upstream/snarkjs-algorand/src/phase6/policy.ts
# Compiled contract clients are committed, so the demo needs no contract
# compiler. scripts/build-wallets.sh regenerates them from contracts/*.algo.ts.
for name in GoogleKeyRegistry UserWallet WalletRegistry; do
  cp "contracts/clients/$name.ts" "upstream/snarkjs-algorand/contracts/clients/$name.ts"
done
