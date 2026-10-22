# @bwmx/algo-zkauth-verify

Signs users in to a dApp's **backend** with their AlgoZKAuth wallet. The backend learns which wallet the user controls (and a stable, anonymous user id) without trusting the AlgoZKAuth service, the browser or the dApp's frontend: every claim is checked against a zero-knowledge proof and the chain, read from an algod node the backend chooses.

This is how Sui zkLogin and Aptos Keyless work as well: the proof is verified against on-chain state (their JWKs; here the KeyRegistry), not vouched for by a server.

## How a sign-in works

1. The backend issues a single-use nonce.
2. The frontend calls `session.createSignIn({ nonce })` (embedded SDK) or `wallet.createSignIn({ nonce })` (hosted wallet, where the user approves it). The session's Ed25519 key signs a short message naming the page's origin, the nonce, the app, the network and the wallet address. The result carries the session's Groth16 proof. The proof binds that session key to a Google login for this app and network, without revealing the login.
3. The backend calls `verifier.verify(signIn, { origin, nonce })`, which checks:

| # | Check | Against |
| --- | --- | --- |
| 1 | Origin, nonce, app, network and provider in the message | the backend's own values and pinned app settings |
| 2 | The proof's audience and network signals | the pinned app settings |
| 3 | The message's signature, by the session key named in the proof's public signals | the message as the verifier rebuilds it from its fields |
| 4 | The Groth16 proof | the pinned verification key (its SHA-256 is pinned too) |
| 5 | The proof's session window and the message's validity | the chain's clock (latest block timestamp) |
| 6 | The provider key that signed the login: registered, active, not revoked, registry sealed and not paused | the KeyRegistry on chain |
| 7 | The wallet for the proof's owner commitment | the WalletRegistry and the wallet's own state on chain |

What stays trusted:
- the login provider (Google signs the tokens);
- the circuit and its trusted setup;
- the algod node you point it at, as for any chain read.

## Usage

```ts
import { readFileSync } from "node:fs";
import { createNonce, createVerifier, SignInError } from "@bwmx/algo-zkauth-verify";

const verifier = createVerifier({
  algodUrl: "https://testnet-api.algonode.cloud",
  apps: JSON.parse(readFileSync("algozkauth-apps.json", "utf8")),   // pinned AppSettings, see below
  verificationKeys: { google: readFileSync("google_verification_key.json") },
});

app.get("/api/nonce", (req, res) => {
  const nonce = createNonce();
  saveNonce(nonce, { expiresIn: 300 });                 // yours: accept each nonce once
  res.json({ nonce });
});

app.post("/api/sign-in", async (req, res) => {
  const nonce = req.body?.fields?.nonce;
  if (!consumeNonce(nonce)) return res.status(400).json({ error: "wrong_nonce" });
  try {
    const who = await verifier.verify(req.body, { origin: "https://dapp.example", nonce });
    // who: { address, walletId, subject, app, provider, network, origin, statement, issuedAt, expiresAt }
    startYourSession(res, { subject: who.subject, address: who.address });
    res.json({ address: who.address });
  } catch (e) {
    if (e instanceof SignInError) return res.status(401).json({ error: e.code });
    throw e;
  }
});
```

And in the browser:

```ts
const { nonce } = await (await fetch("/api/nonce")).json();
const signIn = await session.createSignIn({ nonce, statement: "Sign in to Example" });   // or hostedWallet.createSignIn
await fetch("/api/sign-in", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signIn) });
```

[`examples/backend`](../../examples/backend/README.md) is a complete backend; the example dApp in [`examples/send-algo`](../../examples/send-algo) calls it from both pages.

## App settings to pin

`AppSettings` is one app's deployment: `{ app, network, genesisHash, provider, registryId, keyRegistryId, audienceHash, verifier, verificationKeySha256 }`.
- **Where the values come from:** `GET /v1/apps/:app/config` on the AlgoZKAuth service, which answers requests without an Origin, or the deployment records the `zkauth` CLI writes.
- **Reading them at start:** `fetchAppSettings(serviceUrl, app)` does this, but it trusts the service once. In production, check the values and keep them in your configuration.

**Which app to accept:**
- An **embedded** dApp (its own OAuth client, `createZkAuth({ app })`): your app.
- A dApp that uses the **hosted wallet** (`connectWallet`): the wallet's app. Its sign-ins name your page's origin, which the wallet takes from the browser rather than from your page.
- Pass both if your dApp offers both.

`verificationKeys[provider]` is that provider's `verification_key.json` file. Pass the file's bytes or text, not parsed JSON, so its SHA-256 can be checked against the pin. On the local stack these are `fixtures/phase3/verification_key.json` (Google) and `fixtures/slack/verification_key.json`.

## What `verify` returns

| Field | Meaning |
| --- | --- |
| `subject` | The wallet owner's identity commitment (base64url). It is stable for one user in one app, across sessions and devices that use the same backup, and reveals nothing about the login. Use it as the user id. |
| `address`, `walletId` | The wallet, or `null` if the user has not created it on chain yet (the subject is already final). |
| `expiresAt` | The end of the sign-in's validity (at most 10 minutes, the session's length). After verifying, issue your own session. |
| `origin`, `statement`, `nonce`, `issuedAt` | As signed. |

`verify` rejects with a `SignInError` whose `code` is one of the following.

| Code | Meaning |
| --- | --- |
| `malformed` | The sign-in isn't well formed |
| `unknown_app` | The sign-in is for an app you didn't pin |
| `wrong_origin` | The message names another site |
| `wrong_nonce` | The message answers another challenge |
| `wrong_network` | The message or proof is for another network or provider |
| `wrong_audience` | The proof is for another app's login |
| `bad_signature` | The session key didn't sign this message (it was changed, or the proof is from another session) |
| `invalid_proof` | The Groth16 proof is invalid |
| `expired` | The sign-in or its session expired, or the sign-in is older than `maxAgeSeconds` (default 300) |
| `not_yet_valid` | The sign-in is dated more than `clockToleranceSeconds` (default 30) ahead of chain time. A dev-mode LocalNet's clock stands still between transactions, so allow 600 there |
| `key_inactive` | The provider key isn't approved or active on chain |
| `registry_paused` | The guardian paused the key registry |
| `wallet_mismatch` | The message's address doesn't match the registry |
| `node_unavailable` | The algod node can't be reached, or is on another network |

## The signed message

The message is SIWE-like (EIP-4361) text, rebuilt from its fields on both sides ([`packages/protocol/src/sign-in.mjs`](../protocol/src/sign-in.mjs)). The session key signs `"algozkauth-sign-in-v1\0" || text`. Wallet actions are signed as a 32-byte digest under another domain, so a sign-in can never authorise a transaction, and a transaction signature can never be replayed as a sign-in.

```
https://dapp.example asks you to sign in with your AlgoZKAuth wallet:
7Z5PWO2C6LFNQFGHWKSK5H47IQP5OJW2M3HA2QPXTY3WTNP5NU2MHBW27M

Sign in to Example

Version: 1
Network: testnet
Genesis Hash: SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9_cOUJOiI
App: 1012
Provider: google
Nonce: 6Gs1OzNqZp0xB5tqZ9rAaE4sW3dQmHcy
Issued At: 2026-10-21T14:00:00.000Z
Expires At: 2026-10-21T14:05:00.000Z
```

## Groth16 on @noble/curves

The proof is checked with [`@noble/curves`](https://github.com/paulmillr/noble-curves) (MIT, pure JavaScript) rather than snarkjs, which is GPL-3.0. Points are checked to be on the curve, G2 points to be in the subgroup, and public signals to be canonical field elements. [`test/groth16.test.ts`](test/groth16.test.ts) checks it against snarkjs on the committed fixture proofs.

## Tests

```sh
npm run test:verify     # the Groth16 check against snarkjs (needs npm run setup for the reference)
npm run test:e2e:sdk    # real sign-ins against the local stack, and 15 tampered or misdirected ones
npm run test:e2e        # the example backend, from the embedded and the hosted example pages
```
