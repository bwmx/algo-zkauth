# AlgoZKAuth — phased implementation plan

Updated: 2026-10-10.

**Current decision:** the local desktop/TestNet POC passed. Production readiness and portable recovery remain conditional. [The integrated acceptance record](benchmarks/phase6-acceptance.testnet.json) contains 11/11 checks across ten confirmed action groups; [the feasibility report](docs/verifier-feasibility.md) defines what those results establish.

## Objective and implemented architecture

Demonstrate Google-backed authorization of independent Algorand application wallets, with on-chain proof verification, exact action signatures, replay protection and recovery of the persistent identity salt.

- **Identity proof:** Circom/snarkjs Groth16 over BN254, using constrained RS256 Google JWT verification and twelve public signals.
- **Persistent identity:** SHA-256 commitment to canonical issuer, exact audience/subject and a stable random 256-bit salt. Registry uniqueness is per commitment, not globally per Google account.
- **Session:** A browser-held ephemeral Ed25519 key is bound into Google's signed nonce with network, randomness and a ten-minute maximum expiry.
- **Authorization:** The pinned verifier LogicSig checks the proof in the same atomic group as the registry/wallet call. Wallet contracts check owner, audience/network, current Google-key/time policy, exact action signature and replay nonce.
- **Wallets:** One immutable `UserWallet` application account per enrolled commitment; `WalletRegistry` provides canonical discovery and atomic enrollment.
- **Recovery:** Browser-generated AES-256-GCM backup, mandatory random recovery secret with HKDF-SHA-256, optional WebAuthn PRF adapter, export/import and verified restoration before the interface permits enrollment.
- **Trust:** The registry creator is trusted to approve authentic Google signing keys; their origin is checked off-chain. A malicious administrator with the identity and salt could approve an attacker-controlled key and authorize that wallet. The integrated localhost prover sees token and plaintext salt; the private session signing key stays in the browser. No custodial salt-storage service is implemented. [Trust analysis and Sui comparison](docs/sui-comparison.md).

## Phase status

| Phase | Scope | Evidence-backed status |
| --- | --- | --- |
| 0 | Pinned upstream/tool baseline | Baseline reproduced; complete dependency/license/security review remains open |
| 1 | Custom Groth16 proof on LocalNet | Passed custom-proof and negative checks |
| 2 | Standalone verifier costs and TestNet submission | Technical checks passed; product cost targets remain open |
| 3 | Google JWT circuit, key policy and proving | Genuine Google/TestNet and synthetic Chrome proofs passed; browser/product performance gates remain open |
| 4 | Independent wallet enrollment and transfers | 46 LocalNet checks passed with two synthetic identities |
| 5 | Encrypted salt backup and portable recovery | Secret recovery passed in isolated processes and Chrome; successful PRF/other-browser/physical-device recovery remain open |
| 6 | Integrated Google/TestNet demo | Local scenario passed with two Google identities; full portability gate remains open |
| 7 | Security and production readiness | Not started; no MainNet readiness decision |

## Phase 0 — Establish the baseline

**Goal:** Pin source/tools and reproduce the existing BN254 verifier before adapting it.

- [x] Pin `snarkjs-algorand` commit `3a970c7fb47efadd60c0b09a3200e8428ac47df2` and dependency lockfile.
- [x] Verify the downloaded Circom 2.2.3 binary digest and reproduce the upstream BN254 suite: nine tests passed.
- [x] Record network/configuration and distinguish the upstream app-verifier measurement from the actual LogicSig execution path.
- [ ] Complete dependency/license review and independent security assessment. Source pinning and passing tests do not close this item.

**Evidence:** [Development runbook](docs/development.md), [feasibility report](docs/verifier-feasibility.md).

## Phase 1 — Verify a custom proof on LocalNet

**Goal:** Exercise circuit compilation, development setup, proof conversion and actual Algorand execution.

- [x] Build the two-public-signal square-chain circuit and automate fixtures.
- [x] Independently verify the proof with snarkjs and confirm the matching LocalNet group.
- [x] Check modified/missing/out-of-field signals, corrupted proof, malformed encoding and a genuinely different verification key at their applicable encoding/simulation boundaries.
- [x] Document field/point encoding, G2 coordinate ordering and public-signal order.

**Exit gate passed:** seven Phase 1 checks passed; valid proof confirmed. Encoding rejection and node/simulation rejection are recorded as different evidence types. [Circuit](circuits/square_chain_2.circom), [tests](tests/poc_phase1.test.ts).

## Phase 2 — Measure standalone verifier feasibility

**Goal:** Establish execution costs using matching circuits/keys rather than extrapolating from pairing cost.

- [x] Measure one, two and seven public signals on LocalNet, including opcodes, program/argument/group size, fees and minimum balance.
- [x] Confirm a valid seven-signal group on TestNet and record actual node rejection of altered signals.
- [x] Compare measured transactions with protocol limits and preserve sanitized machine-readable results.
- [x] Replace the provisional seven-signal sizing case with the actual twelve-signal Google path in Phases 3–6.
- [ ] Approve product fee, proving-time, memory and support targets.

**Technical gate passed:** standalone groups confirmed. The original wallet-composition uncertainty was subsequently resolved by complete LocalNet and TestNet actions. The cost/product decision remains conditional. [LocalNet record](benchmarks/results.localnet.json), [TestNet record](benchmarks/results.testnet.json).

## Phase 3 — Implement Google JWT proofs and key policy

**Goal:** Constrain the actual token signature, claims and identity/session bindings and enforce current key policy on-chain.

- [x] Specify commitment, nonce, twelve public signals, network/audience separation and session duration.
- [x] Pin reused RSA arithmetic and constrain strict token parsing, SHA-256, RS256 signature, issuer/audience/subject, nonce and time claims.
- [x] Pass five full-circuit witness tests and independently verify a genuine Google proof confirmed on TestNet.
- [x] Implement creator-controlled activation, overlap, retirement, permanent revocation and emergency pause; test policy and normal-sender bypass rejection.
- [x] Measure full-circuit setup/key size, Node proof resources and the actual synthetic-token Chrome proof.
- [ ] Demonstrate genuine Google proving inside the browser; measure peak browser memory, hosted key download and mobile behavior.
- [ ] Accept or improve the compact ASCII token profile, proving latency and ten-minute-session margin.
- [ ] Design reviewed renewal/migration for existing signing-key fingerprints after their approval interval.

**Technical gate passed; performance conditional:** 2,726,377 constraints, 1,425,797,992-byte proving key; the Phase 3 genuine Node proof took 129.636 seconds and the synthetic Chrome proof 423.688 seconds. The browser allocation failure was resolved for the single-thread configuration, not every browser/device. [Protocol and evidence](docs/phase3-protocol.md).

## Phase 4 — Create independent wallets

**Goal:** Compose proof verification, policy, action signature and asset transfer without authority or replay bypass.

- [x] Implement atomic enrollment, canonical commitment discovery and immutable wallet owner/policy.
- [x] Bind network, registry, wallet, owner, operation, recipient, asset, amount, nonce and expiry into the Ed25519 action digest.
- [x] Implement ALGO transfer, ASA opt-in/transfer and sponsor-paid fees.
- [x] Test isolation, competing enrollment, signed-field changes, replay, expiry boundaries, wrong network/wallet, rollback, funding failure and prohibited routes.
- [x] Measure complete groups and enrollment funding from the compiled schema.

**Exit gate passed on LocalNet:** wallets `27202` and `27217` independently transferred ALGO/ASA; all 46 recorded checks passed. Complete actions used seven outer transactions and a tested 0.02 ALGO group fee. Enrollment deposit was 0.4548 ALGO. [Wallet specification](docs/phase4-wallets.md), [benchmark](benchmarks/phase4-wallets.localnet.json).

## Phase 5 — Implement portable salt recovery

**Goal:** Preserve the original salt and wallet after loss of the original client.

- [x] Implement a versioned authenticated package, generated 256-bit secret, AES-256-GCM/HKDF wrapping and optional PRF adapter.
- [x] Test interoperability, wrong secrets/accounts/wallets/networks, metadata/ciphertext tampering, unsupported PRF stubs and explicit resealing.
- [x] Implement manual encrypted-file export/import and require secret restoration before interface setup completion.
- [x] Delete original test client files, restore in a separate Node process and authorize a transfer from the original LocalNet wallet with a fresh synthetic session.
- [x] Record genuine Google-bound Chrome backup/secret restoration and same-device original TestNet wallet recovery in Phase 6.
- [ ] Demonstrate successful PRF enrollment/unlocking with a real authenticator. Chrome recorded `prf-unavailable`; automated API stubs are not compatibility evidence.
- [ ] Restore in another browser and on a second physical device, then authorize a genuine Google/TestNet transfer from the original wallet.
- [ ] Validate external backup retrieval after total device loss; interface confirmation alone does not prove durability.

**Partial gate:** twelve recovery library/adapter/page tests passed; the isolated process recovered wallet `27335` and confirmed a transfer in round `14806`. Same-device Chrome secret recovery passed. The full fresh-device exit gate remains open. [Recovery specification](docs/phase5-recovery.md), [LocalNet evidence](benchmarks/phase5-recovery.localnet.json), [browser evidence](benchmarks/phase5-browser.json).

## Phase 6 — Integrate the TestNet demonstration

**Goal:** Demonstrate the complete Google-backed workflow and independently inspect confirmed transactions.

- [x] Build login, backup verification, proof generation, enrollment/discovery, balances, transfer and restore interface.
- [x] Enroll two genuine Google identities and confirm independent ALGO/ASA actions.
- [x] Record actual-node replay rejection and owner isolation in both directions.
- [x] Restore Account A after Chrome reload, discover its original wallet and confirm ALGO/ASA transfers under a fresh session key.
- [x] Verify nine key/session-policy checks in a disposable TestNet registry. This tests overlapping authenticated keys, not a forced Google-provider rotation.
- [x] Test missing/unverified-backup gating in the client module and measure complete-action resources.
- [x] Check historical blocks, complete atomic-group membership, exact IDs, deployed wallet/registry policy, proofs, action signatures, fees, transfers and wallet state.
- [ ] Complete the Phase 5 physical-device and successful PRF/browser compatibility gates. Actual external-storage availability is not covered by page stubs.

**Local acceptance passed, 2026-10-09:** 11/11 checks across ten groups; wallets `773944646` and `773945687`. Three proofs used on-chain were independently reverified; a fourth generated proof expired before use and counts only as a performance observation. Four local Node proofs took 124.751–130.697 seconds with 1,705–2,213 MiB sampled peak RSS. All 39 fast protocol/interface checks passed. Rejection/identity provenance relies on local records; confirmed positive actions are independently checked against public chain data.

**Full exit gate remains open:** fresh physical-device recovery has not been established. [POC report](docs/poc-report.md), [deployment](benchmarks/phase6-deployment.testnet.json), [policy checks](benchmarks/phase6-policy.testnet.json), [acceptance](benchmarks/phase6-acceptance.testnet.json).

## Phase 7 — Decide production readiness

**Goal:** Determine whether a reviewed implementation can safely become an asset-holding product. This phase has not started.

- [ ] Independently review circuit soundness, strict token handling, reused RSA arithmetic, verifier encoding, wallet/registry authorization and recovery cryptography.
- [ ] Resolve findings and repeat adversarial/integration checks against the exact intended deployed versions.
- [ ] Establish production Groth16 setup/contribution provenance for the final circuit.
- [ ] Review key-approval authority, renewal/migration, pause/revocation, contract immutability and recovery-package migrations.
- [ ] Decide whether proving remains local or moves elsewhere; assess privacy, token/salt handling, crash cleanup and deployment security for that model.
- [ ] Approve measured proving/download/memory, fee, token-profile, supported-browser/device and recovery targets.
- [ ] Complete physical-device recovery, operational monitoring, incident response, dependency maintenance and backup retrieval checks.
- [ ] Record an explicit production decision before any MainNet rollout.

**Exit gate:** reviewed security findings are resolved, setup/governance provenance is established and product/support/recovery targets are met. A local POC pass does not satisfy this gate.

## Evidence standards

Keep source revisions, commands, environments, hashes, passing/failing checks and sanitized measurements with each result. Distinguish synthetic from genuine tokens, simulation from confirmation, Node stubs from browser/authenticator execution, local recovery from physical portability, and technical demonstration from production approval. Preserve raw benchmark measurements; update conclusions when evidence changes. Do not mark an untested capability as passed.
