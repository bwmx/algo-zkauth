# api

The `/v1` REST service of AlgoZKAuth: login sessions, ID-token checks, the code-flow exchange, salt binding and wallet discovery, service and browser proofs, action plans, and sponsored submission under per-app quotas. The contract is [openapi.yaml](openapi.yaml); roles, ports and environment are in [docs/service-architecture.md](../../docs/service-architecture.md).

## Run

```sh
npm run setup                                         # the pinned checkout and contract clients packages/chain needs (sh scripts/setup.sh)
ZKAUTH_NETWORK=localnet ZKAUTH_SPONSOR_MNEMONIC="..." ZKAUTH_PROVER_TOKEN=... npm start -w @algozkauth/api
```

It runs under tsx from the upstream checkout (`node --import ./upstream/snarkjs-algorand/node_modules/tsx/dist/loader.mjs services/api/src/server.ts`), because packages/chain loads its dependencies from there ([packages/chain/README.md](../../packages/chain/README.md)). Apps come from `$ZKAUTH_STATE_DIR/apps.json` and their deployment records (written by the cli); an app whose on-chain registry differs from its record is skipped with an `app_skipped` log line.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ZKAUTH_NETWORK` | required | `localnet` or `testnet` |
| `ZKAUTH_ALGOD_URL`, `ZKAUTH_ALGOD_TOKEN`, `ZKAUTH_INDEXER_URL` | per network | Node endpoints (packages/config) |
| `ZKAUTH_STATE_DIR` | `.local/service` | `apps.json` and deployment records |
| `ZKAUTH_SPONSOR_MNEMONIC` | required | Pays enrollment deposits and group fees |
| `ZKAUTH_PROVER_URL` | `http://localhost:8781` | Internal prover |
| `ZKAUTH_PROVER_TOKEN` | required | The prover's bearer secret |
| `ZKAUTH_DEV_ISSUER_URL` | unset | LocalNet only: provider endpoints point at the dev issuer |
| `ZKAUTH_API_PUBLIC_URL` | `http://localhost:<port>` | Base of the code-flow redirect `<base>/v1/oauth/<provider>/callback` (an app's `redirectUri` overrides it, e.g. an https relay) |
| `ZKAUTH_PUBLIC_ALGOD_URL`, `ZKAUTH_PUBLIC_INDEXER_URL` | the node URLs unless overridden | `algodUrl`/`indexerUrl` in the app config; omitted when the node URL is set but these are not (an internal URL is not given to browsers) |
| `API_PORT` / `API_HOST` | `8780` / `127.0.0.1` | Listen address (`0.0.0.0` in the image) |
| `API_SESSION_RATE_LIMIT`, `API_SESSION_RATE_WINDOW_SECONDS` | `30`, `60` | Session creations per client address per window |
| `API_TRUST_PROXY` | unset | `1`: the client address is the first `X-Forwarded-For` entry (only behind a proxy you control) |
| `API_FAUCET_MICROALGOS` | unset (off) | The wallet faucet: what it pays each enrolled wallet, once (e.g. `1000000`); see Behaviour |
| `API_FAUCET_DAILY_MICROALGOS` | `20000000` | The wallet faucet's total per UTC day across all apps; at least one claim |
| `API_DEV_FAUCET` | on | LocalNet only: `0` turns off the dev faucet (`/dev/fund`) |
| `<clientSecretEnv>` | — | Per-app OAuth client secret named in `apps.json` (code flow with an https redirect) |

## Behaviour

- **Sessions** ([src/sessions.ts](src/sessions.ts), generalised from `scripts/demo/sessions.mjs`) belong to one app and its provider and last 600 s. The id is 32 random bytes and is a capability: never logged. The login nonce binds the genesis hash, the browser's session key, the expiry and its randomness. A session's login is used once, pass or fail (`login_consumed`); the token must carry the nonce, the app's client id, and an issue time that keeps the session inside the circuit's window. The salt binds once (`salt_conflict`) and yields the identity commitment and wallet discovery. Token, salt and PKCE verifier stay in memory and are erased on expiry or `DELETE`.
- **Clock.** Session times follow the chain's clock (the latest block's timestamp), because the proof's session window is checked against it on chain. On TestNet that is within a block of wall time. A LocalNet in dev mode keeps its own block clock (on the shared one it was hours behind wall time), so tokens must be issued on that clock: the integration test runs the dev issuer with `now` set to the chain's time, and compose gives the dev issuer `DEV_ISSUER_ALGOD_URL`. Every session response also carries `networkTime` (now on that clock), from which the SDK measures its skew.
- **Code flow.** `POST /v1/sessions` returns `authorizeUrl` (state, nonce, PKCE when the provider's descriptor asks for it, via `packages/protocol/src/code-login.mjs`). The provider redirects the login window to `/v1/oauth/<provider>/callback`; the service exchanges the code itself, so the token never reaches the page, and returns a static page that closes (CSP allows only its own script by hash). The dApp polls `GET /v1/sessions/{id}`; failures appear as `loginError`. With the dev issuer there is no secret to send, so a placeholder is passed.
- **Proofs.** `POST …/proofs` sends `oidcCircuitInput(...)` to the prover and keeps a job (`queued` → `proof` → `verification` → `ready`/`failed`, with an ErrorCode) the client polls; the input is not kept. The result must equal `expectedPublicSignals(input)` and pass the chain's `checkProof` (Groth16 verification, network/audience binding, key policy). Browser proving: `POST …/circuit-input` returns the private input to the session's own origin; `PUT …/proof` accepts a proof only if its public signals are this session's and `checkProof` passes.
- **Actions.** `POST /v1/actions` (`version: 1`) returns the chain's plan plus `expiresAt` (2 minutes). Enrollment's recipient, asset and amount are the sponsor, `0` and the deposit, and an opt-in's recipient and amount are the wallet and `0`. Clients may send these, as the SDK does, but a different value is `bad_request`, never silently replaced. `POST /v1/actions/{planId}/submit` checks the Ed25519 signature over the action digest against the session key, then the sponsor signs and pays, and it returns after confirmation. A plan is single-use: the first submit consumes it whatever the outcome, and a second is `replay`.
- **Origins and CORS** ([src/policy.ts](src/policy.ts)). Every request except health and the code-flow callback must carry an `Origin` in its app's `allowedOrigins`; the app comes from the path, the body's `app`, or the session. A missing Origin is refused too. Responses and preflights get `Access-Control-Allow-Origin` only for origins some app allows; a preflight from any other origin is `403`. No credentials or cookies are used.
- **Sponsor policy.** Per app: `operations` (others are `quota_exceeded`), `maxActionsPerSession` (confirmed plus in-flight submits), and `maxDailyFeeMicroAlgos` per UTC day. That last limit counts group fees, not the enrollment deposit; `retryAfter` gives the time to the next UTC day. It is checked when a plan is prepared, and enforced when it is submitted: the fee is reserved, settled to the actual fee on confirmation, and released on failure. The counters are in memory and per process, so they reset when the service restarts, and replicas do not share them.
- **Rate limit.** A fixed window per client address on `POST /v1/sessions` (`rate_limited` with `retryAfter`), plus caps on active sessions (10 000 in all, 5 000 per app).
- **Wallet faucet** (TestNet, or LocalNet for tests). Off unless `API_FAUCET_MICROALGOS` is set; then the app config carries `faucet: { amountMicroAlgos }`, so pages offer it only where it exists. `POST /v1/apps/{app}/faucet` `{ address }` pays that amount from the sponsor, with the note `algozkauth-faucet:<address>`, only:
  - to a wallet this app's registry created (`snapshotByAddress`; anything else is `not_enrolled`), from one of the app's origins;
  - to a wallet whose spendable balance is below the amount;
  - once per wallet: a wallet paid before is `quota_exceeded`. The service remembers the wallets it paid, and also asks the indexer whether the sponsor ever sent that note, so the rule survives restarts; if the indexer cannot answer, nothing is paid (`service_unavailable`);
  - within `API_FAUCET_DAILY_MICROALGOS` per UTC day across all apps (`quota_exceeded` with `retryAfter` to the next day), and never taking the sponsor's spendable balance below 2 ALGO, kept for deposits and fees (`insufficient_funds`);
  - six requests a minute per client (`rate_limited`).

  A wallet and the day's total are reserved together before the payment is sent and released if it fails, so concurrent claims for one wallet cannot both pass. The daily total is kept in memory: a restart starts the day's count again, so the most a day can pay is the total times the number of restarts that day. Payments are not counted in the app's sponsor quota.
- **LocalNet dev faucet.** `POST /v1/apps/{app}/dev/fund` `{ address }` sends 5 ALGO from the sponsor to any address (six requests a minute per client; `quota_exceeded` once the address holds 20 ALGO). It exists only on LocalNet and is off with `API_DEV_FAUCET=0`; elsewhere it is `not_found`.
- **Errors** ([src/errors.ts](src/errors.ts)) are the openapi `ErrorCode`s with static messages. `ChainError`s map as follows:
  - `invalid_proof`, `wrong_network` and `wrong_audience` become `proof_failed`.
  - `rejected` becomes `bad_request`.
  - Key, registry, wallet, replay and funds codes keep their names.
  - `key_pending_delay` adds `retryAfter`, the seconds until the key activates.
  - Anything else becomes `service_unavailable`.
- **Status codes** for each error code:

  | Status | Codes |
  | --- | --- |
  | 400 | `bad_request`, `provider_unsupported` |
  | 401 | `unauthorized`, `session_expired`, `not_signed_in`, `token_invalid` |
  | 403 | `origin_not_allowed`, `key_inactive`, `key_pending_delay` |
  | 404 | `not_found`, `app_unknown` |
  | 409 | `login_consumed`, `salt_required`, `salt_conflict`, `proof_pending`, `wallet_exists`, `not_enrolled`, `plan_mismatch`, `replay`, `insufficient_funds` |
  | 410 | `plan_expired` |
  | 422 | `proof_failed` |
  | 429 | `quota_exceeded`, `rate_limited` |
  | 503 | `registry_paused`, `service_unavailable` |
- **Logging.** One JSON line per request with the route template (never the path), status, time and error code. AlgoKit's logger is silenced before the chain client opens, because it would log app-call arguments. The upstream verifier prints snarkjs's `EXPORT VERIFICATION KEY` lines when it derives a LogicSig; they contain no request data.
- **Health.** `GET /v1/health` returns `{ ok, network, prover, algod }`. It probes the prover's `/v1/health` and algod's `/health`.

## Tests

```sh
npm run test:unit -w @algozkauth/api     # sessions, origins/CORS, quotas, rate limit, error mapping; no network
npm test -w @algozkauth/api              # plus the LocalNet integration test (about 20 s with rapidsnark)
```

The LocalNet test uses AlgoKit LocalNet on localhost:4001/4002 and its indexer on 8980. It does not move the clock or write `benchmarks/`. It sets up its own environment:

- A temporary `ZKAUTH_STATE_DIR`.
- The dev issuer in process on 9190.
- The prover spawned on 9181 with a test token.
- One provider and one app deployed with `openChain`, using admin and sponsor accounts funded from the KMD dispenser, then recorded with packages/config. `ensureKeys` registers the dev issuer's JWKS.
- The API in process on 9180.

Through HTTP it then exercises:

- App config.
- A session and the dev issuer's code flow, run like a browser: the sign-in page, its form, and the redirect to the callback.
- Salt binding, then a service proof job.
- Enrollment signed with a WebCrypto Ed25519 key, including a forged signature, a used-up plan and SDK-shaped enroll requests with wrong values.
- The wallet faucet: refused for an address that is not an enrolled wallet of the app, a bad address and another origin; one claim paid, a second refused.
- An ALGO transfer, plan reuse (`replay`), a mismatched opt-in recipient, wrong and missing Origins and preflights.
- Browser proving: circuit input, an out-of-band proof, and tampered signals or proof refused; enrollment with that proof; then the faucet's daily total and the daily fee quota.
- A second api on the same state, as after a restart: the faucet refuses the wallet it paid from the sponsor's history alone. A third without the faucet: no `faucet` in the config, `not_found` on the route, and the LocalNet dev faucet paying any address until it holds 20 ALGO.
- A cancelled sign-in, `provider_unsupported` and the session rate limit.
- A check that the logs hold no session ids, salts or tokens.

Proofs run one at a time. rapidsnark at `.local/bin/<platform>-<arch>/prover` takes a proof to about 10 s.

## Docker

```sh
docker build -f services/api/Dockerfile -t zkauth-api .
docker run -d -p 127.0.0.1:8780:8780 -v zkauth-fixtures:/app/fixtures:ro -v zkauth-state:/app/.local/service \
  -e ZKAUTH_NETWORK=testnet -e ZKAUTH_SPONSOR_MNEMONIC=... -e ZKAUTH_PROVER_URL=http://prover:8781 -e ZKAUTH_PROVER_TOKEN=... zkauth-api
```

The image is `node:24-trixie-slim`, like the prover's, and is built in two stages:

1. **The upstream checkout.** packages/chain loads algosdk, AlgoKit, snarkjs, tsx and the LogicSig verifier by path from the pinned `upstream/snarkjs-algorand` checkout, and that checkout is gitignored and excluded from the build context. The first stage therefore creates it the way a developer does: `scripts/setup.sh checkout` checks out the pinned commit and runs `pnpm install --frozen-lockfile`, which builds Linux-native modules. That stage then installs the committed contract clients into the checkout, as `scripts/setup.sh stage` does.
2. **The runtime.** The second stage copies that checkout (without `.git`) and only the code the service imports:
   - `packages/{protocol,config,chain}` (protocol includes the code-flow helpers, `code-login.mjs`)
   - `contracts/clients`, which `openChain` byte-compares
   - `services/dev-issuer/src/override.ts`, used by packages/config
   - the verification keys

This keeps exactly one algosdk and AlgoKit at runtime, and it needs no second npm install, which could resolve different versions. The cost is a network fetch at build time and a 770 MB image, because the checkout's development dependencies come along.

The verifier LogicSig is derived from each provider's proving key, so the API needs the same fixtures volume as the prover. Read-only access is enough. The state volume holds `apps.json` and the deployment records.
