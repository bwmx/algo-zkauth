#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM="$ROOT/upstream/snarkjs-algorand"
OUT="$ROOT/fixtures/phase1"
CIRCOM="$ROOT/tools/circom-v2.2.3-macos-amd64"

if [[ ! -x "$CIRCOM" ]]; then
  echo "Missing Circom compiler: $CIRCOM" >&2
  exit 1
fi
if [[ ! -d "$UPSTREAM/node_modules" ]]; then
  echo "Install pinned dependencies in $UPSTREAM first" >&2
  exit 1
fi

mkdir -p "$OUT"
"$CIRCOM" "$ROOT/circuits/square_chain_2.circom" --r1cs --wasm --sym --prime bn128 -o "$OUT"

cd "$UPSTREAM"
pnpm exec snarkjs groth16 setup "$OUT/square_chain_2.r1cs" "$UPSTREAM/circuit/pot14_bn254_final.ptau" "$OUT/square_chain_2.zkey"
pnpm exec snarkjs zkey contribute "$OUT/square_chain_2.zkey" "$OUT/wrong_setup.zkey" -e='phase1-wrong-key-test-only' -n='Wrong key fixture'
pnpm exec snarkjs zkey export verificationkey "$OUT/square_chain_2.zkey" "$OUT/verification_key.json"
pnpm exec snarkjs groth16 fullprove "$OUT/input.json" "$OUT/square_chain_2_js/square_chain_2.wasm" "$OUT/square_chain_2.zkey" "$OUT/proof.json" "$OUT/public.json"
pnpm exec snarkjs groth16 verify "$OUT/verification_key.json" "$OUT/public.json" "$OUT/proof.json"
