#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p upstream/snarkjs-algorand/src/phase6 upstream/snarkjs-algorand/contracts/clients
# The demo's chain code is packages/chain, which runs from the repository and loads
# the pinned checkout's packages by path (packages/chain/README.md). Only the
# disposable policy check still runs from a copy here.
rm -f upstream/snarkjs-algorand/src/phase6/chain.ts
cp src/phase6/policy.ts upstream/snarkjs-algorand/src/phase6/policy.ts
# Compiled contract clients are committed, so the demo needs no contract
# compiler. scripts/build-wallets.sh regenerates them from contracts/*.algo.ts.
for name in KeyRegistry UserWallet WalletRegistry; do
  cp "contracts/clients/$name.ts" "upstream/snarkjs-algorand/contracts/clients/$name.ts"
done
