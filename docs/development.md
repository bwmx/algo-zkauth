# Development and reproduction runbook

These commands reproduce the implementation stages; they are not a production deployment procedure. Run them from the project root unless a command explicitly changes directory. TestNet commands create/spend test assets. Benchmark runners overwrite their corresponding recorded snapshots after successful checks; preserve evidence before starting a new run.

## Pinned environment

The tested bootstrap requires macOS, Node, pnpm, AlgoKit 2.10.2 and Docker for LocalNet. Full-circuit runs used Node v24.15.0; the earlier small verifier runs used Node 26.5.0. Recorded pnpm version was 10.33.0. Other operating systems/runtimes are not established by these results.

```sh
bash scripts/bootstrap.sh
algokit localnet start
```

Bootstrap checks out `snarkjs-algorand` commit `3a970c7fb47efadd60c0b09a3200e8428ac47df2`, uses its locked dependencies, and downloads Circom 2.2.3's macOS amd64 binary with SHA-256 verification. The recorded Apple Silicon run used Rosetta. There is no root npm package; project runners import dependencies and copy integration sources into this pinned checkout.

Downloaded checkouts, generated circuit binaries and private state are ignored. Do not commit `.env`, `.local/`, JWTs, witnesses, salts, mnemonic phrases, recovery secrets or private signing keys. Keep `.local/wallet-salt.bin` if retaining the earlier Phase 3 identity. Its salt is independent of the later demo's browser backup.

## Small verifier checks — Phases 1–2

```sh
bash scripts/run-localnet.sh
```

This regenerates custom and one/seven-signal fixtures, independently verifies proofs and runs the project-owned LocalNet tests. Results are written to `benchmarks/results.localnet.json`. The development keys use upstream `circuit/pot14_bn254_final.ptau`; they have no production ceremony claim.

For the standalone seven-signal TestNet path, set a funded TestNet-only account's **25-word Algo25 mnemonic** as `TESTNET_MNEMONIC` in the ignored root `.env`, then run:

```sh
bash scripts/run-testnet.sh
```

The runner deploys verifier/proof-carrying applications, confirms a valid group and checks actual-node rejection of altered signals. It writes `benchmarks/results.testnet.json`. A 24-word xHD phrase is not the Algo25 signer format used here; this runner does not derive an xHD account. Funding must cover deployment minimum balances and fees.

## Full JWT circuit and development setup — Phase 3

```sh
bash scripts/build-google-circuit.sh
node scripts/download-google-ptau.mjs
node --max-old-space-size=6000 scripts/setup-google-circuit.mjs
bash scripts/build-google-policy.sh
```

The circuit build pins `zk-jwt` commit `3a50a9bb80020a5bf7964881dcf70286e22037ab`, installs locked dependencies, compiles the full circuit and runs witness checks. The power-22 download is 4,831,921,304 bytes and is digest-checked. Setup applies one local development contribution and writes a 1,425,797,992-byte proving key. The recorded setup took about eleven minutes with 3.16 GB sampled peak RSS; proof generation took about two minutes. Allow several GB of RAM and disk space for artifacts and intermediate files.

**Regenerating setup changes the verification key.** Existing wallets/registries pin their verifier; retain their matching artifacts or deliberately deploy a new development environment. A new setup is not a way to refresh the existing demo in place.

```sh
bash scripts/run-key-registry.sh
node scripts/run-google-localnet.mjs
```

These test the policy registry and synthetic full-circuit LocalNet authorization. [Protocol, capacities and trust boundaries](phase3-protocol.md).

For the isolated Phase 3 genuine Google authorization test, create an OAuth Web application client, register `http://localhost:8765` as an Authorized JavaScript origin, put `GOOGLE_CLIENT_ID` in root `.env`, and start:

```sh
node --env-file=.env scripts/phase3-login-server.mjs
```

Open [the login page](http://localhost:8765/) and sign in. It verifies and saves the token plus nonce/public session context/randomness to `.env` with restrictive permissions. The session private key stays in the browser. With `TESTNET_MNEMONIC` configured, run promptly after login:

```sh
bash scripts/run-google-testnet.sh
```

This generates and verifies the genuine proof, deploys the TestNet gate/key registry and checks confirmation, altered signals and revocation. The script requires at least 600,000 µALGO spendable for deployment funding/fees. A session lasts at most ten minutes. Private artifacts are under `.local/phase3/`.

For the browser-only proving benchmark, open [the prover page](http://localhost:8765/prover/), choose the synthetic input and generate a proof. The single worker loads 4 MiB key pages and uses single-thread snarkjs proving; the server verifies the result and writes `benchmarks/phase3-browser.json`. This benchmark does not submit an asset transfer. Genuine Google browser proving has not been demonstrated.

```sh
node --max-old-space-size=6000 scripts/check-browser-prover.mjs
node --test tests/browser-prover.test.mjs
```

The first command runs the browser library/worker under Node and writes a separately scoped non-browser benchmark. `--small` uses the Phase 1 fixture. Neither mode establishes browser compatibility. Stop the Phase 3 login server before starting the integrated server on the same port.

## Wallet and recovery checks — Phases 4–5

With full-circuit artifacts and LocalNet available:

```sh
node --test tests/wallet-action.test.mjs
bash scripts/run-wallet-localnet.sh
node --test tests/recovery.test.mjs tests/passkey-prf.test.mjs tests/recovery-page.test.mjs
bash scripts/run-recovery-localnet.sh
```

Wallet tests generate two synthetic RSA identities through the full circuit and execute enrollment, ALGO/ASA, replay/isolation and policy/failure checks. Recovery tests delete the original synthetic client directory and restore in a separate process with the retained encrypted file and separately stored secret. [Wallet specification](phase4-wallets.md), [recovery format and scope](phase5-recovery.md).

Both LocalNet runners temporarily control developer timestamps for long proofs and exact expiry tests. They restore the prior clock in `finally`; restoring an originally unset override can briefly restart the existing algod container while retaining its ledger. They create fresh LocalNet applications/assets and do not change the root Google capture or `.local/wallet-salt.bin`.

For the separate pre-enrollment recovery interface, run the Phase 3 login server and open [the recovery page](http://localhost:8765/recovery/). Sign in, create a test backup, save the secret separately, download/import the exact file and verify secret restoration. Try optional PRF, then repeat import/restoration in another browser or device using the same origin and identity. This page creates no wallet. Current evidence contains Chrome secret recovery and `prf-unavailable`; successful PRF and physical-device portability remain open.

## Integrated demo — Phase 6

Keep the existing full-circuit key/artifacts. Configure `TESTNET_MNEMONIC` and `GOOGLE_CLIENT_ID` in `.env`, the localhost Google origin, and a free port 8765:

```sh
sh scripts/deploy-demo.sh
sh scripts/start-demo.sh
```

Initial deployment requires at least five spendable test ALGO. A matching `.local/phase6/deployment.json` is reused; mismatched sponsor, audience, genesis or verifier is rejected. Without that private record, the deployer creates a new deployment instead of adopting the published benchmark IDs. Do not delete the record to obtain new funding. Wallet funding is one-time and capped at four IDs.

Use [the demo](http://localhost:8765/demo/) and follow [the two-account and original-wallet restore procedure](poc-report.md#start-and-repeat-the-demo). The integrated page obtains its own fresh nonce-bound token; it does not use an old `GOOGLE_ID_TOKEN` capture. Proving is local Node, one job at a time.

```sh
sh scripts/check-demo.sh
```

Acceptance makes read-only chain queries, checks historical groups and independently rechecks proofs/action signatures. It needs original `.local/phase6/jobs/*/result.json` public proof output and private identity-audit labels; it intentionally does not load JWTs, salts, mnemonic or recovery secrets. A fresh checkout containing only sanitized records cannot reproduce that original acceptance. Exit 0 means the local scenario passed with the portability gate open, exit 2 means evidence is pending, exit 1 means validation failed. It writes `benchmarks/phase6-acceptance.testnet.json` and updates the generated block in the POC report.

## Fast protocol/interface checks

```sh
node --test tests/identity-commitment.test.mjs tests/session-nonce.test.mjs tests/browser-session-nonce.test.mjs tests/google-id-token.test.mjs tests/wallet-action.test.mjs tests/browser-prover.test.mjs tests/recovery.test.mjs tests/passkey-prf.test.mjs tests/recovery-page.test.mjs tests/demo-action.test.mjs tests/demo-sessions.test.mjs tests/demo-page.test.mjs tests/demo-receipts.test.mjs
```

These 39 checks cover encoding, validation, worker loading/telemetry, recovery crypto, session handling, action validation, page gates and historical receipts. VM/WebAuthn stubs do not establish real browser/authenticator support or public-network acceptance. The separate TypeScript/full-circuit/LocalNet runners provide those stages' additional tests. Full upstream typechecking has three recorded pre-existing `scripts/constants.ts` errors; it is not a clean build claim.
