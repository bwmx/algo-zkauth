#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CIRCOM="$ROOT/tools/circom-v2.2.3-macos-amd64"
CIRCOM_SHA256="e006332b3fe225f11c3b87bd2debbf5d7f568d6efbde25e5a6a12cd6988c8ecb"

# Circom is only needed to build circuits; the demo itself needs only the upstream checkout.
mkdir -p "$ROOT/tools"
if [[ ! -f "$CIRCOM" ]]; then
  curl -fL https://github.com/iden3/circom/releases/download/v2.2.3/circom-macos-amd64 -o "$CIRCOM"
  chmod +x "$CIRCOM"
fi
printf '%s  %s\n' "$CIRCOM_SHA256" "$CIRCOM" | shasum -a 256 -c

sh "$ROOT/scripts/fetch-upstream.sh"
