# Algorand zkLogin feasibility report

Evidence reviewed: 2026-10-09.

**Decision: the local desktop/TestNet implementation is technically demonstrated. Production and portable-recovery feasibility remain conditional.** Two genuine Google identities enrolled independent application wallets, transferred ALGO/ASA and passed recorded actual-node replay/isolation rejection. Secret restoration after Chrome reload preserved an original wallet, and a fresh session key authorized further transfers. The full twelve-signal proof, policy, action signature and asset-transfer composition fits confirmed Algorand groups.

This decision covers the tested macOS/Chrome interface with a localhost Node prover. It does not establish asset safety, successful passkey recovery, physical-device portability, mobile support or acceptable product performance. [The POC report](poc-report.md) contains deployment IDs, operating instructions and the generated acceptance snapshot; [PLAN.md](../PLAN.md) tracks the remaining gates.

## Evidence and its limits

| Stage | Demonstrated | Scope and qualification |
| --- | --- | --- |
| Phases 0–2 | Nine upstream BN254 tests; seven custom-proof checks; one/two/seven-signal LocalNet confirmations and seven-signal TestNet confirmation | Synthetic circuits and development setup; standalone verifier sizing |
| Phase 3 | Genuine Google JWT proof independently verified and authorized on TestNet; five full-circuit witness tests; key-policy checks | Twelve-signal circuit and asset-free authorization gate |
| Phase 3 browser | Chrome 154 full proof independently verified by the server in 423.688 s | Synthetic token; localhost key loading; memory measurement unavailable |
| Phase 4 | Two wallets completed ALGO/ASA actions; 46 LocalNet checks passed | Synthetic RSA identities through the full JWT circuit and same verification key |
| Phase 5 | Deleted original client directory; a separate Node process restored the salt/original wallet and transferred funds | Synthetic identity and LocalNet, not a physical-device result |
| Phase 5 browser | Google-bound pre-enrollment backup/secret restore; a `prf-unavailable` attempt | Chrome 154 client-reported telemetry; no wallet transfer in this standalone page |
| Phase 6 | 11/11 local acceptance checks across ten confirmed groups, two Google wallets, same-device restore/renewal | Genuine Google logins with localhost Node proving; successful PRF/other-browser/physical-device tests remain open |

The [Phase 6 checker](../scripts/check-demo.mjs) independently retrieves historical blocks, reconstructs compressed genesis fields and requires exact transaction IDs, ordering and complete atomic-group membership. It pins deployed registry/wallet approval programs and their immutable policy; compares the 256-byte on-chain proof with locally retained public proof output; independently rechecks Groth16 and Ed25519 signatures; and verifies inner transfers, fees, discovery mappings, nonces and current balances. Three distinct proofs were used in the ten groups and independently reverified. A fourth generated proof expired before use and is only a performance observation.

Negative submissions have no confirmed block receipt. Replay/isolation and disposable key-policy rejection are sanitized local records of actual node errors mapped to contract assertions; the checker requires these records but does not independently replay the rejected submissions. Distinct Google identities are represented by private HMAC labels assigned after local token verification, not independent identity-provider attestation to a third-party auditor. Rejection checks recorded target nonce/balance preservation; they are not a separate audit of every possible state field.

Opcode counts and inner-count measurements below come from simulations of the submitted groups. Fees, proof/action bytes and intended transfers were checked against confirmed transactions. Timings are observations from one environment, not service-level guarantees. Browser timings/user agents are client-reported. Node RSS is sampled process memory, not browser peak memory.

## Source and environment provenance

- Verifier: `joe-p/snarkjs-algorand` commit `3a970c7fb47efadd60c0b09a3200e8428ac47df2`, package 0.14.0; its pinned README calls the SDK unstable and the code unaudited.
- Reused RSA arithmetic: `zkemail/zk-jwt` commit `3a50a9bb80020a5bf7964881dcf70286e22037ab`; custom strict parsing, hashing and bindings are supplied by this project. No independent audit is established.
- Recorded tools: Circom 2.2.3, snarkjs 0.7.5, pnpm 10.33.0, AlgoKit 2.10.2; Phase 4 records AlgoKit Utils 9.1.2, Algorand TypeScript 1.2.0-beta.26 and AVM 11.
- Phases 1–2 ran with Node 26.5.0; Phase 3–6 full-circuit measurements used Node v24.15.0 on macOS/arm64. The actual browser records identify Chrome 154 on macOS.
- Standalone LocalNet/TestNet records identify consensus specification `268b63433a907455d439995bf916f6b296018f4f`. Protocol budgets are separate from the compiled program's AVM version.

The 39 fast protocol/interface checks passed on 2026-10-09. These include Node VM/WebAuthn stubs and do not establish additional browser/authenticator compatibility. Full TypeScript checking previously reported three upstream `scripts/constants.ts` errors (`snarkjs.curves` typing and two implicit `any` parameters), with none in the POC additions. Passing targeted tests does not imply a clean upstream typecheck. [Build and test runbook](development.md).

## Standalone verifier baseline

The [LocalNet benchmark](../benchmarks/results.localnet.json) uses matching one-, two- and seven-signal circuits/keys. Each proof passed independent snarkjs verification and confirmed in a seven-transaction group: one proof-carrying app call, a fee payment and five budget payments. Six transactions carry the verifier LogicSig; no verifier boxes or wallet calls are involved.

| Public signals | App-verifier cost, simulated | Main verifier LogicSig cost, simulated | LogicSig / app approval bytes | Combined app arguments | Signed group bytes | Total fee |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 76,206 | 76,196 | 987 / 1,076 | 294 | 2,954 | 7,000 µALGO |
| 2 | 76,403 | 76,393 | 1,051 / 1,140 | 326 | 3,050 | 7,000 µALGO |
| 7 | 77,388 | 77,378 | 1,371 / 1,460 | 486 | 3,530 | 7,000 µALGO |

The app-verifier cost was measured with an extra 320,000-opcode **simulation allowance**. The actual confirmed path uses pooled LogicSig verification without that override; the proof-carrying app itself consumed 30 app opcodes. The five additional budget LogicSigs each consumed three opcodes. Each standalone app increased its creator's minimum balance by 100,000 µALGO. Local confirmations took 11–16 ms and do not predict public-network latency.

The [seven-signal TestNet record](../benchmarks/results.testnet.json) identifies verifier app `773900229`, proof-carrying app `773900170` and confirmation round `68065117`. Its signed group was 3,558 bytes, fee 7,000 µALGO and confirmation time 4.893 seconds. An altered-signal group was rejected by the actual node. This baseline does not validate Google claims or wallet authorization; later phases supply that evidence.

## Full-circuit proving cost

[The protocol specification](phase3-protocol.md) defines the twelve signals and strict compact ASCII token profile. The complete JWT circuit has **2,726,377 constraints**, not the earlier 893,281-constraint sizing wrapper.

| Measurement | Recorded value |
| --- | ---: |
| Power-22 transcript download | 4,831,921,304 bytes |
| Development proving key | 1,425,797,992 bytes (1.426 GB / 1.328 GiB) |
| Circuit-specific setup | 660.814 s; sampled peak RSS 3,163,357,184 bytes |
| Phase 3 genuine Google witness | 2.741 s |
| Phase 3 genuine Node proving, excluding witness | 129.636 s; sampled peak RSS 2,094,776,320 bytes |
| Phase 6 genuine proofs, four runs | 124.751–130.697 s; 1,705–2,213 MiB sampled peak Node RSS |
| Actual synthetic-token Chrome proof | 423.688 s: witness 8.418 s, key load 1.333 s, proving 413.936 s |

[Setup](../benchmarks/phase3-setup.json), [genuine witness](../benchmarks/phase3-witness.google.json), [genuine proof](../benchmarks/phase3-proof.google.json) and [integrated measurements](../benchmarks/phase6-acceptance.testnet.json) are distinct records. Integrated total time includes witness generation, proving and verification; Node RSS was sampled every 500 ms. A sampled maximum can miss a short-lived peak. GB uses decimal units; GiB/MiB use binary units.

The transcript matched its published Blake2b-512 digest and the circuit-specific setup applied one local contribution. This is **development setup**; digest validation and a local contribution are not a production ceremony. Earlier small synthetic fixtures use an upstream development transcript with no production provenance claim.

The default parallel Chrome worker failed with an array-buffer allocation error. Single-thread proving with 4 MiB key pages subsequently succeeded; [failure telemetry](../benchmarks/phase3-browser-failures.json) separately records a manual cancellation, which is not a resource failure. The [browser bundle's Node check](../benchmarks/phase3-browser-bundle.node.json) is useful regression evidence but did not execute a browser.

[The actual browser proof](../benchmarks/phase3-browser.json) used a synthetic token and the same verification key as the Google/TestNet proof. Browser memory is null/unmeasured; key loading was from localhost. The 423.688-second total excludes initial library/input loading, subsequent server verification and network confirmation. It leaves at most 176.312 seconds of a ten-minute session for other steps. Genuine Google proving inside Chrome, hosted key download and mobile behavior remain unverified. Phase 6's Google interface uses Node proving instead.

## Complete on-chain composition

The [Phase 3 authorization gate](../benchmarks/phase3-authorization.testnet.json) confirmed a genuine proof in round `68067071`, with registry `773904531` and gate `773904544`. It used seven outer transactions, one inner policy call, 78,378 LogicSig opcodes, 506 app opcodes and an 8,000 µALGO fee. It proves session authorization without an asset wallet.

[Phase 4](phase4-wallets.md) subsequently composed wallet enrollment and transfers on LocalNet. [Phase 6](poc-report.md) confirmed the same complete authorization design for two genuine Google identities on TestNet.

| Integrated TestNet action | Outer / inner transactions | App cost, simulated | LogicSig cost, simulated | Signed group bytes | Confirmed total fee |
| --- | ---: | ---: | ---: | ---: | ---: |
| Enrollment | 7 / 8 | 3,174 | 78,378 | 4,270 | 20,000 µALGO |
| ALGO transfer | 7 / 7 | 2,967 | 78,378 | 4,302 | 20,000 µALGO |
| ASA opt-in / transfer | 7 / 7 | 2,979 | 78,378 | 4,313 | 20,000 µALGO |

Phase 4 measured 742 combined app-argument bytes for enrollment and 774 for execution; compiled registry/wallet/verifier programs were 1,859 / 942 / 1,691 bytes. The full Google path performs proof verification in the **LogicSig**, while the registry/wallet and policy use app budget. Its 78,378 LogicSig cost must not be compared with a single app's 700-opcode base budget.

[Algorand's protocol parameters](https://dev.algorand.co/concepts/protocol/protocol-parameters/) specify 16 outer transactions per group, 20,000 base LogicSig cost per transaction, 700 base app cost per call and 2,048 standard combined app-argument bytes. Seven outer transactions and 774 arguments fit these tested base limits. Six LogicSig transactions provide nominal pooled capacity of 120,000; the measured complete group's 78,378 leaves 41,622 in that configuration. Larger-than-1,000-byte LogicSig programs use the protocol's additional-fee mechanism; being below its absolute size ceiling does not make them free. These comparisons explain the recorded fit, not guaranteed capacity for arbitrary future features. Actual confirmed groups are the decisive composition evidence.

The enrollment deposit is **454,800 µALGO**: 335,500 for the registry's wallet-creation/schema minimum, 19,300 for permanent discovery storage and 100,000 for the wallet account minimum. Registry base funding is separate; each ASA opt-in adds 100,000 µALGO to wallet minimum balance. Outer fees were sponsor-paid; inner fees were zero. The tested 0.02 ALGO complete-action fee includes margin and is not an optimized minimum. Enrollment confirmation took 3.915–4.906 seconds; execution 4.548–6.257 seconds in the integrated run.

## Recovery and operational findings

Twelve [recovery library/adapter/page checks](phase5-recovery.md) passed, including independent crypto interoperability and malformed/wrong-binding cases. The [isolated-process run](../benchmarks/phase5-recovery.localnet.json) restored the original salt/commitment, rediscovered wallet `27335`, and confirmed a 10,000 µALGO transfer in round `14806`; nonce advanced from 1 to 2. It used a synthetic identity on LocalNet and does not establish physical portability.

[Chrome telemetry](../benchmarks/phase5-browser.json) records genuine Google-bound secret restoration and `prf-unavailable`, with no successful PRF enrollment/unlock. Phase 6 adds original TestNet wallet restoration and transfers after Chrome reload on the same Mac. Other browsers and second physical devices remain unverified. Backup storage is manual; external availability is confirmed by the operator and tested by import/decryption, not independently guaranteed after device loss.

[Nine disposable TestNet policy checks](../benchmarks/phase6-policy.testnet.json) cover overlapping authenticated current Google keys, bounded session windows, expiry/future/overlong rejection, pause, retirement and permanent revocation. They did not force an actual Google-provider rotation. Existing fingerprint approval intervals cannot be extended; the seven-day demo policy needs a reviewed renewal/migration design for sustained use.

The local Node prover receives the Google token and plaintext salt. The browser retains the ephemeral signing key and backup-unlock secrets. Witness inputs are restricted local files, normally deleted on completion/failure; crashes can leave them behind. No privacy claim for a remotely hosted prover is established.

## Remaining feasibility gates

- Independent review of circuit soundness, verifier/encoding, wallet/registry authorization, key administration and recovery cryptography; resolution of findings against pinned deployed artifacts.
- Production trusted-setup provenance and operational governance, including signing-key renewal, monitoring and migrations.
- Accepted fee, proving-time, download, memory, token-profile and support targets. The narrow token parser excludes valid Unicode/larger Google profiles.
- Genuine Google browser proving and mobile/resource measurements if those environments are intended to be supported.
- Successful real-authenticator PRF recovery, other-browser and physical second-device recovery, with original-wallet authorization and external-backup retrieval after device loss.

The completed wallet integration resolves the early uncertainty about whether the real proof and wallet calls fit together. Remaining uncertainty concerns security, performance, supported token/device profiles and recovery portability. These gates remain open in [the plan](../PLAN.md).
