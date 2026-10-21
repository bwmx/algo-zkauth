#!/usr/bin/env bash
# Builds the Phase 3 proof-policy gate and the key registry it calls.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
UPSTREAM="$ROOT/upstream/snarkjs-algorand"
cp "$ROOT/contracts/key_registry.algo.ts" "$UPSTREAM/contracts/key_registry.algo.ts"
cp "$ROOT/contracts/jwt_authorization.algo.ts" "$UPSTREAM/contracts/jwt_authorization.algo.ts"
cd "$UPSTREAM"
rm -f contracts/out/KeyRegistry.* contracts/out/JwtAuthorization.*
pnpm exec puya-ts contracts/jwt_authorization.algo.ts contracts/key_registry.algo.ts --out-dir out --target-avm-version 11
test -s contracts/out/KeyRegistry.arc56.json
test -s contracts/out/JwtAuthorization.arc56.json
algokit generate client contracts/out/KeyRegistry.arc56.json --output contracts/clients/KeyRegistry.ts
algokit generate client contracts/out/JwtAuthorization.arc56.json --output contracts/clients/JwtAuthorization.ts
node "$ROOT/scripts/build/normalize-clients.mjs" KeyRegistry JwtAuthorization
