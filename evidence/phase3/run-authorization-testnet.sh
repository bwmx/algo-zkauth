#!/usr/bin/env bash
# Phase 3 gate on TestNet with a genuine Google proof from the captured login
# (evidence/phase3/login-server.mjs).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
node --env-file="$ROOT/.env" --max-old-space-size=6000 "$ROOT/evidence/phase3/prepare-witness.mjs" google
node --max-old-space-size=6000 "$ROOT/evidence/phase3/prove-witness.mjs" google --genuine
cp "$ROOT/tests/localnet/jwt_authorization.test.ts" "$ROOT/upstream/snarkjs-algorand/__test__/jwt_authorization.test.ts"
cd "$ROOT/upstream/snarkjs-algorand"
PROOF_NETWORK=testnet PROOF_SOURCE=genuine node --env-file="$ROOT/.env" node_modules/vitest/vitest.mjs run __test__/jwt_authorization.test.ts --silent
