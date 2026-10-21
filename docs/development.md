# Development runbook and command reference

Every command, grouped by what you want to do. Run them from the repository root. Most are root npm scripts (`npm run` lists them all); the rest are shown as the script they run. These commands reproduce the implementation stages; they are not a production deployment procedure. TestNet commands create and spend test assets. Evidence runners overwrite their recorded snapshot in `benchmarks/` after successful checks, so preserve evidence before a new run (`git checkout benchmarks/` restores it).

| Directory | What lives there |
| --- | --- |
| `scripts/` | `setup.sh`, the proving-artifact tools (`artifacts.mjs`, `publish-artifacts.sh`) and `providers.mjs` (provider data for shell scripts) |
| `scripts/build/` | Circom bootstrap, circuit generation, compilation and setup, contract builds |
| `scripts/demo/` | The original single-process TestNet demo ([retired](../scripts/demo/README.md) after the service stack's first TestNet run) |
| `evidence/` | The tools that produced `benchmarks/` ([which command wrote each record](../evidence/README.md)) |
| `tests/unit/`, `tests/circuits/`, `tests/localnet/`, `tests/e2e/` | Fast `node:test` suites; witness tests that need the compiled circuits; the LocalNet contract suites with their runners; browser and SDK tests against the local stack |

## Set up

The tested environment is macOS with Node 24, pnpm, AlgoKit 2.10.2 and Docker for LocalNet. Full-circuit runs used Node v24.15.0; the earlier small verifier runs used Node 26.5.0. The recorded pnpm version was 10.33.0. Other operating systems and runtimes are not established by these results.

| To | Run | Notes |
| --- | --- | --- |
| Install the workspace packages | `npm install` | npm workspaces: `packages/*`, `services/*`, `tools/*`, `apps/*`, `examples/*`, `tests/e2e`. `web/app` has its own lockfile (`npm --prefix web/app ci`) |
| Set up the pinned upstream checkout | `npm run setup` | `sh scripts/setup.sh`: checks out `snarkjs-algorand` commit `3a970c7fb47efadd60c0b09a3200e8428ac47df2`, installs its locked dependencies (`pnpm install --frozen-lockfile`; local commits on top are accepted if `package.json` and the lockfile are unchanged), then installs the committed contract clients and the disposable policy check into it. `setup.sh checkout` and `setup.sh stage` run one half |
| Install Circom and the checkout, for circuit builds | `bash scripts/build/bootstrap.sh` | Downloads Circom 2.2.3's macOS amd64 binary with SHA-256 verification (the recorded Apple Silicon run used Rosetta), then `setup.sh checkout` |
| Start LocalNet | `algokit localnet start` | localhost:4001/4002; the LocalNet suites deploy their own apps and never reset it |
| Download the proving artifacts | `npm run artifacts:fetch -- google slack` | `node scripts/artifacts.mjs fetch [providers]`, see [Proving artifacts](#proving-artifacts); `npm run artifacts:check -- google slack` verifies local copies |

Everything that imports `packages/chain` (the services, the CLI, the original demo, the chain tests) loads algosdk, AlgoKit, snarkjs, tsx and the verifier from that checkout by path ([why](../packages/chain/README.md)), so `npm run setup` comes first. There is no second install of those packages.

Downloaded checkouts, generated circuit binaries and private state are ignored. Do not commit `.env`, `.local/`, JWTs, witnesses, salts, mnemonic phrases, recovery secrets or private signing keys. Keep `.local/wallet-salt.bin` if retaining the earlier Phase 3 identity. Its salt is independent of the later demo's browser backup.

## Run the checks

| Check | Command | Needs |
| --- | --- | --- |
| Fast protocol and interface checks (56) | `npm test` | `npm run setup` (for algosdk); no circuits, LocalNet or TestNet. Globs `tests/unit/*.test.mjs` and the original demo's own `scripts/demo/*.test.mjs` |
| The original demo's React page (24) | `npm run test:web` | `npm --prefix web/app ci` once |
| SDK | `npm run test:sdk` | Typecheck, then vitest against an in-memory fake API (jsdom) |
| Sign-in verifier | `npm run test:verify` | Typecheck, then the noble-curves Groth16 check against snarkjs on the fixture proofs (snarkjs from `npm run setup`) |
| api | `npm run test:api` | Unit tests and a LocalNet integration test (about 20 s with rapidsnark); `npm run test:unit -w @algozkauth/api` skips LocalNet |
| Dev issuer, prover, CLI with keysync | `npm run test:services` | Runs `test:dev-issuer` (including Google and Slack witnesses), `test:prover` (`services/prover/test/prover.test.ts`, rapidsnark) and `test:cli` (`tools/cli/test/cli.localnet.test.ts` and `services/keysync/test/keysync.localnet.test.ts` on LocalNet, with the google artifacts). The prover's snarkjs test takes about two more minutes: `npm test -w @algozkauth/prover` |
| LocalNet contract suites | `npm run test:localnet` | LocalNet and the full-circuit artifacts; runs the five suites below in turn |
| `packages/chain` | `npm run test:localnet:chain` | Shared provider deployment, two apps, key registration, a synthetic identity's enrollment and transfer; does not move the block clock or write `benchmarks/` |
| Key registry policy | `npm run test:localnet:key-registry` | Recompiles `KeyRegistry` and runs 12 policy tests; writes `benchmarks/phase3-key-registry.localnet.json` |
| Wallets (Phase 4) | `npm run test:localnet:wallets` | Rebuilds the contracts, proves two synthetic identities and runs 46 wallet checks; writes `benchmarks/phase4-*.localnet.json` |
| Recovery (Phase 5) | `npm run test:localnet:recovery` | Deletes the original synthetic client state and restores in a separate process; writes `benchmarks/phase5-recovery.localnet.json` |
| Second provider (Slack) | `npm run test:localnet:slack` | Slack's artifacts and the Phase 4 Google session in `.local/phase4/` (for the cross-provider check); writes `benchmarks/slack-*.localnet.json` |
| Key-approval delay | `npm run test:localnet:key-delay` | **Moves LocalNet's block clock about 24 hours ahead**, which cannot be undone: run it last and alone, then `algokit localnet reset` |
| Browser end to end | `npm run test:e2e` | The compose stack running (`npm run stack:up`) and `npx -w @algozkauth/e2e playwright install chromium` once |
| SDK end to end in Node | `npm run test:e2e:sdk` | The compose stack running. Includes backend sign-ins verified against the chain and 15 refused tamperings |

The fast Node checks cover encoding, validation, Google and Slack token handling, the authorization code exchange and relay page, worker loading and telemetry, recovery crypto, session handling, action validation and historical receipts. The React interface's typecheck and 24 checks are 18 jsdom checks with a stubbed server, Google, Slack, a further code-flow provider and indexer, and six that re-verify recorded TestNet transactions (saved indexer responses) with the showcase's verification code. The jsdom checks cover the backup gate, browser signing of enrollment, ALGO and ASA actions, rejection of a changed server plan, a server nonce or proof bound to another key, a code-flow sign-in (Slack) through a login window, refusing to start the full demo with too little session left, transfer review and cancellation, amount limits, and history summarization from a recorded TestNet response. The verification checks include the Groth16 proof and confirm that a changed amount, signal, owner or verifier is caught. VM/WebAuthn stubs do not establish real browser/authenticator support or public-network acceptance. Full upstream typechecking has three recorded pre-existing `scripts/constants.ts` errors in the upstream checkout; it is not a clean build claim.

The contract suites in `tests/localnet/` run inside the pinned checkout: each runner copies its test file into `upstream/snarkjs-algorand/__test__/` and the protocol modules it needs into `upstream/snarkjs-algorand/src/algozkauth/`, then runs that checkout's vitest. The checkout has no license of its own, so it stays a fetched dependency. The wallet and recovery runners temporarily control developer timestamps for long proofs and exact expiry tests. They restore the prior clock in `finally`; restoring an originally unset override can briefly restart the existing algod container while retaining its ledger. They create fresh LocalNet applications/assets and do not change the root Google capture or `.local/wallet-salt.bin`. [Wallet specification](phase4-wallets.md), [recovery format and scope](phase5-recovery.md).

## Run the service stack

```sh
npm run stack:up       # docker compose --profile local up -d --build
npm run stack:down     # docker compose --profile local down (add -v to delete its chain, state and cached key)
```

The demo dApp is at <http://localhost:8765>, the hosted wallet at <http://localhost:8770>, the send-algo example at <http://localhost:8775>, its backend at <http://localhost:8785>, the api at <http://localhost:8780> and the dev issuer at <http://localhost:8790>. Give Docker at least 6 GB; the first run downloads the 1.4 GB proving key. [Architecture, ports and configuration](service-architecture.md).

The web apps build with `npm run build -w @algozkauth/demo` (likewise `@algozkauth/wallet`, `@algozkauth/example-send-algo`) and run against a local api with `npm run dev -w …`. Each service also runs on its own (`npm start -w @algozkauth/api`, and so on; see its README). The example backend runs with `node examples/backend/server.ts` ([README](../examples/backend/README.md)).

## Build circuits and contracts

With the bootstrap done:

```sh
npm run build:circuit -- google                                         # bash scripts/build/build-circuit.sh google
node scripts/build/download-ptau.mjs
node --max-old-space-size=6000 scripts/build/setup-jwt-circuit.mjs google
bash scripts/build/build-jwt-authorization.sh
```

[`scripts/build/write-jwt-circuit.mjs`](../scripts/build/write-jwt-circuit.mjs) generates each provider's circuit from its profile. The circuit build pins `zk-jwt` commit `3a50a9bb80020a5bf7964881dcf70286e22037ab`, installs locked dependencies, compiles the full circuit and runs its witness tests (`tests/circuits/<provider>-circuit-witness.test.mjs`). The power-22 download is 4,831,921,304 bytes and is digest-checked. Setup applies one local development contribution and writes a 1,425,797,992-byte proving key. The recorded setup took about eleven minutes with 3.16 GB sampled peak RSS; proof generation took about two minutes. Allow several GB of RAM and disk space for artifacts and intermediate files. `build-jwt-authorization.sh` builds the Phase 3 proof-policy gate and the key registry it calls.

**Regenerating setup changes the verification key.** Existing wallets/registries pin their verifier; retain their matching artifacts or deliberately deploy a new development environment. A new setup is not a way to refresh the existing demo in place.

**Contracts.** Everything deploys from the generated clients committed in [`contracts/clients/`](../contracts/clients/), which embed the compiled programs; `npm run setup` installs them into the upstream checkout. After changing `contracts/*.algo.ts`, run `npm run build:contracts` (`bash scripts/build/build-wallets.sh`: puya-ts and AlgoKit) to recompile and refresh the committed clients, and commit them with the source change. The LocalNet wallet runners rebuild them the same way.

### Proving artifacts

The quickstart and `zkauth artifacts fetch` download each provider's proving key, witness wasm and witness calculator from the GitHub release named in [`fixtures/artifacts.json`](../fixtures/artifacts.json), which pins each file's size and SHA-256 to match the committed verification keys. `npm run artifacts:check -- google slack` verifies local copies. After rebuilding a circuit or its setup, update the manifest and verification key together and publish a new release with `sh scripts/publish-artifacts.sh` (maintainers; uses `gh`). `ARTIFACTS_BASE_URL` points downloads at a mirror of the same files.

**Native prover.** `node scripts/artifacts.mjs fetch` also installs the pinned rapidsnark build for the platform at `.local/bin/<platform>-<arch>/prover` (checked against the SHA-256 in `fixtures/artifacts.json`; needs `unzip`). The prover service and the original demo's `scripts/demo/prove-demo.mjs` use it when present and fall back to snarkjs if it is missing or fails; `PROVER=snarkjs` forces the fallback and `RAPIDSNARK_PATH` points at another binary. The linux-x64 build needs a CPU with ADX/BMI2, and both Linux builds need glibc 2.38 or newer (the Docker images use Debian trixie).

## Slack sign-in

Slack has its own circuit, development key and deployment of the unchanged contracts. With the circuit tools, `zk-jwt` checkout and power-22 file in place:

```sh
npm run build:circuit -- slack
node --max-old-space-size=6000 scripts/build/setup-jwt-circuit.mjs slack
npm run test:localnet:slack
```

The build regenerates `circuits/slack_jwt.circom`, compiles it into `fixtures/slack/` and runs five witness tests with synthetic Slack-shaped tokens. Setup writes `fixtures/slack/slack_jwt.zkey`, its verification key and `benchmarks/slack-setup.json`; the recorded run took about nine minutes with 5.29 GB sampled peak RSS. The LocalNet runner proves one synthetic Slack-shaped identity ([`synthetic-token.mjs`](../packages/protocol/src/synthetic-token.mjs)), enrolls its wallet, transfers ALGO, checks replay and cross-provider rejection, and writes `benchmarks/slack-wallets.localnet.json`. It needs the Phase 4 Google session in `.local/phase4/` for the cross-provider check.

**The Slack app.** Create a Slack app with Sign in with Slack (OpenID Connect), add `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` to `.env`, and register a redirect URL:

- **PKCE-enabled app:** Slack refuses localhost redirects without PKCE, and its OpenID Connect flow does not complete with PKCE. Register the https relay `https://bwmx.github.io/algo-zkauth/slack-callback/` and set `SLACK_REDIRECT_URI` to it. A fork publishes `apps/oauth-relay/index.html` at its own https URL, `…/<provider>-callback/`, instead; the relay forwards to the provider named by that path.
- **Otherwise:** register `http://localhost:8765/demo/slack/callback`, the default.

To check a genuine Slack token without chain access, configure the app, then run:

```sh
node --env-file=.env evidence/login/check-login.mjs slack
node --env-file=.env --max-old-space-size=6000 evidence/login/prove-login.mjs slack
```

Open `http://localhost:8765/` and sign in within ten minutes of loading the page. The first command checks the token through the full circuit and writes the sanitized `benchmarks/slack-token-profile.json`. It keeps a private copy in `.local/slack/genuine-login.json` for offline rechecks. The second proves and verifies that copy. Its session key has no private half, so neither authorizes a wallet. [Slack protocol and evidence](slack-oidc.md).

Changing the Slack claim profile or primitives changes the Slack verification key; rerun setup and redeploy. Primitive changes must leave the Google R1CS SHA-256 equal to `benchmarks/phase3-setup.json`.

## Adding a login provider

Everything provider-specific is data; scripts, server, contracts and the page take a provider id.

- [`packages/protocol/src/oidc-providers.mjs`](../packages/protocol/src/oidc-providers.mjs): issuer spellings, JWKS URL, login flow (`in-page`, where the provider's script returns the token to the page, or `code`, an authorization code exchanged by the server), PKCE rule, optional workspace-scoped subject, session-expiry rule, environment prefix (`<PREFIX>_CLIENT_ID`, `_CLIENT_SECRET`, `_REDIRECT_URI`) and where its artifacts, deployment and records live. New providers use their id in every path.
- [`packages/protocol/src/circuit-profile.mjs`](../packages/protocol/src/circuit-profile.mjs): the claims the circuit accepts, their kinds, the required claims and the optional `azp`/`nbf` rules. `node scripts/build/write-jwt-circuit.mjs <provider>` generates the circuit from it.
- [`packages/protocol/src/recovery.mjs`](../packages/protocol/src/recovery.mjs): the browser's issuer table for backups.
- An `in-page` provider also needs an adapter in [`web/app/src/logins.ts`](../web/app/src/logins.ts). A `code` provider needs none; if it only redirects to https, publish the relay at `/<provider>-callback/` in `pages.yml`.

Then: `evidence/login/check-login.mjs <provider>` records a genuine token's claim profile even before a circuit exists; write the profile; `npm run build:circuit -- <provider>` with a `tests/circuits/<provider>-circuit-witness.test.mjs`, `scripts/build/setup-jwt-circuit.mjs <provider>`, `bash tests/localnet/run-provider-localnet.sh <provider>`, a release of its artifacts in `fixtures/artifacts.json`, and `sh scripts/demo/deploy-demo.sh <provider>`.

## Legacy TestNet demo

The original single-process demo (Phase 6) lives in [`scripts/demo/`](../scripts/demo/README.md) with its page in `web/app/`. It is kept working until the service stack's first TestNet run. Running it from a fresh clone needs neither Circom nor AlgoKit: `sh scripts/demo/quickstart.sh` (`npm run demo:quickstart`) sets up the upstream checkout, downloads the published proving artifacts and deploys from the committed contract clients. See [the README](../README.md#run-the-demo).

| To | Run |
| --- | --- |
| Deploy (or reuse) this clone's contracts | `sh scripts/demo/deploy-demo.sh [providers]` (`npm run demo:deploy`) |
| Start the server at <http://localhost:8765/demo/> | `sh scripts/demo/start-demo.sh` (`npm run demo:start`) |
| Key-registry guardian status and veto | `sh scripts/demo/key-guardian.sh status [provider]` (`npm run demo:guardian -- status`); also `revoke`, `cancel-renewal`, `pause` |
| Read-only TestNet acceptance | `sh evidence/check-demo.sh [provider]` (`npm run evidence:check`, or `zkauth check`) |
| Run it in Docker | `docker compose run --rm --service-ports demo` (`scripts/demo/Dockerfile`) |

Keep the existing full-circuit key/artifacts. Configure `TESTNET_MNEMONIC` and `GOOGLE_CLIENT_ID` in `.env`, the localhost Google origin, and a free port 8765. To add Slack, build or download its artifacts and configure [the Slack app](#slack-sign-in). Either provider can be configured alone.

`deploy-demo.sh slack` (or `google`, or any provider ids) limits a run to those providers, leaving the other's records untouched. Initial deployment requires at least five spendable test ALGO per provider. Slack gets its own registry, key registry and demo ASA in `.local/phase6/deployment-slack.json` and `benchmarks/slack-deployment.testnet.json`. A matching `.local/phase6/deployment.json` is reused; mismatched sponsor, audience, genesis or verifier is rejected. Without that private record, the deployer creates a new deployment instead of adopting the published benchmark IDs. Do not delete the record to obtain new funding. Wallet funding is one-time and capped at four IDs. The demo's chain code is `openDemoChain` in [`packages/chain/src/demo.ts`](../packages/chain/src/demo.ts).

`start-demo.sh` builds the React interface in `web/app/` with `scripts/demo/build-demo-app.sh` (`npm ci` on first use, then a typecheck and Vite build into the ignored `web/app/dist/`). The server serves it at `/demo/` and refuses to start without a build. During interface work, `npm --prefix web/app run watch` rebuilds on change; reload the page served on port 8765, the origin registered with Google.

Use [the demo](http://localhost:8765/demo/), or [the Slack demo](http://localhost:8765/demo/?provider=slack), and follow [the two-account and original-wallet restore procedure](poc-report.md#start-and-repeat-the-demo). The integrated page obtains its own fresh nonce-bound token; it does not use an old `GOOGLE_ID_TOKEN` capture. Sign in with Slack opens a login window; the localhost server exchanges the code with the client secret and the tab polls for the result. Slack events are recorded in `benchmarks/slack-demo.testnet.json`. Proving is local Node, one job at a time.

**Run records.** `deploy-demo.mjs` and the demo server write their records to `benchmarks/` unless `DEMO_EVIDENCE_DIR` names another directory. The quickstart sets it to `.local/evidence`, so a clone's runs do not overwrite the published evidence.

**Acceptance** (`sh evidence/check-demo.sh`, `sh evidence/check-demo.sh slack`) makes read-only chain queries, checks historical groups and independently rechecks proofs/action signatures. For Slack it applies the same per-action checks to the single-account run, lists the multi-account scenarios as deferred and writes `benchmarks/slack-acceptance.testnet.json`. It needs original `.local/phase6/jobs/*/result.json` public proof output and private identity-audit labels; it intentionally does not load JWTs, salts, mnemonic or recovery secrets. A fresh checkout containing only sanitized records cannot reproduce that original acceptance. Exit 0 means the local scenario passed with the portability gate open, exit 2 means evidence is pending, exit 1 means validation failed. It writes `benchmarks/phase6-acceptance.testnet.json` and updates the generated block in the POC report. The disposable key/session-policy run it checks when that record exists comes from `node --env-file=.env --import ./upstream/snarkjs-algorand/node_modules/tsx/dist/loader.mjs evidence/check-demo-policy.mjs [provider]`.

## Reproduce the recorded evidence

[`evidence/README.md`](../evidence/README.md) maps every record in `benchmarks/` to the command that wrote it. The phase-by-phase steps:

### Small verifier checks — Phases 1–2

```sh
bash evidence/verifier/run-localnet.sh
```

This regenerates custom and one/seven-signal fixtures, independently verifies proofs and runs the project-owned LocalNet tests. Results are written to `benchmarks/results.localnet.json`. The development keys use upstream `circuit/pot14_bn254_final.ptau`; they have no production ceremony claim. It needs the bootstrap's Circom binary.

For the standalone seven-signal TestNet path, set a funded TestNet-only account's **25-word Algo25 mnemonic** as `TESTNET_MNEMONIC` in the ignored root `.env`, then run:

```sh
bash evidence/verifier/run-testnet.sh
```

The runner deploys verifier/proof-carrying applications, confirms a valid group and checks actual-node rejection of altered signals. It writes `benchmarks/results.testnet.json`. A 24-word xHD phrase is not the Algo25 signer format used here; this runner does not derive an xHD account. Funding must cover deployment minimum balances and fees.

### Full JWT circuit — Phase 3

After [building the Google circuit](#build-circuits-and-contracts):

```sh
npm run test:localnet:key-registry
node evidence/phase3/run-authorization-localnet.mjs
```

These test the policy registry and synthetic full-circuit LocalNet authorization. [Protocol, capacities and trust boundaries](phase3-protocol.md).

For the isolated Phase 3 genuine Google authorization test, create an OAuth Web application client, register `http://localhost:8765` as an Authorized JavaScript origin, put `GOOGLE_CLIENT_ID` in root `.env`, and start:

```sh
node --env-file=.env evidence/phase3/login-server.mjs
```

Open [the login page](http://localhost:8765/) and sign in. It verifies and saves the token plus nonce/public session context/randomness to `.env` with restrictive permissions. The session private key stays in the browser. With `TESTNET_MNEMONIC` configured, run promptly after login:

```sh
bash evidence/phase3/run-authorization-testnet.sh
```

This generates and verifies the genuine proof, deploys the TestNet gate/key registry and checks confirmation, altered signals and revocation. The script requires at least 600,000 µALGO spendable for deployment funding/fees. A session lasts at most ten minutes. Private artifacts are under `.local/phase3/`.

For the browser-only proving benchmark, open [the prover page](http://localhost:8765/prover/), choose the synthetic input and generate a proof. The single worker loads 4 MiB key pages and uses single-thread snarkjs proving; the server verifies the result and writes `benchmarks/phase3-browser.json`. This benchmark does not submit an asset transfer. A genuine-token browser proof was recorded later, separately (`benchmarks/phase3-browser-google.json`).

```sh
node --max-old-space-size=6000 evidence/phase3/check-browser-prover.mjs
node --test tests/unit/browser-prover.test.mjs
```

The first command runs the browser library/worker under Node and writes a separately scoped non-browser benchmark. `--small` uses the Phase 1 fixture. Neither mode establishes browser compatibility. The pages the login server serves are in `evidence/phase3/pages/`. Stop the Phase 3 login server before starting the integrated server on the same port.

### Wallets and recovery — Phases 4–5

With full-circuit artifacts and LocalNet available:

```sh
node --test tests/unit/wallet-action.test.mjs
npm run test:localnet:wallets
node --test tests/unit/recovery.test.mjs tests/unit/passkey-prf.test.mjs tests/unit/recovery-page.test.mjs
npm run test:localnet:recovery
```

Wallet tests generate two synthetic RSA identities through the full circuit and execute enrollment, ALGO/ASA, replay/isolation and policy/failure checks. Recovery tests delete the original synthetic client directory and restore in a separate process with the retained encrypted file and separately stored secret.

For the separate pre-enrollment recovery interface, run the Phase 3 login server and open [the recovery page](http://localhost:8765/recovery/). Sign in, create a test backup, save the secret separately, download/import the exact file and verify secret restoration. Try optional PRF, then repeat import/restoration in another browser or device using the same origin and identity. This page creates no wallet. Current evidence contains Chrome secret recovery and `prf-unavailable`; successful PRF and physical-device portability remain open.

## Showcase page and CI

The public showcase at <https://bwmx.github.io/algo-zkauth/> is a static page in `web/app/site/` and `web/app/src/site/`. It replays the recorded Google TestNet run from `src/site/recorded-run.json`, which [`evidence/write-showcase-data.mjs`](../evidence/write-showcase-data.mjs) (`npm run evidence:showcase`) extracts from the `benchmarks/phase6-*` records (public chain data and measurements only). Its "Verify it yourself" panel fetches a recorded transaction from the public TestNet indexer and, in the browser, checks the Groth16 proof against the committed verification key, the network, audience and owner bindings, and the session key's signature over the recomputed action, the same per-action checks as `evidence/check-demo.mjs`. Build it with `npm --prefix web/app run build:site`, which regenerates the data first.

GitHub Actions run two workflows. `ci.yml` runs `npm run setup` and `npm test`, the React typecheck and tests, both web/app builds, and fails if the committed showcase data is stale. `pages.yml` deploys the showcase, with the sign-in relay (`apps/oauth-relay`) at `/slack-callback/`, on pushes to `main` that touch the web code, the protocol modules it imports or the recorded evidence. Actions are pinned to commit SHAs.
