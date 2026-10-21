#!/bin/sh
# The pinned snarkjs-algorand checkout and its locked dependencies: the Groth16
# LogicSig verifier, AlgoKit utils, snarkjs and tsx that the demo runs on.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM="$ROOT/upstream/snarkjs-algorand"
COMMIT="3a970c7fb47efadd60c0b09a3200e8428ac47df2"
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
cd "$UPSTREAM"
$PNPM install --frozen-lockfile
