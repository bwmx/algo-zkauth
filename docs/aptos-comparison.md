# AlgoZKAuth compared with Aptos Keyless

Reviewed: 2026-10-12. This comparison describes AlgoZKAuth's implemented Algorand POC and Aptos Keyless as specified in its improvement proposals: [AIP-61](https://github.com/aptos-foundation/AIPs/blob/main/aips/aip-061-keyless-accounts.md) (accounts), [AIP-67](https://github.com/aptos-foundation/AIPs/blob/main/aips/aip-067-native-consensus-for-json-web-key-jwk.md) (JWK consensus), [AIP-75](https://github.com/aptos-foundation/AIPs/blob/main/aips/aip-075-prover-service-for-keyless-accounts.md) (prover service), [AIP-81](https://github.com/aptos-foundation/AIPs/blob/main/aips/aip-081-pepper-service-for-keyless-accounts.md) (pepper service) and [AIP-96](https://github.com/aptos-foundation/AIPs/blob/main/aips/aip-096-federated-keyless-accounts.md) (federated keyless). It is not a cross-chain security or performance audit, and no Aptos deployment was tested.

## Shared authorization pattern

Both designs follow the pattern described in [the Sui comparison](sui-comparison.md): a temporary signing key is committed into the OAuth nonce, a Groth16 proof over BN254 shows that the provider signed a token containing that nonce and the committed identity, and the temporary key signs the spending action. In both, a private blinding value (Aptos: *pepper*; here: *salt*) hides which OAuth account owns which on-chain account. Aptos implements this as a native account type verified by validators. This POC implements it with a LogicSig verifier and application wallets.

## Where the implementations differ

| Aspect | Aptos Keyless | This Algorand POC |
| --- | --- | --- |
| Authorization layer | Native keyless signature verified by validators | Groth16 verifier LogicSig plus wallet/registry app checks in a seven-transaction atomic group |
| Account identity | Address derived from the issuer and a Poseidon identity commitment to `uid_key`, `uid_val`, `aud` and pepper; known before any transaction | SHA-256 commitment to issuer, audience, `sub` and salt; the registry maps it to an app ID, so the address exists only after enrollment |
| User identifier | `sub` or `email` (`uid_key`) | `sub` for Google; `team_id/sub` for Slack |
| Blinding value | 256-bit pepper computed by a pepper service (AIP-81) | Random 32-byte salt generated in the browser |
| Persistence | Recomputed at each login; nothing for the user to keep | Encrypted backup file plus a separately kept recovery secret; optional passkey PRF slot |
| Session lifetime | Ephemeral key expiry up to `iat + exp_horizon`; the pepper service defaults to 10,000,000 seconds (about 116 days); one proof signs many transactions until then | At most ten minutes and within the token's own `iat`/`exp`; each new session needs a new proof of about two minutes |
| Signing-key authority | Validators fetch and quorum-certify provider JWKs (AIP-67); federated keyless lets an application owner publish JWKs (AIP-96) | One creator-controlled key registry per provider (the `KeyRegistry` contract); JWKS authenticity is checked off-chain |
| Proving | Aptos Labs prover service; it temporarily learns the user's identity and pepper (AIP-75) | Localhost Node prover; it sees the token and plaintext salt |
| Circuit-bug defence | "Training wheels": validators also require the prover's signature over each proof | None beyond the open Phase 7 review |
| Managing app disappears | Recovery service: governance can allow-list a recovery `aud` that may stand in for the committed `aud` | Not addressed; each wallet's audience hash is immutable |
| Several accounts per identity | SLIP-0010 derivation paths from one master pepper | A new salt produces a new commitment and wallet |

## Salt versus pepper

### What the value protects

AIP-61 states the property directly: if the pepper is revealed, "only privacy of the account is lost", but "if the pepper is lost, then access to the account is lost". Spending still requires a fresh provider-signed token bound to the attacker's own key, which the attacker cannot obtain without the user's OAuth account.

In this POC the first half needs a qualification. The [Sui comparison](sui-comparison.md#trust-and-privacy-differences) infers from the code that a malicious key administrator who knows a user's identity **and salt** could approve an attacker-controlled RSA key, mint matching claims and authorize that wallet. The salt is therefore a precondition for the POC's most serious trust risk, not only a privacy value. Aptos does not carry this risk for allow-listed providers, because no single party approves their keys.

### How Aptos keeps the pepper

AIP-81 avoids storing peppers at all. Its pepper service:

1. Verifies the request's JWT against current provider keys, and checks that the JWT nonce commits to the supplied ephemeral public key and an expiry inside the allowed horizon.
2. Evaluates a verifiable unpredictable function (VUF) over the canonical encoding of `(iss, uid_key, uid_val, aud)`. The reference implementation uses the Pinkas VUF; BLS over BLS12-381 is the listed alternative.
3. Hashes the result into a master pepper, optionally derives a per-account pepper with SLIP-0010, and returns it with the initial account address.

Because the output is deterministic, logging in again always recovers the same pepper, and the user keeps nothing. The service publishes its VUF public key so outputs can be checked. AIP-81 lists the costs:

- The service is a centralized single point of failure, mitigated by running several stateless deployments. A future threshold VUF run by validators is proposed but not specified.
- If the VUF private key is lost, every keyless account becomes inaccessible unless its pepper was cached locally.
- If the VUF private key leaks, the link between keyless accounts and OAuth identities is no longer private.

AIP-61 lists an oblivious pepper service, one that learns neither the identity nor the pepper, as a goal. As specified in AIP-81 the request carries the JWT, so the service sees who is asking. The AIP-75 prover also learns the identity and pepper.

### How this POC keeps the salt

- The browser generates a random 32-byte salt (`generateWalletSalt()` in [the recovery library](../src/phase5/recovery.mjs)). The commitment is SHA-256 over a domain string, the length-prefixed canonical issuer, audience and subject, and the salt ([protocol](phase3-protocol.md)).
- The salt persists only in an AES-256-GCM package whose data key is wrapped by a generated recovery secret and, optionally, a passkey PRF output. The interface requires export, import and successful restoration before proving or enrollment, and reseals after enrollment with the wallet binding ([recovery specification](phase5-recovery.md)).
- The localhost server receives the salt to compute the commitment and build the proof witness. No salt service exists.
- The earlier command-line runners use a separate `.local/wallet-salt.bin`.

### Trade-offs

| Property | Aptos pepper service | POC encrypted backup |
| --- | --- | --- |
| Recover with only the OAuth login | Yes, while the service and its key exist | No |
| User must keep | Nothing | Encrypted file and secret, or a usable passkey |
| Who can link identity and account | VUF key holder; prover service | Holders of the salt: the user and the local prover |
| Liveness dependency | Pepper service availability | The user's own backup storage |
| Worst single failure | VUF key loss affects every account whose pepper is not cached | One user's backup loss affects only that wallet |
| Effect of a leaked value | Privacy loss | Privacy loss, plus the precondition for a key-administrator takeover |
| Accounts per identity and app | Deterministic; more via derivation paths | Unlimited; registry uniqueness is per commitment |

## What adopting a pepper service would mean here

Aptos can centralize peppers because pepper knowledge does not grant spending power when provider keys are agreed by validators. In this POC, a pepper service run by the key administrator, or leaking to them, would hold every user's salt at once. Combined with the administrator's ability to approve keys, that is enough to take over any wallet. The same structural risk appears in Aptos federated keyless, where AIP-96 notes that users' security "could, in the worst case, be as good as the JWK publisher's security".

A deterministic pepper service is therefore not a drop-in improvement here. Reasonable options, in order of what they would require:

1. **Keep user-held salts (current).** No new trust, at the cost of backup UX. Successful passkey PRF unlocking and physical second-device recovery remain open Phase 5 gates.
2. **Harden key authority, then offer a pepper service.** Replace single-administrator approval with threshold approval and a public delay before a new key becomes active, so a forged key can be noticed and paused. Only then would a VUF/VRF pepper service, ideally threshold-evaluated across independent operators, reduce to a privacy and liveness dependency as on Aptos.
3. **Hybrid.** Use a pepper service by default but keep the encrypted backup as a cache. AIP-81 notes that a locally cached pepper survives VUF key loss. This keeps login-based recovery while limiting the service as a single point of failure.
4. **Passkey-derived salt.** Derive the salt from a synced passkey's PRF output instead of wrapping a random one. This removes the file but makes recovery depend on passkey sync and PRF support, which this POC has not yet demonstrated (`prf-unavailable` was recorded in Chrome).

Two Aptos mechanisms are worth considering independently of the salt decision:

- **Training wheels.** An Ed25519 signature from the prover over each proof and its public inputs, checked by the wallet with `ed25519verify`, would limit the impact of a circuit soundness bug while the circuit is unaudited. It adds a liveness dependency on the prover, and a compromised prover alone still cannot spend.
- **Longer session horizons.** The ten-minute session and two-minute proof dominate this POC's UX. Aptos decouples the ephemeral key's expiry from the token's `exp` and bounds it by a horizon after `iat`. Adopting this would change the circuit's time policy and needs its own review.

## What the evidence supports

This document compares published Aptos specifications with this repository's implementation. It does not establish compatibility with Aptos, equal security assumptions, or relative performance. No Aptos prover, pepper service or validator was exercised. The POC's own evidence and open gates are recorded in [the POC report](poc-report.md) and [PLAN.md](../PLAN.md).
