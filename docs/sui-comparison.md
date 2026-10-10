# AlgoZKAuth compared with Sui zkLogin

Reviewed: 2026-10-10. This comparison describes AlgoZKAuth's implemented Algorand POC and Sui's published design; it is not a cross-chain security or performance audit.

## Shared authorization pattern

Both designs bind a temporary signing key to an OAuth identity token through its signed nonce. A zero-knowledge proof establishes the identity/session relationship without publishing the raw token, and a separate ephemeral-key signature authorizes spending. Keeping the original identity salt allows a new login and proof to retain the original account. Sui documents this pattern in its [zkLogin overview](https://docs.sui.io/sui-stack/zklogin-integration); the POC's corresponding bindings are specified in [the Google proof protocol](phase3-protocol.md) and [wallet authorization](phase4-wallets.md).

The POC demonstrates this pattern through confirmed Google-backed Algorand wallet actions. It uses its own circuit, cryptographic encodings, development setup and application contracts. It is an independent Algorand implementation of OAuth-based ZK authorization, not a deployment of Sui's circuit or signature format.

## Where the implementations differ

| Aspect | Sui zkLogin | This Algorand POC |
| --- | --- | --- |
| Authorization layer | Native validator-verified zkLogin signature | Groth16 verifier LogicSig plus wallet/registry app checks in an atomic group |
| Account identity | Address computed directly from OAuth fields and salt | SHA-256 salted commitment discovers an app ID; the wallet address derives from that app ID |
| Ephemeral signature | Signs the Sui transaction | Ed25519 signs a domain-separated digest of the exact wallet action, including network, registry, wallet, asset, recipient, amount, nonce and expiry |
| Nonce encoding | Poseidon-based ephemeral-key/epoch/randomness binding | SHA-256 binding of session key, genesis hash, Unix expiry and randomness |
| Session lifetime | `max_epoch`; JWT `iat`/`exp` do not control transaction expiry | At most ten minutes, also constrained by JWT `iat`/`exp`, not-before and the approved key interval |
| Signing-key authority | Provider keys agreed through validator consensus | Creator-controlled `GoogleKeyRegistry`; authenticated JWKS retrieval occurs off-chain |
| Salt persistence | App chooses a persistence strategy; salt services are one option | Random 32-byte salt, encrypted file and separately saved recovery secret; optional PRF adapter |
| Proving | Hosted or self-hosted service | Localhost Node prover sees token/salt; genuine Google proofs measured at about two minutes |
| Supported identity providers | Multiple providers enabled by the Sui protocol | Google only, with a strict compact ASCII/RSA-2048 token profile |
| Setup and review | Published circuit audits and multi-party setup | Unaudited custom integration and development setup with one local contribution |

The Sui account/session/nonce/key-policy columns follow its [technical reference](https://docs.sui.io/sui-stack/zklogin-integration/zklogin); native authorization and supported providers follow its [overview](https://docs.sui.io/sui-stack/zklogin-integration). Salt/prover options are described in its [integration guide](https://docs.sui.io/sui-stack/zklogin-integration/integration-guide). Algorand implementation details are defined in the [protocol](phase3-protocol.md), [wallet](phase4-wallets.md), [recovery](phase5-recovery.md) and [POC report](poc-report.md).

## Account continuity and recovery

The shared invariant is preservation of the same OAuth identity/application and original salt across temporary session keys. In this POC, discovery also depends on the intended Algorand network and canonical registry. A different registry or new salt does not automatically reproduce the original wallet app/address.

Sui permits client-held or service-managed salt strategies; Mysten describes a master-seed-based service in its [salt-server architecture](https://www.sui.io/blog/zklogin-salt-server-architecture). Sui's integration guide uses a 16-byte salt; this POC uses 32 bytes and a different commitment construction. This is architectural alignment, not interchangeable recovery material.

The POC avoids a salt-storage service but requires the encrypted backup to remain retrievable and the recovery secret to be retained separately. Same-device Chrome secret recovery and original-wallet renewal passed. Successful PRF unlocking, another browser and a second physical device remain unverified. Restoring the salt does not replace access to the original Google account.

## Trust and privacy differences

The largest security-model difference is signing-key authority. Sui's published design relies on validator-agreed provider keys. The POC delegates key approval to one application creator. [The registry](../contracts/google_key_registry.algo.ts) checks that caller's authority and key intervals, but cannot authenticate Google's HTTPS JWKS itself.

**Inference from the implemented code:** a malicious key administrator who also knows the original identity and salt could approve an attacker-controlled RSA key, mint matching claims and prove them using a new attacker-held session key. [The circuit](../circuits/google_jwt.circom) proves a signature under the supplied modulus; the registry determines whether that modulus is trusted. The localhost prover already sees identity/token/salt, so its relationship to the key administrator matters. Correct action signatures prevent an ordinary relay from changing a legitimate action, but do not remove this key-approval trust assumption. A reviewed production authority model is therefore required; the POC does not establish Sui-equivalent security.

In either service-based proving design, the prover can learn the identity and salt supplied to it. Sui's [integration guide](https://docs.sui.io/sui-stack/zklogin-integration/integration-guide) exposes these inputs in the prover request; its [technical reference](https://docs.sui.io/sui-stack/zklogin-integration/zklogin) distinguishes public proof data from private claims. Here that exposure is to a local Node service, not a demonstrated privacy-preserving remote prover. A secret salt obscures the identity-to-wallet link; it does not hide public wallet activity.

## What the evidence supports

[Recorded TestNet acceptance](../benchmarks/phase6-acceptance.testnet.json) passed 11/11 checks across ten confirmed groups from two genuine Google identities. It demonstrates OAuth-bound proofs, independent wallet spending, recorded replay/isolation rejection and original-wallet secret restoration/session renewal on one Mac.

It does not establish wire compatibility with Sui, equal security assumptions, equivalent recovery UX, cross-device support or comparable performance. No matched Sui benchmark was run. The result supports technical feasibility of this authorization pattern using Algorand's existing LogicSig/application mechanisms. [Production and portability gates](../PLAN.md) remain open.
