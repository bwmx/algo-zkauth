#!/bin/sh
# Fast protocol and interface checks: no circuits, LocalNet or TestNet needed.
# Requires the upstream checkout (scripts/fetch-upstream.sh) for algosdk.
set -eu
cd "$(dirname "$0")/.."
node --test tests/identity-commitment.test.mjs tests/session-nonce.test.mjs tests/browser-session-nonce.test.mjs tests/google-id-token.test.mjs tests/slack-id-token.test.mjs tests/slack-login.test.mjs tests/slack-relay.test.mjs tests/wallet-action.test.mjs tests/browser-prover.test.mjs tests/recovery.test.mjs tests/passkey-prf.test.mjs tests/recovery-page.test.mjs tests/demo-action.test.mjs tests/demo-sessions.test.mjs tests/demo-receipts.test.mjs
