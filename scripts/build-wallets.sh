#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM="$ROOT/upstream/snarkjs-algorand"
for source in google_key_registry wallet_authorization user_wallet wallet_registry; do
  cp "$ROOT/contracts/$source.algo.ts" "$UPSTREAM/contracts/$source.algo.ts"
done
cd "$UPSTREAM"
rm -f contracts/out/UserWallet.* contracts/out/WalletRegistry.*
pnpm exec puya-ts contracts/wallet_registry.algo.ts contracts/user_wallet.algo.ts contracts/google_key_registry.algo.ts --out-dir out --target-avm-version 11
for name in GoogleKeyRegistry UserWallet WalletRegistry; do
  test -s "contracts/out/$name.arc56.json"
  algokit generate client "contracts/out/$name.arc56.json" --output "contracts/clients/$name.ts"
done
node "$ROOT/scripts/normalize-google-clients.mjs" GoogleKeyRegistry UserWallet WalletRegistry
