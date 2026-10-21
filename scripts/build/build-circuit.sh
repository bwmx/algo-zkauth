#!/usr/bin/env bash
# Writes a provider's JWT circuit from its profile, compiles it into the
# provider's fixtures directory and runs its witness tests.
# Usage: build-circuit.sh <provider> (npm run build:circuit -- <provider>)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROVIDER="${1:?Usage: build-circuit.sh <provider>}"
JWT="$ROOT/upstream/zk-jwt"
REVISION="3a50a9bb80020a5bf7964881dcf70286e22037ab"
# Every provider's circuit shares the pinned zk-jwt checkout and primitives.
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
field() { node "$ROOT/scripts/providers.mjs" field "$PROVIDER" "$1"; }
DIR="$(field circuit.directory)"
NAME="$(field circuit.name)"
LOCAL="$(field local)"
mkdir -p "$ROOT/$DIR"
node "$ROOT/scripts/build/write-jwt-circuit.mjs" "$PROVIDER"
"$ROOT/tools/circom-v2.2.3-macos-amd64" "$ROOT/circuits/$NAME.circom" --r1cs --wasm --sym --prime bn128 -l "$JWT/node_modules" -o "$ROOT/$DIR"
node --max-old-space-size=6000 --test "$ROOT/tests/circuits/$PROVIDER-circuit-witness.test.mjs"
node --max-old-space-size=6000 "$ROOT/upstream/snarkjs-algorand/node_modules/snarkjs/cli.js" wtns check "$ROOT/$DIR/$NAME.r1cs" "$ROOT/$LOCAL/synthetic.wtns"
