#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM="$ROOT/upstream/snarkjs-algorand"
for source in key_registry wallet_authorization user_wallet wallet_registry; do
  cp "$ROOT/contracts/$source.algo.ts" "$UPSTREAM/contracts/$source.algo.ts"
done
cd "$UPSTREAM"
rm -f contracts/out/KeyRegistry.* contracts/out/UserWallet.* contracts/out/WalletRegistry.*
pnpm exec puya-ts contracts/wallet_registry.algo.ts contracts/user_wallet.algo.ts contracts/key_registry.algo.ts --out-dir out --target-avm-version 11
for name in KeyRegistry UserWallet WalletRegistry; do
  test -s "contracts/out/$name.arc56.json"
  algokit generate client "contracts/out/$name.arc56.json" --output "contracts/clients/$name.ts"
done
node "$ROOT/scripts/normalize-clients.mjs" KeyRegistry UserWallet WalletRegistry
# Keep the committed clients, which the demo deploys from, in step with the sources.
for name in KeyRegistry UserWallet WalletRegistry; do
  cp "contracts/clients/$name.ts" "$ROOT/contracts/clients/$name.ts"
done
