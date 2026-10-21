#!/bin/sh
# Sets up the pinned snarkjs-algorand checkout that the demo, the services and
# the LocalNet suites run on: the Groth16 LogicSig verifier, AlgoKit utils,
# snarkjs and tsx, with the committed contract clients installed into it.
#
# Usage: sh scripts/setup.sh [checkout|stage]
#   (none)    both steps
#   checkout  the pinned checkout and its locked dependencies only (Docker images, bootstrap)
#   stage     install the committed contract clients and the disposable policy
#             check into an existing checkout (what the demo scripts run each time)
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM="$ROOT/upstream/snarkjs-algorand"
COMMIT="3a970c7fb47efadd60c0b09a3200e8428ac47df2"
STEP="${1:-all}"
case "$STEP" in
  all | checkout | stage) ;;
  *) echo "Usage: sh scripts/setup.sh [checkout|stage]" >&2; exit 2 ;;
esac

if [ "$STEP" != stage ]; then
  if [ ! -d "$UPSTREAM/.git" ]; then
    mkdir -p "$ROOT/upstream"
    git clone -q https://github.com/joe-p/snarkjs-algorand.git "$UPSTREAM"
    git -C "$UPSTREAM" checkout -q "$COMMIT"
  fi
  # Local commits on top of the pin are allowed; its locked dependencies are not changed.
  if ! git -C "$UPSTREAM" merge-base --is-ancestor "$COMMIT" HEAD || ! git -C "$UPSTREAM" diff --quiet "$COMMIT" HEAD -- package.json pnpm-lock.yaml; then
    echo "upstream/snarkjs-algorand must build on commit $COMMIT with its lockfile unchanged; inspect the checkout before continuing" >&2
    exit 1
  fi
  if command -v pnpm >/dev/null 2>&1; then PNPM=pnpm; else PNPM="npx --yes pnpm@10.33.0"; fi
  (cd "$UPSTREAM" && $PNPM install --frozen-lockfile)
fi

if [ "$STEP" != checkout ]; then
  cd "$ROOT"
  mkdir -p upstream/snarkjs-algorand/src/algozkauth upstream/snarkjs-algorand/contracts/clients
  # The demo's chain code is packages/chain, which runs from the repository and loads
  # the pinned checkout's packages by path (packages/chain/README.md). Only the
  # disposable policy check still runs from a copy here. chain.ts is a stale copy
  # from before packages/chain.
  rm -f upstream/snarkjs-algorand/src/phase6/chain.ts
  cp evidence/policy.ts upstream/snarkjs-algorand/src/algozkauth/policy.ts
  # Compiled contract clients are committed, so the demo needs no contract
  # compiler. scripts/build/build-wallets.sh regenerates them from contracts/*.algo.ts.
  for name in KeyRegistry UserWallet WalletRegistry; do
    cp "contracts/clients/$name.ts" "upstream/snarkjs-algorand/contracts/clients/$name.ts"
  done
fi
