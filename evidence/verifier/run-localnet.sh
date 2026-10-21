#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
UPSTREAM="$ROOT/upstream/snarkjs-algorand"
bash "$ROOT/evidence/verifier/generate-phase1.sh"
bash "$ROOT/evidence/verifier/generate-benchmark.sh"
cp "$ROOT/tests/localnet/poc_phase1.test.ts" "$UPSTREAM/__test__/poc_phase1.test.ts"
cp "$ROOT/tests/localnet/poc_benchmark.test.ts" "$UPSTREAM/__test__/poc_benchmark.test.ts"
cd "$UPSTREAM"
pnpm exec vitest run __test__/poc_phase1.test.ts --silent
pnpm exec vitest run __test__/poc_benchmark.test.ts --silent
