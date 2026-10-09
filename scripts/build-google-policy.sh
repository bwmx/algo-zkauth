#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM="$ROOT/upstream/snarkjs-algorand"
cp "$ROOT/contracts/google_key_registry.algo.ts" "$UPSTREAM/contracts/google_key_registry.algo.ts"
cp "$ROOT/contracts/google_jwt_authorization.algo.ts" "$UPSTREAM/contracts/google_jwt_authorization.algo.ts"
cd "$UPSTREAM"
rm -f contracts/out/GoogleKeyRegistry.* contracts/out/GoogleJwtAuthorization.*
pnpm exec puya-ts contracts/google_jwt_authorization.algo.ts contracts/google_key_registry.algo.ts --out-dir out --target-avm-version 11
test -s contracts/out/GoogleKeyRegistry.arc56.json
test -s contracts/out/GoogleJwtAuthorization.arc56.json
algokit generate client contracts/out/GoogleKeyRegistry.arc56.json --output contracts/clients/GoogleKeyRegistry.ts
algokit generate client contracts/out/GoogleJwtAuthorization.arc56.json --output contracts/clients/GoogleJwtAuthorization.ts
node "$ROOT/scripts/normalize-google-clients.mjs"
