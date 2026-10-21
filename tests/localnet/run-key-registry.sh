#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
UPSTREAM="$ROOT/upstream/snarkjs-algorand"
cp "$ROOT/contracts/key_registry.algo.ts" "$UPSTREAM/contracts/key_registry.algo.ts"
cp "$ROOT/tests/localnet/key_registry.test.ts" "$UPSTREAM/__test__/key_registry.test.ts"
cd "$UPSTREAM"
rm -f contracts/out/KeyRegistry.*
pnpm exec puya-ts contracts/key_registry.algo.ts --out-dir out --target-avm-version 11
test -s contracts/out/KeyRegistry.arc56.json
algokit generate client contracts/out/KeyRegistry.arc56.json --output contracts/clients/KeyRegistry.ts
node "$ROOT/scripts/build/normalize-clients.mjs" KeyRegistry
pnpm exec vitest run __test__/key_registry.test.ts --silent
