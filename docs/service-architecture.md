# Service architecture

This is the contract the service milestones build to. The plan and its milestones are summarised in [PLAN.md](../PLAN.md); this file fixes names, ports, configuration and internal APIs so the parts can be built in parallel. The public HTTP API is [services/api/openapi.yaml](../services/api/openapi.yaml); the TypeScript surfaces are [packages/protocol](../packages/protocol/src), [packages/chain/src/types.ts](../packages/chain/src/types.ts) and [packages/sdk/src/types.ts](../packages/sdk/src/types.ts).

## Components

| Component | Path | Role | Holds |
| --- | --- | --- | --- |
| protocol | `packages/protocol` | Nonce, identity commitment, action digest, recovery package, providers, token checks, circuit input | nothing |
| config | `packages/config` | Env defaults per network, role signers (with the legacy `TESTNET_MNEMONIC` fallback), dev-issuer provider override, `apps.json`, deployment records | nothing |
| chain | `packages/chain` | Deploy, key registry, discovery, action groups | nothing; signers passed in |
| sdk | `packages/sdk` | Browser client for dApps | session key (nonextractable), salt in memory |
| api | `services/api` | `/v1` REST: sessions, token checks, code exchange, salt binding, proofs, actions, sponsorship, quotas | sponsor key; tokens and salts in memory for at most a session |
| prover | `services/prover` | Groth16 proofs (rapidsnark, snarkjs fallback); internal only | proving keys; private inputs only while a job runs |
| keysync | `services/keysync` | JWKS → key registry, renewals, bootstrap seal, guardian watch | administrator key |
| dev-issuer | `services/dev-issuer` | LocalNet-only OpenID issuer emulating a provider | dev RSA key |
| cli | `tools/cli` (`zkauth`) | init, deploy, apps, keys, guardian, check, artifacts | whatever the command needs, from env |
| demo / wallet / example | `apps/*`, `examples/*` | Reference integrations (milestones 3 and 6) | — |

One key registry and verifier LogicSig per **provider per network**, shared by all apps. One `WalletRegistry` per **app** (audience). The hosted shared wallet is an app whose `shared` flag is set.

## Ports

All overridable by env (`<COMPONENT>_PORT`). Agents and parallel test runs use an offset (`+100`, `+200`, …) for every port.

| Component | Port | Exposure |
| --- | --- | --- |
| demo app | 8765 | host loopback (matches the existing OAuth origin) |
| wallet app | 8770 | host loopback |
| example dApp | 8775 | host loopback |
| api | 8780 | host loopback |
| prover | 8781 | internal network only |
| keysync health | 8782 | internal |
| dev-issuer | 8790 | host loopback (the browser visits its sign-in page) |
| algod / kmd (compose `local`) | 4101 / 4102 on the host | avoids AlgoKit LocalNet's 4001/4002 |

## Configuration

Environment (secrets never in files the repository tracks):

| Variable | Used by | Meaning |
| --- | --- | --- |
| `ZKAUTH_NETWORK` | all | `localnet` or `testnet` (`mainnet` refused until Phase 7) |
| `ZKAUTH_ALGOD_URL`, `ZKAUTH_ALGOD_TOKEN`, `ZKAUTH_INDEXER_URL` | api, keysync, cli | Node endpoints; defaults per network |
| `ZKAUTH_STATE_DIR` | all | Default `.local/service`; holds deployments and `apps.json` |
| `ZKAUTH_ADMIN_MNEMONIC` | keysync, cli deploy | Key-registry creator; never given to api |
| `ZKAUTH_SPONSOR_MNEMONIC` | api, cli deploy (funding) | Pays enrollment deposits and group fees |
| `ZKAUTH_GUARDIAN_ADDRESS` | cli deploy, keysync | Guardian fixed at key-registry creation |
| `ZKAUTH_GUARDIAN_MNEMONIC` | cli guardian commands only | Kept off service hosts |
| `ZKAUTH_PROVER_URL`, `ZKAUTH_PROVER_TOKEN` | api, prover | Internal prover endpoint and shared bearer secret |
| `ZKAUTH_DEV_ISSUER_URL` | api, keysync, cli | LocalNet only: provider endpoints point at the dev issuer |
| `ZKAUTH_KMD_URL`, `ZKAUTH_KMD_TOKEN` | cli | LocalNet only: the KMD dispenser `zkauth init` funds accounts from (default `http://localhost:4002`) |
| `KEYSYNC_INTERVAL_SECONDS`, `KEYSYNC_ALERT_WEBHOOK`, `KEYSYNC_ALERT_REPEAT_SECONDS`, `KEYSYNC_BIND` | keysync | Cycle period (900), alert webhook, repeat of a standing alert (21600), bind address |
| `<APP_SECRET_ENV>` | api | Per-app OAuth client secrets named in `apps.json` |

`zkauth init` writes the role secrets and a random `ZKAUTH_PROVER_TOKEN` to `$ZKAUTH_STATE_DIR/secrets.env` (mode 0600, unquoted so `docker --env-file` and `node --env-file` read it alike); exported variables override it. On LocalNet it funds the admin, sponsor and guardian from KMD.

Migration: when the role variables are unset on TestNet, `TESTNET_MNEMONIC` fills all three roles and `KEY_GUARDIAN_*` the guardian, with a warning, so existing `.env` files keep working.

`$ZKAUTH_STATE_DIR/apps.json`:

```json
{
  "apps": [
    {
      "id": "demo",
      "provider": "google",
      "clientId": "123.apps.googleusercontent.com",
      "clientSecretEnv": null,
      "redirectUri": null,
      "allowedOrigins": ["http://localhost:8765"],
      "shared": false,
      "sponsor": { "operations": ["0", "1", "2", "3"], "maxActionsPerSession": 20, "maxDailyFeeMicroAlgos": "2000000" }
    }
  ]
}
```

Deployment records (public data, written by the cli):

- `$ZKAUTH_STATE_DIR/deployments/<network>/providers/<provider>.json` — `ProviderDeployment`
- `$ZKAUTH_STATE_DIR/deployments/<network>/apps/<app>.json` — `AppDeployment`

The existing `.local/phase6/deployment*.json` records and `scripts/check-demo.sh` stay valid; `zkauth` reads them for the legacy demo until milestone 3 moves it.

## Internal APIs

### prover

- `POST /v1/prove` — `Authorization: Bearer $ZKAUTH_PROVER_TOKEN`; body `{ provider, input }` where `input` is `oidcCircuitInput(...)`. Returns `{ proof, publicSignals, measurement: { prover, witnessMs, proveMs, elapsedMs, peakRssBytes } }` after checking the proof against the provider's verification key and `expectedPublicSignals(input)`.
- One proof at a time by default (`PROVER_CONCURRENCY`); `429` with `Retry-After` when the queue (`PROVER_QUEUE`, default 4) is full.
- Input and witness live only in a mode-700 job directory, removed on completion, failure or startup. Nothing from the input is logged.
- `GET /v1/health` — `{ ok, rapidsnark, providers }`.

### dev-issuer (refuses to start unless `ZKAUTH_NETWORK=localnet`)

- Emulates `DEV_ISSUER_PROVIDER` (default `google`): tokens carry that provider's issuer and claim profile, built with `syntheticToken`, signed by a persisted dev RSA-2048 key (`kid` `dev-1`).
- `GET /.well-known/openid-configuration`, `GET /jwks`.
- `GET /authorize?client_id&redirect_uri&state&nonce` — sign-in page to pick or type a test subject (`alice`, `bob`, …), then redirects with a code. With the dev issuer the provider's login flow is `code`.
- `POST /token` — code exchange → `{ id_token }`.
- `POST /test/token` `{ audience, nonce, subject }` → `{ id_token }` for headless tests.

### keysync

- Every `KEYSYNC_INTERVAL_SECONDS` (default 900) and at start: for each provider deployment, fetch JWKS and `ensureKeys` (registers new keys under the approval delay, renews keys within three days of expiry, seals an unsealed bootstrap).
- Then the guardian check: a key that is or will become valid but is absent from the JWKS is an alert — a JSON log line and, if set, a POST to `KEYSYNC_ALERT_WEBHOOK`.
- `GET /v1/health` reports the last run per provider.

## Compose

Profiles: `local` (algod dev mode with KMD, dev-issuer) and `testnet`. Services: `algod`, `dev-issuer`, `init` (one-shot: artifacts, deploy missing provider/app records, register dev keys), `prover`, `api`, `keysync`, `demo`; later `wallet`, `example`. Proving keys and state live in named volumes; the repository's `.local/` is not mounted into service containers.

## Rules for every component

- Errors are typed codes with static messages (openapi `ErrorCode`); never echo SDK traces, tokens, request JSON or identifiers.
- No component logs tokens, salts, circuit input, session ids or mnemonics.
- `benchmarks/` is written only by evidence runs, never by services or tests.
- Tests that move LocalNet's block clock (`scripts/run-key-delay-localnet.sh`) never run alongside other LocalNet tests.
