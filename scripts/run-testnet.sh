#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM="$ROOT/upstream/snarkjs-algorand"
if [[ -z "${TESTNET_MNEMONIC:-}" && ! -f "$ROOT/.env" ]]; then
  echo "Set TESTNET_MNEMONIC in the root .env or shell before running" >&2
  exit 1
fi
cp "$ROOT/tests/poc_testnet.test.ts" "$UPSTREAM/__test__/poc_testnet.test.ts"
cd "$UPSTREAM"
if [[ -f "$ROOT/.env" ]]; then
  node --env-file="$ROOT/.env" node_modules/vitest/vitest.mjs run __test__/poc_testnet.test.ts --silent
else
  pnpm exec vitest run __test__/poc_testnet.test.ts --silent
fi
