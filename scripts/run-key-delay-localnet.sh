#!/usr/bin/env bash
# Checks that delayed key approvals and renewals take effect once the 24-hour
# delay passes, by moving LocalNet's block clock forward. Block time cannot move
# back: reset LocalNet (algokit localnet reset) before running other LocalNet suites.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM="$ROOT/upstream/snarkjs-algorand"
bash "$ROOT/scripts/build-wallets.sh" >/dev/null
cp "$ROOT/tests/google_key_registry_delay.test.ts" "$UPSTREAM/__test__/google_key_registry_delay.test.ts"
cd "$UPSTREAM"
status=0
pnpm exec vitest run __test__/google_key_registry_delay.test.ts --silent || status=$?
echo "LocalNet's block clock is now about 24 hours ahead; run 'algokit localnet reset' before other LocalNet suites." >&2
exit $status
