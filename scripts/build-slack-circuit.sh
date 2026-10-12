#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JWT="$ROOT/upstream/zk-jwt"
# Shares the pinned zk-jwt checkout and primitives with the Google circuit.
if [[ ! -d "$JWT/node_modules/@zk-email/circuits" ]]; then
  bash "$ROOT/scripts/build-google-circuit.sh"
fi
mkdir -p "$ROOT/fixtures/slack"
node "$ROOT/scripts/write-slack-circuit.mjs"
"$ROOT/tools/circom-v2.2.3-macos-amd64" "$ROOT/circuits/slack_jwt.circom" --r1cs --wasm --sym --prime bn128 -l "$JWT/node_modules" -o "$ROOT/fixtures/slack"
node --max-old-space-size=6000 --test "$ROOT/tests/slack-circuit-witness.test.mjs"
node --max-old-space-size=6000 "$ROOT/upstream/snarkjs-algorand/node_modules/snarkjs/cli.js" wtns check "$ROOT/fixtures/slack/slack_jwt.r1cs" "$ROOT/.local/slack/synthetic.wtns"
