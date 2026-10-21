# Evidence tools

The tools that produced the recorded results in [`benchmarks/`](../benchmarks/), kept runnable. Phase 1–5 tools are historical: they reproduce what each phase measured, while the [service stack](../docs/service-architecture.md) is where new work goes. The [development runbook](../docs/development.md) has the prerequisites (pinned checkout, circuits, LocalNet, `.env`) for each command.

Every runner overwrites its record after a successful run, so preserve the published file first or restore it with `git checkout benchmarks/`. Commands run from the repository root.

| Directory | Contents |
| --- | --- |
| `evidence/` | Read-only TestNet acceptance of the integrated demo ([`check-demo.sh`](check-demo.sh), [`check-demo.mjs`](check-demo.mjs), [`receipts.mjs`](receipts.mjs)), the disposable key/session-policy check ([`check-demo-policy.mjs`](check-demo-policy.mjs), [`policy.ts`](policy.ts)) and the showcase data extractor ([`write-showcase-data.mjs`](write-showcase-data.mjs)) |
| [`verifier/`](verifier/) | Phases 1–2: the small custom verifier fixtures and their LocalNet and TestNet runs |
| [`phase3/`](phase3/) | Phase 3: the full-circuit authorization gate, genuine-token witness and proof, the local Google capture server and its pages ([`pages/login`](phase3/pages/login/index.html), the browser prover [`pages/prover`](phase3/pages/prover/index.html) and the Phase 5 recovery page [`pages/recovery`](phase3/pages/recovery/index.html)), and the browser-bundle check |
| [`login/`](login/) | Genuine-token capture for any provider: claim profile and offline proof |

The contract suites these runners copy into the pinned checkout live in [`tests/localnet/`](../tests/localnet/).

## Which command wrote each record

| Record in `benchmarks/` | Command |
| --- | --- |
| `results.localnet.json` | `bash evidence/verifier/run-localnet.sh` (regenerates the Phase 1 and one/seven-signal fixtures, then `tests/localnet/poc_phase1.test.ts` and `poc_benchmark.test.ts`) |
| `results.testnet.json` | `bash evidence/verifier/run-testnet.sh` (`tests/localnet/poc_testnet.test.ts`; needs `TESTNET_MNEMONIC`) |
| `phase3-setup.json`, `slack-setup.json` | `node --max-old-space-size=6000 scripts/build/setup-jwt-circuit.mjs google` (or `slack`) |
| `phase3-witness.synthetic.json` | `tests/circuits/google-circuit-witness.test.mjs`, run by `npm run build:circuit -- google` and by `node evidence/phase3/run-authorization-localnet.mjs` |
| `phase3-proof.synthetic.json` | `node --max-old-space-size=6000 evidence/phase3/prove-witness.mjs google`, run by `run-authorization-localnet.mjs` |
| `phase3-authorization.localnet.json` | `node evidence/phase3/run-authorization-localnet.mjs` (`tests/localnet/jwt_authorization.test.ts`) |
| `phase3-witness.google.json`, `phase3-proof.google.json`, `phase3-authorization.testnet.json` | `bash evidence/phase3/run-authorization-testnet.sh` after a capture with `node --env-file=.env evidence/phase3/login-server.mjs` (it runs `prepare-witness.mjs google`, `prove-witness.mjs google --genuine` and `jwt_authorization.test.ts` on TestNet) |
| `phase3-google-preflight.json` | No current command: the first commit's pre-witness check of the captured Google token (signature, issuer, audience, nonce, times). `prepare-witness.mjs` repeats those checks before every witness |
| `phase3-key-registry.localnet.json` | `npm run test:localnet:key-registry` (`tests/localnet/run-key-registry.sh`) |
| `phase3-browser.json` | The prover page of `evidence/phase3/login-server.mjs` (<http://localhost:8765/prover/>) with the synthetic input |
| `phase3-browser-google.json` | The same page with a genuine Google input (2026-10-20), kept beside the synthetic run |
| `phase3-browser-failures.json` | Failure reports from the same page |
| `phase3-browser-bundle.node.json` | `node --max-old-space-size=6000 evidence/phase3/check-browser-prover.mjs` |
| `phase4-proofs.localnet.json`, `phase4-wallets.localnet.json` | `npm run test:localnet:wallets` (`tests/localnet/prepare-wallet-proofs.mjs`, then `wallets.test.ts`) |
| `phase5-recovery.localnet.json` | `npm run test:localnet:recovery` (`tests/localnet/run-recovery-localnet.mjs`, `phase5-device.mjs`, `recovery-wallet.test.ts`) |
| `phase5-browser.json` | The recovery page of `evidence/phase3/login-server.mjs` (<http://localhost:8765/recovery/>) |
| `phase6-deployment.testnet.json`, `slack-deployment.testnet.json` | `sh scripts/demo/deploy-demo.sh [google\|slack]` (the legacy demo) |
| `phase6-demo.testnet.json`, `slack-demo.testnet.json` | The legacy demo server, `sh scripts/demo/start-demo.sh`, as sign-ins and actions happen |
| `phase6-acceptance.testnet.json`, `slack-acceptance.testnet.json` | `sh evidence/check-demo.sh [google\|slack]` (`npm run evidence:check`), which also updates the generated block in [the POC report](../docs/poc-report.md) |
| `phase6-policy.testnet.json` | `node --env-file=.env --import ./upstream/snarkjs-algorand/node_modules/tsx/dist/loader.mjs evidence/check-demo-policy.mjs` after `sh scripts/setup.sh` |
| `key-governance-policy.testnet.json` | The same policy check on 2026-10-20 against the guardian-enabled key registry, kept under this name beside the original run |
| `key-governance-acceptance.testnet.json` | `sh evidence/check-demo.sh` on the guardian-enabled deployments (2026-10-20), kept under this name beside the two-account acceptance |
| `slack-token-profile.json` | `node --env-file=.env evidence/login/check-login.mjs slack`; `evidence/login/prove-login.mjs slack` adds its `offlineProof` |
| `slack-proofs.localnet.json`, `slack-wallets.localnet.json` | `npm run test:localnet:slack` (`tests/localnet/run-provider-localnet.sh slack`) |

The legacy demo's runs and acceptance go to `benchmarks/` only on the maintainer's runs; the quickstart sets `DEMO_EVIDENCE_DIR=.local/evidence`. [`write-showcase-data.mjs`](write-showcase-data.mjs) (`npm run evidence:showcase`, also run by the showcase build) extracts `web/app/src/site/recorded-run.json` from the `phase6-*` records.
