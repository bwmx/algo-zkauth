#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM="$ROOT/upstream/snarkjs-algorand"
bash "$ROOT/scripts/build-wallets.sh"
node --max-old-space-size=6000 "$ROOT/scripts/prepare-slack-wallet-proofs.mjs"
cp "$ROOT/tests/slack_wallets.test.ts" "$UPSTREAM/__test__/slack_wallets.test.ts"
mkdir -p "$UPSTREAM/src/phase4"
cp "$ROOT/src/phase4/action.mjs" "$UPSTREAM/src/phase4/action.mjs"
cd "$UPSTREAM"
pnpm exec vitest run __test__/slack_wallets.test.ts
