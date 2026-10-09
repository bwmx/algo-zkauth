# Algorand zkLogin TestNet POC

The integrated Phase 6 local desktop/TestNet acceptance **passed on 2026-10-09; physical-device recovery remains unverified**. All eleven acceptance checks passed across ten independently inspected transaction groups from two genuine Google identities. Both wallets completed enrollment, ALGO and ASA transfers, replay rejection and owner isolation in both directions. Account A restored its saved secret backup after Chrome reload, rediscovered original wallet `773944646` with the same address, and a new session key authorized ALGO and ASA transfers. In that acceptance snapshot, Wallet A had nonce 5, 1.08 ALGO and 86 demo ASA units; Wallet B `773945687` had nonce 3, 1.09 ALGO and 93 demo ASA units. The local technical demonstration passed; the production and cross-device feasibility decision remains conditional. Successful passkey PRF unlocking, other-browser recovery and physical second-device recovery remain unverified. Chrome recorded an unsuccessful `prf-unavailable` attempt.

## Latest integrated acceptance

<!-- phase6-acceptance:start -->
Latest read-only acceptance: **passed-with-deferred-device-gate**, recorded 2026-10-09T12:15:25.831Z. 11/11 checks passed; 10 confirmed actions independently inspected. [Machine-readable result](../benchmarks/phase6-acceptance.testnet.json).

The local Google/TestNet scenario passed. Physical second-device recovery remains unverified.

| Account | Wallet app | Address | Nonce | Balance (µALGO) | Demo ASA units |
| --- | --- | --- | ---: | ---: | ---: |
| A | 773944646 | FB7OE6DEMJVNDRTBGWETJTX62SMTNOD7W24QBMPEE4VHXUD5YQLGRSVJAE | 5 | 1080000 | 86 |
| B | 773945687 | 43KJ7NJIVBPPWGRE6QIAM4DSBPN5UPBVXI727LY7F5FLDJZONPSETXP7OA | 3 | 1090000 | 93 |

Measured Phase 6 proofs:

- Account A: 127.3 s total, 2.8 s witness, 124.4 s proving; 1.98 GiB sampled peak Node RSS (v24.15.0, darwin/arm64).
- Account B: 126.3 s total, 2.7 s witness, 123.5 s proving; 1.68 GiB sampled peak Node RSS (v24.15.0, darwin/arm64).
- Account A: 124.8 s total, 2.7 s witness, 121.9 s proving; 1.66 GiB sampled peak Node RSS (v24.15.0, darwin/arm64).
- Account A: 130.7 s total, 2.7 s witness, 127.9 s proving; 2.16 GiB sampled peak Node RSS (v24.15.0, darwin/arm64).

<!-- phase6-acceptance:end -->

The checker verifies the configured TestNet genesis, deployed program bytes and immutable registry/wallet policy, canonical registry boxes, distinct private HMAC account labels from verified Google logins, complete confirmed atomic groups, independently verified Groth16 proofs and Ed25519 signatures decoded from the actual transactions, inner ALGO/ASA transfers, fees, wallet nonces and balances. It requires two confirmed session keys for an original wallet and restoration followed by a transfer from that wallet. Replay/isolation rejection is supported by sanitized local records of actual-node errors; rejected submissions have no confirmed block receipts and are not independently resubmitted by this checker. The ten groups used three distinct authorization proofs, independently reverified by the acceptance checker. A fourth successfully generated proof expired before being used for a transfer and is included only in performance measurements. Private HMAC labels establish distinct identities within this local run; this is locally recorded acceptance evidence rather than independent identity-provider attestation for a third-party auditor.

Pending acceptance exits with code 2; a validation failure exits with code 1. A passing local scenario is recorded as `passed-with-deferred-device-gate`. This status covers the local scenario only. Physical-device recovery and the separate Phase 7 security/production-readiness gate remain open.

## TestNet deployment and policy evidence

| Component | ID or value |
| --- | --- |
| Network | `testnet-v1.0` |
| Google key registry | `773914034` |
| Wallet registry | `773914036` |
| Demo ASA | `773914042`, zero decimals |
| Disposable policy-test registry | `773914468` |
| Verification-key SHA-256 | `0a4cb29e5cbebf57979c153fb9f277184ad68ae9d9117a34254a6a7892320d5d` |
| Enrollment deposit | 454,800 µALGO per wallet |
| Tested complete-action group fee | 20,000 µALGO, paid by the local sponsor |
| One-time demo funding | 1 test ALGO and 100 demo ASA units per wallet |

[Deployment evidence](../benchmarks/phase6-deployment.testnet.json) is the initial deployment snapshot: it records the pinned verifier address, sponsor and two Google signing-key fingerprints approved at deployment. Its `fundedDemoWallets: false` describes that pre-enrollment snapshot; later wallet funding is recorded in the demo/acceptance evidence. [Nine policy checks](../benchmarks/phase6-policy.testnet.json) passed against a separate disposable TestNet registry: overlapping current keys, an active bounded window, rejection of expiry/future activation/overlong sessions, pause, retirement preserving an overlapping key, revocation and rejection of re-registration of a revoked fingerprint. Rejected groups were sent to the actual node and classified by mapped contract assertions. These tests did not force Google to rotate its own signing keys or revoke a demo wallet's main registry.

## Start and repeat the demo

Use the existing pinned dependencies and full Phase 3 circuit artifacts. Configure only local `TESTNET_MNEMONIC` (25-word TestNet sponsor) and `GOOGLE_CLIENT_ID` in the ignored root `.env`. The Google OAuth Web client must allow JavaScript origin `http://localhost:8765`. The integrated page obtains its own fresh nonce-bound token; a saved `GOOGLE_ID_TOKEN` is not used. Port 8765 must be free of the earlier Phase 3 login server.

```sh
sh scripts/deploy-demo.sh
sh scripts/start-demo.sh
```

Deployment reuses the recorded `.local/phase6/deployment.json` and refuses mismatched sponsor, audience, genesis or verifier. The deployment script requires at least five spendable test ALGO before initial deployment; additional demo funding and action fees also come from that sponsor. Automatic funding is capped at four wallet IDs. Do not delete this deployment record to get fresh funding. The demo runs on localhost and uses a local Node process for the full proof. On a fresh checkout without the private deployment record, deployment creates new IDs; the published IDs are evidence of the recorded run, not automatically reused configuration.

1. Open [the integrated page](http://localhost:8765/demo/) in Chrome and sign in with Account A. Create a salt/backup, or import its previously exported Phase 5 pre-enrollment backup. Save the generated secret privately and separately from the encrypted file. Download, import and restore the exact file using the secret and confirm independent storage before proving/enrollment.
2. Click **Generate local proof**, then **Run ALGO / ASA demo**. The run enrolls or discovers the canonical wallet, funds it once, transfers 10,000 µALGO, opts into the demo ASA, seeds 100 units, transfers 7 units and checks actual node replay rejection. Download the updated wallet-bound backup after enrollment.
3. Open a separate tab with Account B. Complete the same sequence after Account A's proof finishes; the local prover runs one proof at a time. This run also presents Account B's proof to Wallet A with Wallet A's current nonce and requires rejection at the owner assertion without changing its nonce or balance.
4. Test original-wallet restore and renewal using Account A's saved file/secret: reload its page, sign in with Account A, import and restore the wallet-bound backup, then generate a fresh proof. Confirm the original app ID/address and use the transfer form to send 10,000 µALGO to the default sponsor. The fresh login generates a different session key while the salt and wallet stay the same. This reload test does not count as a second physical device.
5. Run the read-only acceptance checker. It updates the machine-readable record and this report's acceptance block. It retrieves historical blocks from the public Algod node and reconstructs compressed genesis fields before requiring exact recorded transaction IDs, order and complete atomic-group membership. This avoids the recent-transaction endpoint's 1,000-round receipt window. The provider must still serve these historical blocks; preserve the generated acceptance evidence when successful.

If step 3 is disabled, read the message beside **Generate local proof**. It identifies the unfinished login, download, separate-storage confirmation, import or secret-restoration step. Selecting an encrypted file alone does not verify restoration. Errors appear near the top of the page. Complete these steps in the current tab; preserve the exported backup and secret before any reload.

```sh
sh scripts/check-demo.sh
```

The checker also needs the original local public proof results and private identity-audit labels; sanitized benchmarks and public chain data alone are insufficient to reconstruct the recorded login/proof provenance on a fresh checkout. The optional passkey control is available, with recovery-secret fallback. Chrome recorded `prf-unavailable`; successful PRF, other-browser and physical-device recovery remain unverified. A renewed Google login requires a fresh full proof. Repeating the demo does not refill an existing wallet: ALGO/ASA funding is one-time, existing ASA opt-in is skipped, and successful transfers advance its nonce. Retain the original salt/backup. If backup setup consumes much of the ten-minute session, renew after verification and before generating the proof. Keep the salt in the tab or restore its saved backup; never create a new salt to recover an existing wallet.

## Trust, privacy and recovery boundaries

- The browser generates a nonextractable ephemeral Ed25519 signing key and signs only a canonical action matching the displayed network, registry, wallet, owner, operation, recipient, asset, amount, nonce and expiry. The signing key stays in the tab. The on-chain wallet independently checks the proof, current key/session policy, exact action signature and replay nonce.
- Phase 6 proving occurs on the local machine. The page sends the Google token and plaintext salt to the localhost server; they are not kept solely in browser memory. JWT/session/salt state is private, and the prover briefly writes a private witness input and witness under `.local/phase6/jobs/` with restricted permissions. The worker removes those inputs on completion or failure. A hard process/machine crash can leave files to delete manually. This design is not a privacy claim for a remote hosted prover.
- The local server knows Google identity and salt. Identity tags are HMACed with a private local audit key; sanitized benchmark events use Account A/B labels, wallet IDs, transaction IDs and measurements. They contain no raw JWT, subject, salt, recovery secret, PRF output, mnemonic or private signing key. Transaction proofs and public commitments remain public on Algorand.
- Encrypted backup creation/decryption and the recovery secret/PRF stay in the browser. No salt-storage service is provided. Keep the encrypted file retrievable outside the original browser/device and keep its secret separately. Losing every backup copy, or both the secret and usable authenticators, prevents restoration. A missing/unverified backup blocks proof generation in the interface. The server requires the client's `backupVerified` flag; the chain does not verify backup existence or durable external storage.
- The registry is unique per salted identity commitment. The same Google account with a newly generated salt can create another commitment/wallet. Account identity alone cannot reconstruct a lost salt or locate the original wallet.
- Google remains the issuer. The local sponsor controls Google-key approval and authenticates current JWKS over HTTPS. The POC approves keys for seven days and supports bounded retirement, overlap, pause and permanent revocation. An existing fingerprint's interval cannot be extended; continued use past its approval interval requires a reviewed renewal/migration design. Offline Google/JWKS, the local prover, RPC or unavailable recovery files can prevent login/authorization.

## Measured performance and remaining decision

Eleven new Phase 6 session/action/page/historical-receipt tests and twelve recovery tests passed. The page tests execute the actual client module with Node VM protocol stubs; they do not establish browser or public-network compatibility. Session tests verify challenge single-use, nonce/key binding, preservation of identity across renewal and secret-state expiry. Action tests compare browser/contract bytes and reject changed server fields before signing. Three historical-receipt regression tests cover genesis reconstruction, exact IDs and retained inner execution data, foreign rounds/networks, missing/reordered/partial groups and distinct group IDs. Actual Chrome/Google/TestNet evidence comes from the acceptance run above.

Account A's initial integrated proof took 127.346 s / 2,027 MiB sampled peak Node RSS; Account B's took 126.319 s / 1,721 MiB. After restore, Account A generated a 124.751 s / 1,705 MiB proof, then renewed its expired session and used a 130.697 s / 2,213 MiB proof for the confirmed transfers. All four runs used Chrome 154 with the local Node v24.15.0 prover on macOS/arm64. RSS was sampled every 500 ms and can miss short-lived peaks; it is not a browser-memory measurement. TestNet confirmations took 3.915–4.906 s for enrollment and 4.548–6.257 s for execution. Each confirmed complete action group charged 20,000 µALGO. Simulation of those same groups measured 7 outer / 8 enrollment or 7 execution inner transactions, 3,174 enrollment or 2,967–2,979 execution app opcodes and 78,378 LogicSig opcodes. The signed group sizes were 4,270 bytes for enrollment, 4,302 for ALGO and 4,313 for ASA actions. Simulation budget consumption and observed confirmation timings are distinct from independently checked confirmed fees/transfers. These measurements cover the two Google accounts on the recorded macOS host; broader environment targets remain open.

Earlier evidence remains separate: [Phase 3](phase3-protocol.md) confirmed a genuine Google proof on TestNet using the full 2,726,377-constraint circuit. Genuine Node proving took 129.6 seconds with about 2.09 GB peak RSS; the development proving key is 1.43 GB. Chrome 154 completed a synthetic-token full proof in 423.7 seconds using a single worker. Phase 6 uses Node proving to leave more of the ten-minute session for transactions.

[Phase 4](phase4-wallets.md) passed 46 LocalNet checks with two synthetic identities, including complete wallet authorization, ALGO/ASA transfers, competing enrollment, signed-field changes, wrong network/wallet, failed-transfer rollback and prohibited application routes. Its resource measurements match the integrated TestNet group simulations above. [Phase 5](phase5-recovery.md) proved original-wallet restoration/transfer in a new Node process with a synthetic identity and a genuine Google-bound Chrome pre-enrollment secret restore; Phase 6 now adds genuine Google secret restoration and original-wallet transfers after Chrome reload on the same Mac. Successful PRF, other-browser and physical-device recovery remain unverified.

The current POC has unaudited custom circuits/contracts/adapters and a development Groth16 setup. The strict compact ASCII JWT profile and signed-byte limit exclude some valid Google tokens, including Unicode/large profiles. Mobile memory, genuine Google proving inside the browser, hosted download costs, production setup/governance, support targets and asset-safety review remain unresolved. The local integrated TestNet scenario passed, supporting technical POC feasibility on this desktop with a localhost Node prover. Cross-device/PRF portability and the production decision remain conditional. Phase 7 is a separate security and production-readiness decision.
