# AlgoZKAuth — phased implementation plan

Updated: 2026-10-20.

**Current decision:** the local desktop/TestNet POC passed. Production readiness and portable recovery remain conditional. [The integrated acceptance record](benchmarks/phase6-acceptance.testnet.json) contains 11/11 checks across ten confirmed action groups; [the feasibility report](docs/verifier-feasibility.md) defines what those results establish.

## Objective and implemented architecture

Demonstrate Google- and Slack-backed authorization of independent Algorand application wallets, with on-chain proof verification, exact action signatures, replay protection and recovery of the persistent identity salt.

- **Login providers:** Google, and Sign in with Slack as a second provider; Facebook Login is planned. Each has its own circuit, development key and deployment of the unchanged contracts, so no provider's signing keys or proofs work in another's wallets. Provider differences are data ([provider descriptors](src/phase3/oidc-providers.mjs), [circuit profiles](src/phase3/circuit-profile.mjs)); the circuit generator, contracts, server, scripts and page take a provider id. [Slack protocol and evidence](docs/slack-oidc.md).
- **Identity proof:** Circom/snarkjs Groth16 over BN254, using constrained RS256 JWT verification for each provider's token profile and the same twelve public signals.
- **Persistent identity:** SHA-256 commitment to canonical issuer, exact audience/subject and a stable random 256-bit salt. The subject is `sub` for Google and `team_id/sub` for Slack. Registry uniqueness is per commitment, not globally per Google or Slack account.
- **Session:** A browser-held ephemeral Ed25519 key is bound into the provider's signed nonce with network, randomness and a ten-minute maximum expiry.
- **Authorization:** The provider's pinned verifier LogicSig checks the proof in the same atomic group as the registry/wallet call. Wallet contracts check owner, audience/network, current provider-key/time policy, exact action signature and replay nonce.
- **Wallets:** One immutable `UserWallet` application account per enrolled commitment; each provider's `WalletRegistry` provides canonical discovery and atomic enrollment.
- **Recovery:** Browser-generated AES-256-GCM backup, mandatory random recovery secret with HKDF-SHA-256, optional WebAuthn PRF adapter, export/import and verified restoration before the interface permits enrollment.
- **Trust:** The registry creator is trusted to approve authentic Google and Slack signing keys; their origin is checked off-chain. A malicious administrator with the identity and salt could approve an attacker-controlled key and authorize that wallet. The integrated localhost prover sees token and plaintext salt, and the localhost server holds the Slack app's client secret; the private session signing key stays in the browser. No custodial salt-storage service is implemented. [Trust analysis and Sui comparison](docs/sui-comparison.md).

## Phase status

| Phase | Scope | Evidence-backed status |
| --- | --- | --- |
| 0 | Pinned upstream/tool baseline | Baseline reproduced; complete dependency/license/security review remains open |
| 1 | Custom Groth16 proof on LocalNet | Passed custom-proof and negative checks |
| 2 | Standalone verifier costs and TestNet submission | Technical checks passed; product cost targets remain open |
| 3 | Google JWT circuit, key policy and proving | Genuine Google/TestNet and synthetic Chrome proofs passed; browser/product performance gates remain open |
| 4 | Independent wallet enrollment and transfers | 46 LocalNet checks passed with two synthetic identities |
| 5 | Encrypted salt backup and portable recovery | Secret recovery passed in isolated processes, Chrome and Safari (other-browser, same Mac); operator-reported passkey unlock in Chrome; physical-device recovery remains open |
| 6 | Integrated Google/TestNet demo | Local scenario passed with two Google identities; a fresh-clone quickstart run passed with a new deployment; full portability gate remains open |
| Slack | Second login provider | Two genuine Slack identities enrolled TestNet wallets, transferred ALGO/ASA and were rejected at each other's wallets (9/11 acceptance checks); restore and fresh-session runs open |
| Providers | Provider-generic code: one circuit generator, `KeyRegistry` and generic scripts, server and page | Done 2026-10-20; regenerated circuits' R1CS and compiled contract bytecode are byte-identical to the published ones |
| Facebook | Third login provider, authorization code flow with PKCE | Planned below; no genuine token captured yet |
| Contract calls | General transactions through a temporary rekey to the session key | Designed below; not implemented |
| Key governance | 24-hour approval delay, guardian veto and renewal for the key registry | Implemented; LocalNet-tested; on TestNet, 13/13 disposable policy checks and 9/11 integrated Google acceptance checks with one identity |
| Service | Deployable stack and SDK for other dApps: api, prover, keysync, dev issuer, `zkauth` CLI, `@algozkauth/sdk` | Milestones 1–4 done: services, CLI, SDK, the compose `local` profile, the SDK demo app and a second example app ([architecture](docs/service-architecture.md), [API](services/api/openapi.yaml), [SDK](packages/sdk/README.md)). Browser end-to-end tests pass on the local stack, including recovery in a second browser profile and a passkey backup on a virtual PRF authenticator. Open: hosted shared wallet, sponsor-policy hardening, TestNet profile run with a real Google login |
| 7 | Security and production readiness | Not started; no MainNet readiness decision |

### Deferred manual checks

These need a person at a browser and were deferred on 2026-10-20. Each runs on the guardian-enabled TestNet deployment; record wallet IDs, browser/OS and the restore method used, then rerun `sh scripts/check-demo.sh`.

1. **Slack restore and fresh-session transfer** ([Slack](#additional-login-provider--slack)). In Chrome at `/demo/?provider=slack`, restore Slack wallet `774609491` from its backup (or enroll a new one and save its backup first), confirm it is rediscovered, then prove and transfer.
2. **Cross-browser passkey restore** ([Phase 5](#phase-5--implement-portable-salt-recovery)). In Safari, restore Google wallet `774619393` with the passkey instead of the secret.
3. **Second physical device** ([Phase 5](#phase-5--implement-portable-salt-recovery)). On another computer, clone the repository, copy `.env` and `.local/phase6/deployment*.json` from the deploying clone, run `docker compose run --rm --service-ports demo`, restore the wallet and transfer.

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
- [x] Demonstrate genuine Google proving inside the browser: Chrome 155 proved a genuine token single-threaded in 143.2 s and the server verified it; Task Manager showed a 3.6–3.8 GB tab footprint ([record](benchmarks/phase3-browser-google.json)).
- [ ] Measure peak browser memory programmatically, hosted key download and mobile behavior; submit a browser-generated proof on-chain.
- [ ] Accept or improve the compact ASCII token profile, proving latency and ten-minute-session margin.
- [x] Renew an approved fingerprint's interval through the 24-hour approval delay (key-governance registry; LocalNet-tested). Migration of wallets bound to an earlier key registry remains open.

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
- [ ] Demonstrate successful PRF enrollment/unlocking with a real authenticator, recorded by the page. Chrome first recorded `prf-unavailable`; on 2026-10-20 the operator reported a Chrome 155 passkey unlock that rediscovered wallet `774609302`, but the evidence does not record the unlock method. Automated API stubs are not compatibility evidence.
- [x] Restore in another browser and authorize a genuine Google/TestNet transfer from the original wallet: Safari 27 restored Chrome-enrolled wallet `774619393` from its wallet-bound file and secret and confirmed transfers under a second session key (2026-10-20, same Mac).
- [ ] Restore with a passkey in a browser other than the one that created it (for example, an iCloud Keychain passkey added in Chrome, used in Safari).
- [ ] Restore on a second physical device, then authorize a genuine Google/TestNet transfer from the original wallet.
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
- [x] Run the React demo from a fresh clone with `scripts/quickstart.sh`: new deployment, genuine Google sign-in, enrollment, ALGO/ASA transfers, replay rejection and session renewal.
- [ ] Complete the Phase 5 physical-device and successful PRF/browser compatibility gates. Actual external-storage availability is not covered by page stubs.

**Local acceptance passed, 2026-10-09:** 11/11 checks across ten groups; wallets `773944646` and `773945687`. Three proofs used on-chain were independently reverified; a fourth generated proof expired before use and counts only as a performance observation. Four local Node proofs took 124.751–130.697 seconds with 1,705–2,213 MiB sampled peak RSS. All 39 fast protocol/interface checks passed. Rejection/identity provenance relies on local records; confirmed positive actions are independently checked against public chain data.

**Fresh-clone quickstart run, 2026-10-13:** the maintainer cloned the repository, ran `scripts/quickstart.sh` with a new TestNet account and their existing Google OAuth client, and completed the React demo with one genuine Google identity. It deployed registry `774215797` and enrolled wallet `774216079`; the proofs took 127 and 126 seconds. The first session expired after enrollment, the ALGO transfer and the ASA opt-in. After renewal, a fresh session key authorized the ALGO and ASA transfers, and the node rejected the replayed action. All five confirmed actions were re-verified from public chain data with the showcase's verification code: Groth16 proof, TestNet, audience and owner bindings, session-key signature and session window, 7/7 checks each, under one owner commitment and two distinct session keys. The run's records stay in that clone's `.local/evidence/`. It is a single-identity run, not a repeat of the two-account acceptance. Since this run, the page will not start the full demo with under 90 seconds of session left.

**Full exit gate remains open:** fresh physical-device recovery has not been established. [POC report](docs/poc-report.md), [deployment](benchmarks/phase6-deployment.testnet.json), [policy checks](benchmarks/phase6-policy.testnet.json), [acceptance](benchmarks/phase6-acceptance.testnet.json).

## Additional login provider — Slack

**Goal:** Authorize wallets with Sign in with Slack without weakening the Google path or letting either provider's keys or proofs act for the other.

- [x] Generalize token checks, identity commitment and recovery over providers; Slack identities are `team_id/sub`.
- [x] Generate a Slack circuit for Slack's escaped JSON and five-minute tokens. Its session is bounded by `iat + 600`, not the token's `exp`.
- [x] Keep the Google circuit's R1CS byte-identical after the shared primitive changes.
- [x] Pass five Slack witness tests and complete a development setup.
- [x] Enroll a synthetic Slack identity and transfer ALGO on LocalNet with unchanged contracts. Reject replay, and reject Slack/Google proofs in each other's deployments.
- [x] Add Sign in with Slack to the demo: login window, server-side code exchange, separate deployment and records.
- [x] Capture a genuine Slack ID token, confirm the claim profile, escaping, header and lifetime, and prove it offline.
- [x] Handle PKCE-enabled Slack apps, which refuse localhost redirects, with a published https relay.
- [x] Deploy Slack on TestNet, complete a genuine Slack demo run and extend acceptance checking to Slack records: wallet `774125965`, 5/5 checks across four confirmed groups.
- [x] Second Slack identity with other-wallet owner rejection on TestNet.
- [ ] Restore a Slack backup to its existing wallet and transfer with a fresh session (the two pending acceptance checks).
- [ ] Disposable key/session-policy checks for the Slack registry.

[Slack protocol and evidence](docs/slack-oidc.md).

## Provider-generic code

**Goal:** Add a provider by adding data, not by copying code, without changing what Google and Slack deployments verify.

Done 2026-10-20. Provider names remain only where something really exists per provider: its descriptor and circuit profile, its generated circuit and artifacts, tests of its profile, and recorded evidence.

- [x] One descriptor per provider ([`oidc-providers.mjs`](src/phase3/oidc-providers.mjs)): issuers, JWKS, login flow (`in-page` or `code`), PKCE rule, optional workspace-scoped subject, session-expiry rule, `<PREFIX>_*` environment names and file locations. New providers use their id in every path; Google keeps its Phase 3–6 paths and Slack already matched the convention, so no artifact or record moved.
- [x] One circuit generator ([`write-jwt-circuit.mjs`](scripts/write-jwt-circuit.mjs)) driven by the [circuit profiles](src/phase3/circuit-profile.mjs), replacing the Google and Slack writers. The regenerated circuits differ only in comments; recompiled R1CS are byte-identical to `fixtures/phase3/google_jwt.r1cs` and `fixtures/slack/slack_jwt.r1cs`, so the published proving and verification keys are unchanged.
- [x] `GoogleKeyRegistry` → [`KeyRegistry`](contracts/key_registry.algo.ts) and `GoogleJwtAuthorization` → [`JwtAuthorization`](contracts/jwt_authorization.algo.ts); the inactive-key assertion reads `Key inactive`. `KeyRegistry`, `UserWallet` and `WalletRegistry` compile to bytecode identical to the committed clients, so existing TestNet deployments and the acceptance checker's code comparison are unaffected. The box prefix `gk:` is kept as the deployed layout.
- [x] Generic authorization code login ([`code-login.mjs`](src/phase6/code-login.mjs)) with Slack's PKCE endpoint and retry errors as data; demo callbacks at `/demo/<provider>/callback`; one [relay page](web/oauth-relay/index.html) published per provider at `/<provider>-callback/` (Slack's URL is unchanged).
- [x] Generic scripts taking a provider: `build-circuit.sh`, `check-login.mjs` and `prove-login.mjs` (genuine-token profile capture), `run-provider-localnet.sh` with [synthetic provider-shaped tokens](src/phase3/synthetic-token.mjs), deployment, demo server, acceptance, policy checks and the key guardian.
- [x] The page chooses its sign-in by login flow; in-page providers have an [adapter](web/app/src/logins.ts) (Google Identity Services).

**Checks:** 53/53 fast checks, 24/24 React checks (one with a third, code-flow provider the page has no code for), both builds; the generic path reproduced the saved genuine Slack token's witness; a server on the existing TestNet deployments served both providers' configuration and Slack's unchanged authorize request. LocalNet on 2026-10-20 with the renamed contracts: 12 key-registry policy tests, the Phase 3 gate with a synthetic proof, the wallet suite (46/46), the Slack suite (6/6, now `run-provider-localnet.sh slack`) and recovery passed. Their records were not kept, so `benchmarks/` still holds the earlier runs.

## Planned provider — Facebook Login

**Goal:** Authorize wallets with Facebook Login under the same isolation as Google and Slack: its own circuit, key registry, wallet registry and audience.

**Status: planned; nothing Facebook-specific is implemented.** The generic code above is the integration surface.

### Known from Facebook's published configuration (checked 2026-10-20)

- [OpenID configuration](https://www.facebook.com/.well-known/openid-configuration/): issuer `https://www.facebook.com`, RS256 only, `pairwise` subjects (a user's `sub` is specific to the app), JWKS at `https://www.facebook.com/.well-known/oauth/openid/jwks/`.
- The JWKS held two keys, each RSA-2048 with exponent `AQAB`, `alg: RS256`, `use: sig` and a 40-character `kid`, all within the current token checks and circuit header limits.
- Facebook documents an [OIDC authorization code flow with PKCE](https://developers.facebook.com/documentation/facebook-login/guides/advanced/oidc-token) for manually built web logins. The authorize endpoint is `https://www.facebook.com/v<version>/dialog/oauth` with `scope=openid`, `response_type=code`, `state`, a **required** `code_challenge` (S256 recommended) and a **required** `nonce`. The token endpoint is `https://graph.facebook.com/v<version>/oauth/access_token` with `client_id`, `redirect_uri`, `code_verifier` and `code`; the client secret is optional with PKCE, and the response carries `id_token`. That is the existing `code` flow with `pkce: "always"`, so the ID token stays on the local server, as for Slack.
- The token endpoint also answered a POST, with errors as an object (`{"error": {"message", "type", "code"}}`) rather than Slack's string. The generic exchange still rejects such a response, but it does not yet report Facebook's reason.

### Unknown until a genuine token is captured

- The claim set with only `openid` (the configuration also lists `name`, `picture`, `email` and others), whether `/` is escaped (Facebook serves JSON from PHP, which escapes by default), whether `typ` is present, `exp − iat` (the checks allow at most 7,200 s), `nbf`/`azp`, and the encoded sizes.
- **The main risk is size.** Each claim value must fit 255 signed bytes and the payload 896 encoded bytes. If Facebook includes a long `picture` URL or other profile claims, the token cannot fit the current circuit; it would need a claim kind the circuit skips with a larger capacity, or bigger caps, a new constraint count and possibly a larger power-of-tau. Decide after the capture.
- Whether Facebook accepts `http://localhost:8765/demo/facebook/callback` as a redirect (development-mode apps may allow localhost) or needs the https relay at `/facebook-callback/`.
- Which API version to pin, and whether discovery's `response_types_supported` (only `id_token` forms) affects the documented code flow.

### Steps

- [ ] Create a Facebook app with Facebook Login, register the callback or relay URL, and set `FACEBOOK_CLIENT_ID` (and `FACEBOOK_CLIENT_SECRET` or `FACEBOOK_REDIRECT_URI` if needed).
- [ ] Add the `facebook` descriptor: issuer, JWKS, `login.flow: "code"`, `pkce: "always"`, versioned authorize and token URLs, and `sessionWithinTokenExpiry` from the measured lifetime. Report Facebook's error object in the code exchange, and test the descriptor under stubs.
- [ ] Capture one genuine token with `check-login.mjs facebook`. Without a profile it records claim names, types, serialization and lengths in `benchmarks/facebook-token-profile.json`, never values or identifiers.
- [ ] Decide the token-profile question above. Then write the Facebook circuit profile and add the issuer to `src/phase5/recovery.mjs`.
- [ ] `build-circuit.sh facebook` with witness tests `tests/facebook-circuit-witness.test.mjs` (accept, escaping, issuer, missing/duplicate claims, window). Confirm the Google and Slack R1CS stay byte-identical.
- [ ] `setup-jwt-circuit.mjs facebook`; publish its artifacts in a new `fixtures/artifacts.json` release.
- [ ] Offline proof of the captured token (`prove-login.mjs facebook`), then `run-provider-localnet.sh facebook`: enrollment, transfer, replay and cross-provider rejection with the unchanged contracts.
- [ ] `deploy-demo.sh facebook` on TestNet with a guardian; publish the relay if needed; complete the demo with two genuine Facebook identities; run `check-demo.sh facebook`, `check-demo-policy.mjs facebook` and `key-guardian.sh status facebook`.
- [ ] Restore a Facebook backup to its original wallet with a fresh session.

**Exit gate:** two genuine Facebook identities enroll TestNet wallets, transfer ALGO/ASA and are rejected at each other's wallets and in the Google and Slack deployments; read-only acceptance passes; the Google and Slack circuits and contracts are unchanged.

## Planned capability — contract calls through a temporary rekey

**Goal:** Let a login-controlled wallet send any Algorand transaction from its own address, including smart-contract calls, application opt-ins, swaps and marketplace purchases, authorized by the same login proof and browser session key, without handing control to anyone else.

**Status: designed, not implemented.** Today's wallets can only send ALGO, opt in to an ASA and send an ASA ([`user_wallet.algo.ts`](contracts/user_wallet.algo.ts)). They are immutable, so this needs a new wallet version and registry, and users moving their funds across.

### Mechanism

The session public key that the proof already binds (signals 6–7) becomes the wallet address's authorizer for one atomic group, and only that group:

1. A new wallet method, `delegate(signals, proof)`, runs today's proof checks: the sender is the pinned Groth16 verifier LogicSig, and the owner commitment, audience, network and key-registry authorization window are valid.
2. It rekeys the wallet's own address to the session key's Algorand address with an inner transaction.
3. It requires a **later** transaction in the same group whose sender is the wallet address and whose `rekeyTo` is the wallet's own address, restoring control to the app.
4. The transactions between them have the wallet address as sender and are signed by the session key in the browser: WebCrypto Ed25519 over the standard transaction encoding. They can be any type the protocol allows.
5. If the rekey back is missing, or anything else in the group fails, the whole group fails and the rekey never happened.

This is the flash-rekey pattern of [ARC-58, Plugin-Based Account Abstraction](https://github.com/algorandfoundation/ARCs/pull/269) (draft): `arc58_rekeyTo(address, flash)` requires a later rekey back or `arc58_verifyAuthAddress()` in the same group. Its reference implementation also supports the app's own address as the controlled account, which is how these wallets hold funds.

| Group index | Transaction | Authorized by |
| --- | --- | --- |
| 0 | `delegate(signals, proof)` on the wallet app | Groth16 verifier LogicSig |
| 1–5 | LogicSig budget payments | Verifier LogicSig |
| 6 to last | The user's transactions from the wallet address; the last one rekeys the wallet back | Session key |

Algorand groups hold at most 16 transactions, so a delegated group carries up to 10 of the user's own, including the rekey back.

### Security model

- **Inside a delegated group, the session key controls the wallet like a private key.** It can call any contract, send everything, close holdings or the account, and set fees. Today's restriction to three transfer types, and the separate signed action digest, no longer apply. The user's approval is the session key's own signature on each transaction, which already commits to the whole group.
- **Outside one, it has no power.** The wallet is not normally rekeyed to it, and `delegate` requires a valid proof inside an approved key and session window. After the session expires, no delegated group can be formed.
- **Public proofs cannot be reused by others.** Proofs are visible on-chain, but a successful group needs session-key signatures for the wallet's transactions and its rekey back.
- **Replay** of a signed group is prevented by Algorand's transaction-ID uniqueness within validity windows, so delegated groups need no wallet nonce.
- **Guardrails to decide before implementation:** whether `delegate` should inspect the group and forbid close-to fields, rekeys of the wallet to any address other than the final rekey back, or transactions to non-allowlisted apps. A called app cannot spend from the wallet with its own inner transactions unless the session key signs a rekey of the wallet to that app within the group. Whether to allow that, as ARC-58 plugins do, is part of this decision. Spending limits or per-app permissions could reuse ARC-58's plugin permissions and allowances.
- The key-administrator trust assumption from Phase 3 is unchanged, but its consequence widens: a forged key approval would authorize any transaction from the wallet, not only the three transfer types.

### Fees, browser and dApps

- The wallet's own transactions can pay fees from its balance, including the pooled fees for the six verification transactions, about 0.02 ALGO today. A sponsor becomes optional.
- The demo would build the group: the delegated call and budget transactions, the dApp's transactions with the wallet as sender, then the rekey back. The review step would show the decoded group before the session key signs.
- A dApp would integrate as with any wallet that signs a list of transactions, within the 10-transaction limit above.

### ARC-58 alignment

1. **Wallet version 2 with `delegate`:** the smallest change, keeping today's proof checks and contract structure.
2. **An ARC-58 abstracted account with the login as its admin or a plugin:** compatible with ARC-58 tooling, plugins and escrows. `arc58_rekeyTo` is admin-only, and the shared verifier LogicSig cannot be one user's admin, so the proof checks would live in a per-user admin app or in a plugin that then rekeys to the session key. It costs more transactions and budget per group and tracks a draft standard.

Prototype option 1, with the delegation logic kept separable so it can move into an ARC-58 plugin if option 2 is chosen.

### Migration

Existing wallets cannot change. A version-2 registry maps the same identity commitment to a version-2 wallet, and users move ALGO and assets across with today's transfers. The old wallet's minimum balance, 0.1 ALGO plus 0.1 ALGO per opted-in asset, stays locked.

- [ ] Decide the guardrails above and choose between the two ARC-58 options.
- [ ] Implement wallet and registry version 2 with `delegate` and rekey-back enforcement; commit the compiled clients.
- [ ] LocalNet tests: a delegated group calls a sample contract and opts in to an application from the wallet address, and the wallet ends every successful group controlled by its app. Reject groups with no rekey back, a rekey back before `delegate`, an expired session, the wrong owner, audience or network, another wallet's proof, or wallet transactions signed by any other key.
- [ ] Measure group size, opcode budget and fees with the wallet paying its own fees.
- [ ] Sign standard Algorand transactions with the nonextractable browser session key, and review a decoded group in the demo before signing.
- [ ] Run a delegated contract call on TestNet and add it to the acceptance checks.
- [ ] Include the version-2 contracts and the delegation model in the Phase 7 security review.

**Exit gate:** on LocalNet and TestNet, a login-controlled wallet calls a contract from its own address in a group that also proves its identity, and every variant missing a valid proof, the session key's signatures or the rekey back fails as a whole.

## Key governance — approval delay and guardian

The key registry's creator alone approves provider signing keys, and an approved attacker key plus a user's salt would authorize that user's wallet. The registry now limits that authority without changing the wallets, circuits or verifier:

- **Bootstrap.** Until the creator calls `sealBootstrap`, keys register with immediate effect but none is valid. Deployment registers the provider's current JWKS keys and seals in the same run.
- **Approval delay.** After sealing, `registerKey` requires `validFrom` at least 24 hours ahead, and `renewKey` extends an interval only 24 hours after the request. The demo server registers newly published keys and renews keys within three days of expiry, so routine rotation needs no manual step when the provider publishes keys at least a day before use.
- **Guardian.** An account fixed at creation, distinct from the creator, can revoke a key, cancel a pending renewal or pause. It cannot approve, renew, retire, seal or resume. `sh scripts/key-guardian.sh status` alerts when a key that is or will become valid is not in the provider's live JWKS.

A compromised administrator must therefore stay unnoticed by the guardian for a day. The quickstart keeps the guardian's mnemonic beside the administrator's in `.env`, which shows the mechanism but not the separation; `KEY_GUARDIAN_ADDRESS` names a guardian held elsewhere. A key a provider starts using less than a day after publishing it blocks logins until it activates, and a wrongly revoked key cannot be re-registered in that registry. Deployments made before this change keep immediate approvals. LocalNet checks on 2026-10-20: 12 registry policy tests ([record](benchmarks/phase3-key-registry.localnet.json)); a block-clock test (`scripts/run-key-delay-localnet.sh`) that a delayed key and a renewal take effect once the delay passes; and reruns of the wallet (46/46 checks), recovery and Slack (6/6) suites against the new registry. Each wallet action now uses 24 more app opcodes (3,198 for enrollment, 2,991–3,003 for execution) with the same group size and fee. Those reruns' snapshots were not kept, so the recorded wallet, recovery and Slack benchmarks still describe the earlier registry.

TestNet on 2026-10-20, from a fresh clone of commit `9ffdab5`: the deployment created Google key registry `774608704` (wallet registry `774608706`) and Slack key registry `774608732` (wallet registry `774608735`), each with a guardian, registered the providers' live keys during bootstrap and sealed. `key-guardian.sh status` reported both sealed with every key active and published, and the demo server started against them. A disposable registry passed [13/13 policy checks](benchmarks/key-governance-policy.testnet.json) against Google's live keys, including rejection of a key activating inside the delay, a guardian revoking a pending key, a guardian pause and a refused guardian resume. The integrated demo then ran on these deployments with one Google and one Slack identity, proving with rapidsnark from genuine tokens in 8.5–10.4 s (Google) and 9.7 s (Slack). Google wallet `774619393` enrolled and transferred in Chrome 155; Safari 27 restored it and transferred under a fresh session key. Read-only acceptance passed 9/11 ([record](benchmarks/key-governance-acceptance.testnet.json)); the two open checks need a second Google identity. Slack wallet `774609491` enrolled, transferred and rejected a replay; its restore and renewal are not in the records.

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
