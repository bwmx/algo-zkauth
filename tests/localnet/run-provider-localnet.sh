#!/usr/bin/env bash
# A second provider's wallet on LocalNet with the unchanged contracts, isolated
# from a Google deployment. Usage: run-provider-localnet.sh <provider>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM="$ROOT/upstream/snarkjs-algorand"
PROVIDER="${1:?Usage: run-provider-localnet.sh <provider>}"
bash "$ROOT/scripts/build-wallets.sh"
node --max-old-space-size=6000 "$ROOT/scripts/prepare-provider-wallet-proof.mjs" "$PROVIDER"
cp "$ROOT/tests/provider_wallets.test.ts" "$UPSTREAM/__test__/provider_wallets.test.ts"
mkdir -p "$UPSTREAM/src/phase3" "$UPSTREAM/src/phase4"
cp "$ROOT/packages/protocol/src/oidc-providers.mjs" "$UPSTREAM/src/phase3/oidc-providers.mjs"
cp "$ROOT/packages/protocol/src/action-node.mjs" "$UPSTREAM/src/phase4/action.mjs"
cd "$UPSTREAM"
PROVIDER="$PROVIDER" pnpm exec vitest run __test__/provider_wallets.test.ts
