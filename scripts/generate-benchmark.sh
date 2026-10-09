#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM="$ROOT/upstream/snarkjs-algorand"
CIRCOM="$ROOT/tools/circom-v2.2.3-macos-amd64"

node "$ROOT/scripts/write-benchmark-circuits.mjs"
cd "$UPSTREAM"
for count in 1 7; do
  OUT="$ROOT/fixtures/benchmark/$count"
  "$CIRCOM" "$OUT/bench_$count.circom" --r1cs --wasm --sym --prime bn128 -o "$OUT"
  pnpm exec snarkjs groth16 setup "$OUT/bench_$count.r1cs" "$UPSTREAM/circuit/pot14_bn254_final.ptau" "$OUT/bench_$count.zkey"
  pnpm exec snarkjs zkey export verificationkey "$OUT/bench_$count.zkey" "$OUT/verification_key.json"
  pnpm exec snarkjs groth16 fullprove "$OUT/input.json" "$OUT/bench_${count}_js/bench_$count.wasm" "$OUT/bench_$count.zkey" "$OUT/proof.json" "$OUT/public.json"
  pnpm exec snarkjs groth16 verify "$OUT/verification_key.json" "$OUT/public.json" "$OUT/proof.json"
done
