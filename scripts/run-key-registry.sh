#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM="$ROOT/upstream/snarkjs-algorand"
cp "$ROOT/contracts/google_key_registry.algo.ts" "$UPSTREAM/contracts/google_key_registry.algo.ts"
cp "$ROOT/tests/google_key_registry.test.ts" "$UPSTREAM/__test__/google_key_registry.test.ts"
cd "$UPSTREAM"
rm -f contracts/out/GoogleKeyRegistry.*
pnpm exec puya-ts contracts/google_key_registry.algo.ts --out-dir out --target-avm-version 11
test -s contracts/out/GoogleKeyRegistry.arc56.json
algokit generate client contracts/out/GoogleKeyRegistry.arc56.json --output contracts/clients/GoogleKeyRegistry.ts
node "$ROOT/scripts/normalize-google-clients.mjs" GoogleKeyRegistry
pnpm exec vitest run __test__/google_key_registry.test.ts --silent
