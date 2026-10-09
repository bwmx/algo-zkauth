# Phase 4: independent wallets and atomic enrollment

Status: **Phase 4 passed on LocalNet, 2026-10-08.** Two identities obtained different wallets and each transferred its own ALGO and ASA. All 46 recorded authorization, race, replay, rollback and policy checks passed, along with two canonical-encoding tests. This phase uses two synthetic RSA JWT identities through the **complete Phase 3 circuit and the same verification key**. It does not use the genuine Google token or modify the existing identity salt. Genuine Google compatibility was established in Phase 3; the integrated Google/TestNet wallet demonstration subsequently passed in Phase 6.

## Contracts and trust

`WalletRegistry` stores `w:` + the 32-byte identity commitment → wallet application ID in an eight-byte box. `lookup` returns zero for an absent commitment. Enrollment requires a valid JWT proof, current Google-key/time policy, and an Ed25519 action signature from the session key bound into that proof. It rejects an existing mapping. Funding, proof/signature verification, wallet creation, discovery insertion and the wallet's initial funding all happen in one atomic group. Competing enrollments can produce only one canonical wallet; a failed attempt rolls its payment back. Clients should discover before enrolling and rediscover after a race.

Each `UserWallet` has an immutable owner commitment, verifier address, audience, key-registry ID and creating registry ID. Its only mutable global value is its action nonce. Wallets are created by an inner call; a normal outer application creation cannot pretend to come from the registry. Client discovery must use the chosen trusted registry: someone else's registry can deploy a different wallet and does not establish canonical ownership in this one.

The proof-carrying `enroll` or `execute` transaction is signed directly by the pinned Groth16 LogicSig with `APP_OFFSET=0`. Public signals and proof occupy application arguments 1 and 2, exactly as the verifier expects. The asset-holding wallet checks that sender against its immutable verifier. It also checks the owner's commitment, audience and genesis hash, calls `GoogleKeyRegistry.assertAuthorizationWindow`, and verifies the action signature under the proof's session public key. Calling the Phase 3 gate, publishing a valid proof, or invoking an inner call from another application does not grant wallet authority.

The development setup, unaudited upstream verifier and key-administrator assumptions from [Phase 3](phase3-protocol.md) still apply. An administrator may pause, retire or revoke keys; there is no method to change an existing wallet's owner or policy. Application update/delete, opt-in and close-out routes have no approval method. Wallets have no local state; clearing local state cannot reset the global nonce or release assets. There is no ALGO/ASA close-out, wallet rekey, arbitrary inner call, or fee deduction from a wallet. This deliberately leaves its base minimum balance and permanent registry storage locked.

## Canonical action signatures

Standard Ed25519 signs `SHA256(preimage)` using AVM `ed25519verify_bare`, without the program-address prefix of `ed25519verify`. The preimage concatenates these fixed-width fields; integers are unsigned 64-bit big-endian:

| Order | Field | Bytes |
| --- | --- | ---: |
| 1 | ASCII `algorand-zklogin-action-v1` followed by a zero byte | 27 |
| 2 | Network genesis hash | 32 |
| 3 | Registry application ID | 8 |
| 4 | Wallet application ID | 8 |
| 5 | Identity commitment | 32 |
| 6 | Operation | 8 |
| 7 | Recipient's decoded address / public key | 32 |
| 8 | Asset ID | 8 |
| 9 | Amount in microALGO or asset base units | 8 |
| 10 | Action nonce | 8 |
| 11 | Session expiry from public signal 10 | 8 |

`src/phase4/action.mjs` is the off-chain encoder. A new Google session can authorize subsequent nonces for the same recovered identity; changing the session does not reset the wallet nonce.

| Operation | Canonical parameters |
| --- | --- |
| 0: enroll | Wallet ID zero, recipient = deposit payer, asset ID zero, amount = exact enrollment deposit, nonce zero |
| 1: ALGO transfer | Nonzero recipient, asset ID zero, positive amount |
| 2: ASA opt-in | Recipient = wallet address, positive asset ID, amount zero |
| 3: ASA transfer | Nonzero recipient, positive asset ID and amount |

Unknown operations and noncanonical unused fields fail. Execution compares the supplied nonce with wallet state, checks all authorization, then increments the nonce before the inner transfer. An insufficient balance, missing ASA opt-in, or other failed inner transaction rolls back the nonce, transfer and sponsor transaction. A submitted action can be retried after such a failure while its session remains valid. Successful actions cannot be replayed.

## Funding and resources

The deployer funds the registry's base account minimum of 100,000 µALGO. Each enrollment starts with a normally signed payment at group index 0, followed by the proof-carrying registry call at index 1 and five zero-value LogicSig budget payments. The payment has the exact deposit, expected payer/receiver, no rekey and no close remainder. The session signature includes the payer and deposit. Wallet execution must be at group index 0, followed by a sponsor payment and the five LogicSig budget payments. Extra group transactions cannot change the signed operation or bypass its authorization.

The compiled wallet has three global integers, three byte slots and no extra program pages. The per-enrollment deposit is **454,800 µALGO**:

| Purpose | µALGO |
| --- | ---: |
| Registry's creator minimum for each wallet: 100,000 + 3 × 28,500 + 3 × 50,000 | 335,500 |
| Discovery box: 2,500 + 400 × (34-byte name + 8-byte value) | 19,300 |
| Initial wallet balance / account minimum | 100,000 |

`enrollmentDeposit()` derives this from the compiled wallet's schema and page count, so a source change cannot silently retain the wrong funding amount. Additional transfers must leave the wallet at its account minimum. Every ASA opt-in adds a further 100,000 µALGO minimum, requiring a top-up when the wallet has no spare balance. The protocol formulas are documented in [Algorand storage](https://dev.algorand.co/concepts/smart-contracts/storage/overview/) and [accounts](https://dev.algorand.co/concepts/accounts/overview/).

All inner transaction fees are zero. `ensureBudget` obtains extra app budget using only pooled outer group fee credit. The sponsor's group payment supplies the transaction fees; it is separately signed and is not a session-key signing service. The confirmed groups allocate **20,000 µALGO (0.02 ALGO)** total fee, including margin; this is the tested allocation, not a claim about the minimum possible fee.

## Measured complete flows

[The recorded run](../benchmarks/phase4-wallets.localnet.json) created registry `27192`, key policy `27189` and wallets `27202` and `27217`. Both wallets ended at nonce 3 with 93 test asset units each after sending seven units; their ALGO transfers deducted exactly the signed amounts, with no wallet fee deductions. Discovery returned the original IDs. A concurrent enrollment created one wallet, and the losing group's deposit and creation state rolled back together.

| Flow | Outer / inner transactions | App opcodes, simulated | LogicSig opcodes, simulated | Argument bytes | Signed bytes | Total fee |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Enrollment | 7 / 8 | 3,174 | 78,378 | 742 | 4,217 | 20,000 µALGO |
| ALGO transfer | 7 / 7 | 2,967 | 78,378 | 774 | 4,250 | 20,000 µALGO |
| ASA opt-in / transfer | 7 / 7 | 2,979 | 78,378 | 774 | 4,259 | 20,000 µALGO |

The registry approval program is 1,859 bytes, the wallet 942 bytes and verifier LogicSig 1,691 bytes. Enrollment references two boxes; execution references one foreign policy box. Five inner calls provide additional app budget, alongside the policy call and creation/funding or transfer. All seven measured flows confirmed on the actual node, with no relaxed opcode budget or unsigned-transaction allowance. LocalNet confirmation times were 11–24 ms; they do not estimate TestNet latency.

The two full-circuit witnesses took 2.73 / 2.95 seconds and their single-thread Node proofs 123.25 / 122.99 seconds. The verification-key SHA-256 remains `0a4cb29e5cbebf57979c153fb9f277184ad68ae9d9117a34254a6a7892320d5d`, matching Phase 3's genuine Google/TestNet proof. The benchmark records Node v24.15.0, snarkjs 0.7.5, AlgoKit Utils 9.1.2, Algorand TypeScript 1.2.0-beta.26, AVM 11, the verifier commit and contract source digests.

The recorded `tsc --noEmit` check reported only the three existing upstream `scripts/constants.ts` typing errors; the Phase 4 contracts, generated clients and integration test introduce none. The runner includes an AlgoKit restart fallback and verifies ledger retention and restoration of the original clock override.

## Reproduce

The Phase 3 circuit, WASM, development proving key and verification key must already exist. Start the existing LocalNet, then run:

```bash
bash scripts/run-wallet-localnet.sh
```

The runner compiles the contracts, generates typed clients in the pinned upstream checkout, creates two fresh RSA JWT witnesses/proofs and retained development Ed25519 keys, independently verifies both proofs, and runs the complete wallet test. Private development artifacts stay in `.local/phase4/` with directory mode 700 and file mode 600. The root `.env` and `.local/wallet-salt.bin` are not read or changed. This command creates new LocalNet applications and a test ASA on each run; it never targets TestNet or MainNet.

The test submits negative groups to algod rather than relying only on mocks or relaxed simulations. The runner temporarily freezes the developer clock and uses harmless sponsor payments to advance it to precise boundaries. It simulates the full wallet action at ledger time `expiry - 1` and submits a rejection at exactly `expiry`. The second session starts one ledger second later; a shortened key interval still allows an active session whose expiry equals its retirement endpoint, and revocation then rejects that same valid proof. Phase 3's registry suite separately tests rejection of sessions extending beyond a key interval and future activation. These are synthetic tokens with times matching the LocalNet ledger, not current genuine Google logins.

The existing LocalNet clock was nearly two days behind wall time and advanced toward the present on each confirmed group; a ten-minute session could expire after only a few dozen development transactions. Controlled timestamps avoid confusing this local behavior with wallet failure. The runner restores a pre-existing offset in `finally`. If the node originally used its real clock, the API has no unset operation, so the runner restarts **only the existing AlgoKit algod container**, retains its ledger and verifies the override is absent. If the sandbox startup exits, it recovers with `algokit localnet start`. This briefly interrupts LocalNet access. The full command normally takes about five minutes, primarily proof generation.

Evidence is written only after all checks pass to `benchmarks/phase4-wallets.localnet.json`; proof timings are in `benchmarks/phase4-proofs.localnet.json`. Program/client artifacts can be regenerated with `bash scripts/build-wallets.sh`. The root contract and test sources are authoritative; runner copies are generated integration artifacts in the pinned checkout.

## Remaining phases

Subsequent Phases 5–6 implemented authenticated salt backups and the integrated Google/TestNet wallet flow. [The local Phase 6 acceptance](poc-report.md) passed with two genuine Google wallets, ALGO/ASA transfers, replay/owner isolation, and original-wallet secret restoration plus renewed-session transfers after Chrome reload. Successful PRF, other-browser and physical second-device recovery remain unverified. Chrome's measured 423.7-second browser proving time, browser memory, mobile support, production download costs, accepted performance/fee targets and independent security review remain open; the desktop Node-prover TestNet pass does not resolve them.
