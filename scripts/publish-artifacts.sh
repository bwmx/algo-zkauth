#!/bin/sh
# Maintainer only: publishes the local proving artifacts pinned in
# fixtures/artifacts.json as the GitHub release that the quickstart downloads.
# Each file is checked against its pinned size and SHA-256 before upload.
set -eu
cd "$(dirname "$0")/.."
tag=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("fixtures/artifacts.json", "utf8")).release)')
stage=".local/release/$tag"
node scripts/artifacts.mjs stage "$stage"
gh release create "$tag" "$stage"/* --title "Proving artifacts ($tag)" --notes "Groth16 proving keys and witness generators for each provider's JWT circuit, pinned by size and SHA-256 in fixtures/artifacts.json; scripts/artifacts.mjs (zkauth artifacts fetch) downloads and verifies them. These come from a development setup with one local contribution, not a production ceremony: whoever ran the setup could forge proofs for deployments that use them. TestNet use only."
