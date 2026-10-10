# Phase 3 — Google JWT proof and signing-key policy

Recorded: 2026-10-08. **The genuine Google proof confirmed on TestNet, and Chrome completed the full circuit with a synthetic token and independent server verification. Phase 3 remains conditional on accepted performance targets, browser memory and mobile requirements.** The authorization gate holds no assets; ownership, action signatures and transfers belong to Phase 4.

## Protocol v1

The Google nonce is unpadded Base64url of SHA-256 over the ASCII domain `algorand-zklogin-session-v1\0`, genesis hash (32 bytes), ephemeral Ed25519 public key (32 bytes), session expiry (unsigned 64-bit big-endian Unix seconds), and private randomness (32 bytes). The circuit reconstructs it and compares it with Google's signed nonce. The login page retains a nonextractable private key only in browser memory; closing it discards the key.

The identity commitment is SHA-256 over `algorand-zklogin-identity-v1\0`, three unsigned 16-bit big-endian length-prefixed strings (canonical issuer `https://accounts.google.com`, exact audience, exact case-sensitive `sub`), and a private 32-byte salt. Both accepted issuer spellings map to this canonical issuer. Different salts produce different commitments; this does not enforce one wallet per Google account. Preserve `.local/wallet-salt.bin` to retain this earlier local identity. Authenticated backups are implemented in Phases 5–6, but those browser flows do not automatically export this separate file.

Every 256-bit public value uses two 128-bit big-endian limbs, without field reduction. The twelve public signals are:

| Index | Value |
| --- | --- |
| 0–1 | Identity commitment, high then low |
| 2–3 | SHA-256 of RSA modulus, high then low |
| 4–5 | SHA-256 of OAuth audience, high then low |
| 6–7 | Ed25519 session public key, high then low |
| 8–9 | Algorand genesis hash, high then low |
| 10 | Session expiry |
| 11 | Not-before timestamp |

JWT, subject, salt, signature and nonce randomness remain private witness data. Public commitments/session metadata are visible in the authorization transaction.

## Constrained token profile

[The circuit](../circuits/google_jwt.circom) and [strict primitives](../circuits/strict_jwt_primitives.circom) constrain complete byte parsing, canonical unpadded Base64url including unused tail bits, SHA-256 padding/length, RSA-2048/65537 verification, header `alg=RS256` and `typ=JWT`, issuer, audience, subject, optional authorized party, time claims, nonce binding and commitment/key/audience hashes.

Header keys are `alg`, `kid`, `typ`. Allowed payload keys are `iss`, `azp`, `aud`, `sub`, `hd`, `email`, `email_verified`, `nonce`, `nbf`, `name`, `picture`, `given_name`, `family_name`, `iat`, `exp`, `jti`, `at_hash`, `auth_time`. Keys are unique and order-independent. Required claims are issuer, audience, subject, nonce, issued-at and expiry. Optional `azp` must equal audience. Issuer must be `accounts.google.com` or `https://accounts.google.com`; audience and subject are nonempty.

This deliberately narrow profile accepts compact flat JSON with unescaped printable ASCII strings of at most 255 bytes, canonical uint32 decimal time values and JSON boolean `email_verified`. Unknown keys, whitespace, escaped/Unicode strings, nested objects/arrays, duplicate keys and ambiguous numbers are rejected. Signed `header.payload` is at most 1,015 bytes; header capacity is 128 Base64url bytes, payload 896 (672 decoded bytes). The Phase 3 genuine token passed, and Phase 6 subsequently proved tokens from two Google identities. Other account profiles or future token formats may exceed these limits. The private RSA signature is a canonical 2048-bit integer normalized from the JWT's third segment by preflight; the circuit does not reconstruct that segment's textual encoding.

Token time policy requires `exp > iat`, `exp - iat <= 7200`, `iat >= 60`, and `iat < session expiry <= min(iat + 600, exp)`. The circuit exposes `notBefore = max(iat - 60, nbf)` (absent `nbf` means zero) and requires it to precede expiry. On every authorization, the registry checks `notBefore <= block time < session expiry`, a remaining lifetime of at most 600 seconds, and expiry no later than key retirement.

[The input builder](../src/phase3/google-circuit-input.mjs) separately verifies Google's signature and expected nonce before constructing private witness inputs. Preflight does not replace circuit or execution checks. Google documents its validation requirements in [ID token guidance](https://developers.google.com/identity/openid-connect/openid-connect#validatinganidtoken); this POC fetches its [official JWKS](https://www.googleapis.com/oauth2/v3/certs) over HTTPS.

## Key authority and execution path

[GoogleKeyRegistry](../contracts/google_key_registry.algo.ts) stores each modulus SHA-256 digest with activation/retirement times and permanent revocation. The immutable creator is the only policy administrator. The administrator must authenticate keys through Google's HTTPS JWKS and check RSA-2048/65537 and allowed algorithm before approval. The AVM cannot authenticate this HTTPS response; administrator trust is explicit. Google `kid` selects the modulus off-chain; on-chain policy uses its digest.

That trust affects asset authorization: a malicious administrator with the original identity and salt could approve an attacker-controlled RSA key, mint matching claims and prove a new attacker-held session. This is an inference from the implemented circuit and registry, not a tested exploit. The integrated localhost prover sees identity/token/salt. [The Sui comparison](sui-comparison.md#trust-and-privacy-differences) discusses the different key-authority model.

Different keys may overlap during rotation. Retirement only shortens an interval; revocation is permanent and a fingerprint cannot be overwritten/re-registered. Emergency pause blocks all keys; resume preserves other policy. This conservative POC cannot renew an existing fingerprint's interval. A long-running service needs a reviewed refresh/renewal mechanism or a new deployment rather than assuming Google rotates before approval expires.

[GoogleJwtAuthorization](../contracts/google_jwt_authorization.algo.ts) fixes audience, registry and verifier LogicSig at creation. The pinned verifier reads proof/signals from this same app call (`APP_OFFSET=0`). The gate requires that LogicSig sender, twelve signals, configured audience and current genesis hash, then makes a zero-fee inner registry call. The outer group supplies the foreign app, key box and pooled fee. Direct normal-sender bypass, update/delete and rekey routes are rejected. Cryptographic verification and current policy are both required in the same execution.

The gate proves a Google-bound session, not wallet ownership or an action signature. Proofs are reusable while sessions/keys remain active. The Phase 4 wallet implements owner, wallet, exact action and replay-nonce checks; Phase 6 demonstrated that asset path with genuine Google identities on TestNet.

## Provenance, measurements and evidence

RSA arithmetic comes from [zkemail/zk-jwt](https://github.com/zkemail/zk-jwt), pinned at `3a50a9bb80020a5bf7964881dcf70286e22037ab` with locked dependencies. It is unaudited. Its original claim extraction was insufficient; this project supplies the strict parser/hashes/bindings. The earlier 893,281-constraint wrapper was only a sizing exercise.

Circom 2.2.3 compiled the full BN254 circuit to **2,726,377 constraints** (2,358,987 nonlinear and 367,390 linear), 2,648,553 wires and twelve public inputs. R1CS is about 495 MiB; WASM about 11 MiB. Phase 3 Node measurements used v24.15.0 on macOS/arm64.

| Measurement | Recorded result |
| --- | ---: |
| Power-22 powers-of-tau download | 4,831,921,304 bytes |
| Development proving key | 1,425,797,992 bytes |
| Circuit-specific setup | 660.8 s; sampled peak RSS 3.16 GB |
| Genuine Google witness | 2.74 s; process RSS 710 MB |
| Genuine Google proof | 129.6 s; sampled peak RSS 2.09 GB |
| TestNet authorization group | 7 outer transactions, 1 inner registry call |
| TestNet total fee | 8,000 µALGO (0.008 ALGO) |
| TestNet LogicSig / app cost, simulated | 78,378 / 506 opcodes |
| TestNet signed group | 4,102 bytes |
| TestNet confirmation | 5.30 s in this run |

The powers-of-tau Blake2b-512 digest matched [snarkjs setup guidance](https://github.com/iden3/snarkjs). Circuit-specific setup applied one local contribution using unlogged OS randomness. This is **development setup, not a production ceremony**. [Setup evidence](../benchmarks/phase3-setup.json) records hashes, size and resources. Constraints, verifier and setup require independent review before production.

[Genuine witness](../benchmarks/phase3-witness.google.json), [proof](../benchmarks/phase3-proof.google.json) and [TestNet authorization](../benchmarks/phase3-authorization.testnet.json) are separate stages. The first two correctly report no on-chain submission by those commands. Authorization confirmed at round `68067071`, registry `773904531`, gate `773904544`. The node rejected altered identity signals and the same valid proof after key revocation; normal-sender bypass failed.

Five full-circuit witness tests cover modified signatures/bindings/padding, correctly signed wrong issuer/audience/nonce/time, duplicate/escaped/nested/ambiguous claims, issuer canonicalization and optional claim variants. An independent R1CS witness check passed. Nine registry tests cover authority, overlap/activation, retirement/revocation, pause/resume, time boundaries, rekey and immutable routes. The real-circuit LocalNet integration uses a synthetic RSA token bound to LocalNet; genuine Google confirmation is on TestNet.

## Browser and remaining gate

[The browser prototype](../web/phase3-prover/index.html) runs the full circuit in one worker using the same 1.43 GB key. The initial default parallel run failed in Chrome with `RangeError: Array buffer allocation failed` inside a computation worker's `setBuffer/allocBuffer`; [the failure record](../benchmarks/phase3-browser-failures.json) preserves a manually reported allocation failure without private data. That failure is evidence against the initial configuration, not a successful browser benchmark.

The corrected implementation explicitly uses snarkjs's single-thread prover inside the page worker, with circuit witness checks enabled. It streams the public proving key into pinned fastfile `bigMem` pages of 4 MiB, avoiding one giant contiguous download buffer. The page reports witness, key-loading and proof stages and permits cancellation. Failure telemetry saves only a stage and error category, excluding arbitrary error text/private witnesses.

The localhost server snapshots expected signals and the verification key under a random run identifier when input is fetched, so later fixture regeneration or session expiry cannot silently change the benchmark's verification context. It independently verifies the returned proof, saves per-stage timing, optional post-proof memory and browser version in `benchmarks/phase3-browser.json`, and records whether a genuine session is still active. A successful off-chain benchmark does not authorize an expired session on-chain. Post-proof memory is not a peak-memory measurement.

[The browser-bundle regression check](../scripts/check-browser-prover.mjs) executed the actual pinned browser library and revised worker under **Node**, generated the full twelve-signal proof, verified it independently, and observed zero nested workers. [Its separate record](../benchmarks/phase3-browser-bundle.node.json) reports 143.8 seconds total (witness 2.80 s, key loading 0.75 s, proving 140.24 s) and 1.37 GB peak sampled Node RSS. This is a library/resource regression check, **not actual Chrome evidence**. Loader tests cover page boundaries, incomplete/excessive downloads and private-data-free error reporting.

[The successful Chrome record](../benchmarks/phase3-browser.json) reports Chrome 154 on macOS, single-thread proving, twelve signals and independent server verification using the same verification-key SHA-256 as the genuine TestNet run. Total witness/key/proof time was **423.688 seconds (7 minutes 3.7 seconds)**: witness 8.418 s, key loading 1.333 s and proving 413.936 s. The token was synthetic; genuine Google proving in Chrome has not been exercised. The earlier memory-allocation failure and a manually cancelled run remain recorded separately; cancellation is not evidence of a compatibility failure.

Browser timings are client-reported and the proof is independently verified. `measuredMemoryBytes` is null: the browser memory API provided no measurement, so peak memory remains unknown. Key loading used localhost and excludes real download latency for the 1.43 GB key. The total excludes initial library/input loading and subsequent server verification or network confirmation. Against the ten-minute session policy, 423.688 seconds leaves at most **176.312 seconds** for those additional steps, login and user delays. This is evidence of desktop functionality with limited time margin, not accepted production performance. Mobile compatibility remains untested.

Remaining gates are accepted proving time/download/memory and fee targets, measured peak browser memory, mobile/device requirements and genuine Google proving inside the browser. The integrated Google interface uses a localhost Node prover. [Phase 4's complete wallet action path](phase4-wallets.md) now passes on LocalNet with two synthetic identities through this same circuit and verification key. The integrated genuine Google/TestNet wallet path subsequently passed in [Phase 6](poc-report.md). Phase 3's technical checks do not establish overall production feasibility.
