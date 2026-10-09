# Phase 5: portable salt recovery

Status: **Library and local flows implemented; automated recovery and wallet-transfer checks passed. Chrome 154 secret recovery passed, including genuine Google original-wallet restoration and TestNet transfers in Phase 6. Successful passkey PRF unlocking and other-browser recovery remain open.** Chrome recorded `prf-unavailable`. The manual acceptance used one Mac; physical second-device portability is not established. The plan's full fresh-device Google/wallet/transfer exit gate remains open.

## What is recoverable

The persistent secret is a random 32-byte identity salt, independent of every ephemeral Ed25519 session key. Restore must recover that exact salt under the original issuer, OAuth audience and Google subject. A new salt would create a different commitment and cannot find the original wallet. Recovery never silently creates a new salt, Google identity, or wallet.

The shared [WebCrypto library](../src/phase5/recovery.mjs) runs in Node and browsers without storage or network imports. Its identity commitment matches the Phase 3 circuit byte for byte. The [PRF adapter](../src/phase5/passkey-prf.mjs) supplies optional local passkey unlocking; the random recovery-secret fallback is mandatory in every package.

## Package v1

The exported file is bounded to 16,384 UTF-8 bytes. It contains compact JSON with fixed field order; one final newline is allowed. Unknown fields, duplicate keys, alternative escapes, noncanonical base64url, reordered JSON, unsupported versions/algorithms, invalid dates, noncanonical uint64 IDs and duplicate slots are rejected. Import the exact exported file instead of reformatting it.

| Field | Content |
| --- | --- |
| `format`, `version` | `algorand-zklogin-recovery`, integer `1` |
| `header.packageId`, `createdAt` | Random 16-byte ID and canonical ISO timestamp |
| `header.identityScheme` | `algorand-zklogin-identity-v1` |
| `header.audienceHash`, `commitment` | SHA-256 audience and original identity commitment, each 32 bytes |
| `header.binding` | Stage, 32-byte network genesis hash, registry/wallet IDs as decimal uint64 strings, wallet address |
| `header.cipher`, `kdf` | `AES-256-GCM`, `HKDF-SHA-256` |
| `payload` | Random 12-byte IV; encrypted identity body and 128-bit authentication tag |
| `slots[0]` | Mandatory secret slot: kind, random 16-byte slot ID, random 32-byte KDF salt, 12-byte IV, 48-byte wrapped data key |
| Other slots | Up to four PRF slots, with the same wrapping fields plus RP hostname, credential ID and 32-byte PRF input |

The encrypted body contains only `{salt,issuer,audience,subject}`. No JWT, ephemeral private key, PRF output or recovery secret is included. The public header and passkey descriptors disclose wallet/commitment metadata and credential identifiers; this is encryption of identity secrets, not concealment of public wallet activity.

`stage: "pre-enrollment"` requires registry/wallet IDs `"0"` and a null address. It backs up the salt before enrollment. `stage: "wallet"` requires nonzero IDs and a 58-character Algorand address. After enrollment, explicitly reseal the same salt with the chain-verified wallet binding and verify/export the new file. The recovery page accepts only pre-enrollment test packages; it cannot mistake one for an existing wallet package.

The library checks address shape, not the Algorand SHA-512/256 checksum. Its caller must derive the app address with the Algorand SDK, query the registry by the recovered commitment, and verify immutable wallet owner, registry and policy state. The LocalNet test and integrated TestNet discovery perform these checks. **Do not take `expectedBinding` from the unverified package alone.** A product restore flow must pin the intended network/registry, authenticate the package, and validate discovered wallet ID/address against the chain before signing.

## Encryption and key derivation

Each export uses a random 32-byte data-encryption key. Each secret/PRF slot wraps that key using a separate nonextractable AES-256 key derived with HKDF-SHA-256, a fresh random KDF salt, and the domain-separated info string:

```text
algorand-zklogin-recovery-wrap-v1\0 + packageId + \0 + slotId + \0 + kind
```

The AES-GCM wrapping AAD is canonical JSON `{header,descriptor}`, where the descriptor contains every slot field except `wrappedKey`. The payload AAD is canonical JSON `{header,slots}`, including every wrapped ciphertext. This authenticates header metadata, the complete slot list, credential/RP bindings and encryption parameters. Removing an optional passkey slot invalidates payload authentication even when using the recovery secret. Every encryption receives a fresh 96-bit IV; every reseal generates a new data key.

`generateRecoverySecret()` generates 256 random bits and encodes `ZKR1:<43-character base64url>:<6-character checksum>`. The checksum is the first four bytes of SHA-256 over `algorand-zklogin-recovery-secret-v1\0 || secret`; it detects transcription errors, not forgery. A generated random secret is required, not a user-chosen password. HKDF extracts/expands existing high-entropy key material as specified in [RFC 5869](https://www.rfc-editor.org/info/rfc5869/). A future password mode would require a separately designed password KDF and versioned format.

After decryption the caller's verified issuer/audience/subject must match the encrypted identity. The salt must recompute the authenticated commitment. Wrong secrets, wrong PRF outputs, ciphertext/metadata damage, different accounts and wrong-wallet/network packages fail closed.

Crypto keys are nonextractable where possible and temporary byte buffers are cleared. JavaScript strings, copies and garbage collection cannot promise secure memory erasure. This implementation is a POC; using standard primitives and adversarial tests does not replace the independent cryptographic review in Phase 7.

## Passkeys and fallback

The adapter requests discoverable credentials and requires user verification. It does not infer support from browser names or a registration capability flag: after creation it performs an assertion and requires a 32-byte PRF result. Unlock checks credential ID, challenge, origin, RP ID hash, user presence and user verification. AEAD establishes whether the returned PRF material actually unwraps this package. This is local decryption, not server WebAuthn authentication; it does not verify an assertion signature or attestation and sends no PRF secret to the backend.

The [W3C PRF explainer](https://github.com/w3c/webauthn/blob/main/explainers/prf-extension.md) describes per-credential secret output and RP-scoped user-mediated evaluation. Creating a different passkey does not recreate an old key. Portability depends on the same credential and PRF material being available to the chosen browser/authenticator; it must be tested, not inferred from a successful Google login or ordinary passkey authentication. A `localhost` credential requires the `localhost` RP hostname on restore. A production domain needs its own tested credential setup.

If PRF is absent, the credential is missing, the operation is cancelled, or the hostname differs, use the exported file and saved recovery secret. Unsupported PRF never generates a replacement salt. A passkey cannot retrieve a lost backup file by itself.

| Environment | Secret restore | Actual PRF enrollment/restore | Portability evidence |
| --- | --- | --- | --- |
| Node 24, independent WebCrypto/Node crypto checks | Passed | API stubs only | Protocol tests, not authenticator evidence |
| Two isolated Node client processes, LocalNet | Passed | Not used | Original client directory deleted; original wallet transfer confirmed |
| Chrome 154 on the recorded Mac | Passed; setup verification, secret restore and original TestNet wallet transfer | `prf-unavailable` recorded; no successful enrollment/restore | Phase 6 Chrome reload restored Wallet A; same physical device |
| Other browser on the same Mac | Not tested | Not tested | Planned separate browser storage; same physical device |
| Second physical device/mobile | Not tested | Not tested | Full fresh-device exit gate remains open |

Browser-reported outcomes are saved in `benchmarks/phase5-browser.json` after actual use. Only timestamp, user agent, whitelisted outcome and scope flags are stored. Identity claims, salt, backup, secret and PRF output are excluded. These are client-reported results, not independent attestation or on-chain transfer evidence.

## Backup availability and setup completion

Keep the encrypted package outside the browser/device that owns the salt: copy it to separate storage or retain it with a reliable file backup. Save the recovery secret separately, such as in a password manager. The optional passkey must also be available where recovery is needed. The page's downloads are an export mechanism; a download event alone cannot prove external storage or durability. The operator confirms separate storage, then imports the actual exported file and successfully decrypts it before the page marks setup verified. Adding a passkey regenerates the package and resets this verification requirement.

The encrypted file may be retained in user-chosen cloud/offline storage. This POC provides manual retrieval using the file picker, not a custodial salt service or automatic remote discovery. Public/decentralized storage is not implemented. A salt surviving in another open tab does not count as recovery. Loss of every encrypted package copy, or loss of both the recovery secret and all usable PRF credentials, is unrecoverable in this design. Google login alone cannot repair that loss.

Unknown format versions fail closed. There is no legacy production package to migrate. The explicit `resealRecoveryPackage()` decrypts and verifies v1, retains the original identity/salt, and generates a new envelope with requested binding/secret/passkeys. Future migrations must implement and test a reader for the old version, verify restoration, preserve commitment, then export/verify the replacement. There is no silent version conversion. Rotating a secret/passkey cannot revoke old offline backup copies; protect or remove obsolete copies separately.

## Run the checks

With pinned dependencies and Phase 3 circuit artifacts present:

```bash
node --test tests/recovery.test.mjs tests/passkey-prf.test.mjs tests/recovery-page.test.mjs
bash scripts/run-recovery-localnet.sh
node --env-file=.env scripts/phase3-login-server.mjs
```

The LocalNet runner creates a new synthetic identity provider and client fixture under `.local/phase5/<run-id>/`. All directories are mode 700 and private files mode 600. The external encrypted package and separate secret survive removal of `original-device/`. A separate Node process obtains a new synthetic nonce-bound JWT, restores from those files, generates a new Ed25519 key and full twelve-signal proof, discovers the original wallet and transfers 10,000 µALGO. The wallet nonce was 1 before loss and becomes 2 after recovery. The complete JWT circuit and existing Phase 4 contracts verify the transaction. This process isolation is not physical-device or genuine-Google evidence.

The runner temporarily freezes LocalNet's developer timestamp for the two long proofs, restores the prior clock in `finally`, and may briefly restart the existing algod container without resetting its ledger. The runner gracefully stops the private network before restart; the recorded checks verified clock restoration and retention of the recovered wallet and both Phase 4 wallets. It never overwrites `.local/wallet-salt.bin`, the root Google capture, or genuine Google session material. The recorded `tsc --noEmit` check reported only the three pre-existing upstream `scripts/constants.ts` errors.

For manual browser testing, use [the recovery page](http://localhost:8765/recovery/). The existing Google Web client must allow `http://localhost:8765`; no new OAuth origin is needed. Sign in, create an isolated test backup, try the optional passkey, save the secret privately, download/import the file and restore it with the secret to verify setup. Then open the same URL in the other browser, sign into the same account, import that file and test both unlock methods when available. Compare the restored public commitment with the original. Keep the secret private and out of source control.

The standalone Phase 5 page uses a fresh Google nonce verified against Google's public signing key and returns verified claims to that same-origin tab. It does not save its token/claims to `.env` or benchmark files. The salt and PRF key remain in browser memory; encrypted export is the durable copy. It intentionally tests recovery before enrollment, without creating a wallet or spending funds. Phase 6 now connects this gate to real Google/TestNet enrollment/discovery/transfer. Its localhost Node prover receives the token and salt, with the separate privacy boundary described in [the POC report](poc-report.md). Actual physical fresh-device Google authorization remains required for the original Phase 5 exit gate.

Evidence: [automated LocalNet restore and transfer](../benchmarks/phase5-recovery.localnet.json), [Chrome secret recovery](../benchmarks/phase5-browser.json). Twelve Phase 5 library/adapter/page tests and thirteen related identity/session/token/action checks passed. The LocalNet run confirmed wallet `27335` under registry `27325`; the restored proof took 126.2 seconds and its transfer confirmed in round `14806`. Synthetic process tests, actual Google browser backup tests, and physical fresh-device authorization are distinct evidence scopes.

**Subsequent Phase 6 recovery evidence, 2026-10-09:** Account A reloaded Chrome, signed into the original Google account, imported and secret-restored its backup, and rediscovered TestNet wallet `773944646` at the original address. After renewal, a fresh session key authorized ALGO and ASA transfers in rounds `68096640` and `68096643`; nonce advanced from 3 to 5. Independent historical-block/proof/signature/state checks passed. The final wallet balance is 1.08 ALGO and 86 demo ASA units. [Acceptance evidence](../benchmarks/phase6-acceptance.testnet.json) marks this as same-Mac secret recovery; successful PRF, other-browser and physical second-device recovery remain unverified.
