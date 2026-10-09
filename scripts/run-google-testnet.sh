#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
node --env-file="$ROOT/.env" --max-old-space-size=6000 "$ROOT/scripts/prepare-google-witness.mjs"
node --max-old-space-size=6000 "$ROOT/scripts/prove-google-witness.mjs" --google
cp "$ROOT/tests/google_authorization.test.ts" "$ROOT/upstream/snarkjs-algorand/__test__/google_authorization.test.ts"
cd "$ROOT/upstream/snarkjs-algorand"
GOOGLE_PROOF_NETWORK=testnet GOOGLE_PROOF_SOURCE=google node --env-file="$ROOT/.env" node_modules/vitest/vitest.mjs run __test__/google_authorization.test.ts --silent
