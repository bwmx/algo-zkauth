# keysync

Keeps each provider's key registry in step with the provider's published signing keys, and watches it the way the guardian does. It holds the **administrator** key (`ZKAUTH_ADMIN_MNEMONIC`) and nothing else; the guardian's mnemonic never belongs on this host. Contract: [docs/service-architecture.md](../../docs/service-architecture.md) ("keysync").

At start and every `KEYSYNC_INTERVAL_SECONDS`, for each provider deployment record under `$ZKAUTH_STATE_DIR/deployments/<network>/providers/` (new records are picked up on the next cycle):

1. Fetch the provider's JWKS (the dev issuer's, when `ZKAUTH_DEV_ISSUER_URL` is set on LocalNet).
2. `ensureKeys` with the administrator: register new keys (immediately during the bootstrap, which it then seals; afterwards they take effect after the 24-hour approval delay), renew keys within three days of the end of their approval.
3. **Guardian check.** A key that is or will become valid (including one pending under the delay, or with a pending renewal) but is absent from the JWKS is an alert: one JSON log line (`"level":"alert","event":"guardian_alert"`) per run while it stands, and a `POST` to `KEYSYNC_ALERT_WEBHOOK` when set. The webhook is sent when the set of alerting keys changes and again every `KEYSYNC_ALERT_REPEAT_SECONDS` (default 6 h) while it persists; a cleared alert logs `guardian_alert_cleared`. The check runs even when step 2 failed, but not when the JWKS could not be fetched (every key would look unexpected).

The webhook body is JSON: `{ service, event: "guardian_alert", at, network, provider, keyRegistryId, guardian, alerts: [{ fingerprint, state, validFrom, validUntil, renewedUntil?, renewalEffectiveAt?, inJwks }] }`. Act with `zkauth guardian revoke <fingerprint>` or `zkauth guardian pause`.

## Run

```sh
ZKAUTH_NETWORK=localnet ZKAUTH_ADMIN_MNEMONIC="..." node --import ./upstream/snarkjs-algorand/node_modules/tsx/dist/loader.mjs services/keysync/src/main.ts
npm start -w @algozkauth/keysync        # same, from the repository root
```

Needs the pinned `upstream/` checkout and the installed contract clients (`sh scripts/fetch-upstream.sh && sh scripts/prepare-demo.sh`). It does not need the proving keys: only deploying a provider (`zkauth deploy provider`) reads them.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ZKAUTH_NETWORK`, `ZKAUTH_ALGOD_URL`, `ZKAUTH_ALGOD_TOKEN`, `ZKAUTH_INDEXER_URL`, `ZKAUTH_STATE_DIR`, `ZKAUTH_DEV_ISSUER_URL` | per network | Shared service configuration (packages/config) |
| `ZKAUTH_ADMIN_MNEMONIC` | required | Must be the administrator recorded in the provider deployments; otherwise the run reports `administrator_mismatch` |
| `KEYSYNC_INTERVAL_SECONDS` | `900` | Cycle length (1 to 86400) |
| `KEYSYNC_PORT` | `8782` | Health port (`0` picks a free one) |
| `KEYSYNC_BIND` | `127.0.0.1` | Listen address (`0.0.0.0` in the image) |
| `KEYSYNC_ALERT_WEBHOOK` | unset | http(s) URL for alert `POST`s. May carry a secret, so it is never logged |
| `KEYSYNC_ALERT_REPEAT_SECONDS` | `21600` | Re-send interval for a standing alert |

## Health

`GET /v1/health` (no authentication; internal network only):

```json
{
  "ok": true, "service": "keysync", "network": "localnet", "intervalSeconds": 900, "startedAt": "...",
  "providers": { "google": { "lastRun": { "at": "...", "registered": ["<fingerprint>"], "renewed": [], "sealed": true, "alerts": [], "error": null } } }
}
```

`ok` is false while any provider's last run has an `error`; alerts do not change it (they are reported in `alerts`). `error` is a static code: a chain code (`rejected`, `wrong_network`, `insufficient_funds`, ...), `jwks_unavailable`, `administrator_mismatch` or `unexpected`. Node and SDK error text is never logged or returned.

## Logs

One JSON object per line on stdout: `start`, `sync` (per provider: counts, `sealed`, `alerts`, `error`), `guardian_alert`, `guardian_alert_cleared`, `alert_webhook_failed`, `config`. No mnemonics, tokens or webhook URL. AlgoKit's own per-transaction logging is switched off.

## Docker

```sh
docker build -f services/keysync/Dockerfile -t zkauth-keysync .      # from the repository root
```

`packages/chain` loads algosdk, AlgoKit utils, snarkjs, the Groth16 verifier and the contract clients by path from the pinned `upstream/snarkjs-algorand` checkout ([packages/chain/README.md](../../packages/chain/README.md)), so the image cannot copy just `packages/*` the way the prover's does. Its first stage runs `scripts/fetch-upstream.sh` (pinned commit, frozen lockfile, needs network at build time) and installs the committed `contracts/clients` exactly like `scripts/prepare-demo.sh`; the final image copies the resulting `upstream/` (without `.git`) next to the repository's `packages/`, `services/keysync`, the one `services/dev-issuer/src/override.ts` that packages/config imports, and `contracts/clients`. Every module therefore still resolves one algosdk and one AlgoKit instance. The cost is image size (the checkout's pnpm install); trimming it is deliberately not attempted.

The same image carries `zkauth` (`tools/cli`, `scripts/artifacts.mjs`, the verification keys), so compose's one-shot `init` can use it:

```yaml
init:
  image: zkauth-keysync
  command: ["sh", "-c", "tools/cli/zkauth artifacts fetch && tools/cli/zkauth up --local"]
  volumes: [state:/state, proving-keys:/app/fixtures]
keysync:
  image: zkauth-keysync
  env_file: [...]            # or environment: ZKAUTH_ADMIN_MNEMONIC etc.
  volumes: ["state:/state:ro"]
```

`/state` (`ZKAUTH_STATE_DIR`) is a volume for `secrets.env`, `apps.json` and the deployment records; keysync only reads it, so mount it read-only. `/app/fixtures` takes the proving keys that `zkauth artifacts fetch` downloads (needed by `deploy provider`, not by keysync). Runs as the `node` user; the health check calls `/v1/health`. On LocalNet inside compose set `ZKAUTH_ALGOD_URL`, `ZKAUTH_KMD_URL` and `ZKAUTH_DEV_ISSUER_URL` to the service names. `secrets.env` is written with bare `NAME=value` lines, which `docker run --env-file`, compose `env_file` and `node --env-file` all read the same way.

## Tests

`npm test -w @algozkauth/keysync` (LocalNet on localhost:4001/4002 and the google proving artifacts, because the setup deploys a provider with `zkauth`). Port 9282 is the health port, 9290 the in-process dev issuer; the webhook receiver uses an ephemeral loopback port. The test neither resets LocalNet nor moves its block clock. It covers the first cycle (register and seal), an idle cycle, a pending key missing from the JWKS (alert, one webhook, no repeat, cleared after the guardian revokes it), log hygiene, and an unreachable JWKS.
