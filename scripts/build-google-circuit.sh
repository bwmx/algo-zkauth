#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JWT="$ROOT/upstream/zk-jwt"
REVISION="3a50a9bb80020a5bf7964881dcf70286e22037ab"
if [[ ! -d "$JWT/.git" ]]; then
  git clone --no-checkout https://github.com/zkemail/zk-jwt.git "$JWT"
  git -C "$JWT" checkout --detach "$REVISION"
fi
if [[ "$(git -C "$JWT" rev-parse HEAD)" != "$REVISION" ]]; then
  echo "zk-jwt source does not match the pinned revision" >&2
  exit 1
fi
if [[ ! -d "$JWT/node_modules/@zk-email/circuits" ]]; then
  (cd "$JWT" && node .yarn/releases/yarn-3.2.3.cjs install --immutable)
fi
mkdir -p "$ROOT/fixtures/phase3"
node "$ROOT/scripts/write-google-circuit.mjs"
"$ROOT/tools/circom-v2.2.3-macos-amd64" "$ROOT/circuits/google_jwt.circom" --r1cs --wasm --sym --prime bn128 -l "$JWT/node_modules" -o "$ROOT/fixtures/phase3"
node --max-old-space-size=6000 --test "$ROOT/tests/google-circuit-witness.test.mjs"
node --max-old-space-size=6000 "$ROOT/upstream/snarkjs-algorand/node_modules/snarkjs/cli.js" wtns check "$ROOT/fixtures/phase3/google_jwt.r1cs" "$ROOT/.local/phase3/synthetic.wtns"
