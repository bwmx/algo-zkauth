#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM="$ROOT/upstream/snarkjs-algorand"
COMMIT="3a970c7fb47efadd60c0b09a3200e8428ac47df2"
CIRCOM="$ROOT/tools/circom-v2.2.3-macos-amd64"
CIRCOM_SHA256="e006332b3fe225f11c3b87bd2debbf5d7f568d6efbde25e5a6a12cd6988c8ecb"

if [[ ! -d "$UPSTREAM/.git" ]]; then
  mkdir -p "$ROOT/upstream"
  git clone https://github.com/joe-p/snarkjs-algorand.git "$UPSTREAM"
  git -C "$UPSTREAM" checkout "$COMMIT"
fi
if [[ "$(git -C "$UPSTREAM" rev-parse HEAD)" != "$COMMIT" ]]; then
  echo "Expected upstream commit $COMMIT; inspect the existing checkout before continuing" >&2
  exit 1
fi

mkdir -p "$ROOT/tools"
if [[ ! -f "$CIRCOM" ]]; then
  curl -fL https://github.com/iden3/circom/releases/download/v2.2.3/circom-macos-amd64 -o "$CIRCOM"
  chmod +x "$CIRCOM"
fi
printf '%s  %s\n' "$CIRCOM_SHA256" "$CIRCOM" | shasum -a 256 -c

cd "$UPSTREAM"
pnpm install --frozen-lockfile
