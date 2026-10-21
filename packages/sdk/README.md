# @algozkauth/sdk

Sign users in with Google (or another OpenID provider) and give each one an Algorand wallet they control with
that login. No seed phrase, no extension. You write `sendAlgo`; the SDK handles the zero-knowledge part.

```ts
const zk = createZkAuth({ service: "https://auth.example.com", app: "my-dapp" });
const session = await zk.signIn();                       // Google button
const { file, secret } = await session.backup.create();  // once per user: save both
const wallet = await session.wallet();
await wallet.sendAlgo({ to: "ADDR…", amount: algo("0.5") });
```

You do not need to know what a proof is. In short: the user's browser holds a one-session signing key; the
service checks the login and produces a proof tying that key to the user's wallet; the wallet contract
checks the proof and the key's signature on every action. Fees and the wallet's minimum-balance deposit are
paid by the service's sponsor, so a new wallet needs no ALGO to be created.

Two ways to integrate: **embedded** (`createZkAuth`, below: your page holds the session and each user gets a
wallet for your dApp) or **hosted** ([`connectWallet`](#hosted-shared-wallet): the AlgoZKAuth Wallet holds it in
its own window and each user has one wallet across every dApp that connects).

Contents: [Quickstart](#five-minute-quickstart) · [React](#react) · [Hosted wallet](#hosted-shared-wallet) · [Concepts](#three-things-to-know) ·
[API](#api-reference) · [Errors](#errors) · [Login UI and proving](#customising) · [Security](#security-notes) ·
[Testing](#testing-your-dapp)

## Five-minute quickstart

**1. Install.** The package is a workspace package of this repository (`@algozkauth/sdk`); in a monorepo add
`"@algozkauth/sdk": "0.1.0"` to your `dependencies`. It ships TypeScript sources, so use a bundler (Vite, Next,
webpack). Dependencies: `@algozkauth/protocol` only. `react` is optional.

**2. Register your app with the service.** An app is an entry in the service's `apps.json`
(`$ZKAUTH_STATE_DIR/apps.json`, see [docs/service-architecture.md](../../docs/service-architecture.md)):

```json
{ "id": "my-dapp", "provider": "google", "clientId": "123.apps.googleusercontent.com",
  "allowedOrigins": ["https://my-dapp.example", "http://localhost:5173"] }
```

`clientId` is a Google OAuth *Web* client whose "Authorized JavaScript origins" include the same origins. The
service rejects any origin not in `allowedOrigins`. With the [`zkauth` CLI](../../tools/cli/README.md):

```sh
zkauth apps add my-dapp --provider google --client-id 123.apps.googleusercontent.com --origin https://my-dapp.example
zkauth deploy app my-dapp        # its wallet registry, on the provider's shared key registry; then restart the api
```

The compose local stack (`docker compose --profile local up`) already registers `demo` (origin
`http://localhost:8765`), `example` (`http://localhost:8775`) and the hosted `wallet`, with a development login
issuer in place of Google.

**3. Sign in.** Call `signIn()` from a click handler.

```ts
import { createZkAuth, algo, downloadBackup } from "@algozkauth/sdk";

const zk = createZkAuth({ service: "http://localhost:8780", app: "my-dapp" });
zk.config();                          // optional: warm the config so a code-flow pop-up opens inside your click

signInButton.onclick = async () => {
  const session = await zk.signIn();  // shows Google's button in a small modal; resolves when the user is in
  console.log(session.identity.subject);
};
```

To place Google's own button yourself: `zk.signIn(undefined, { button: document.getElementById("login")! })`.

**4. Back up (first time) or restore (returning user).** The wallet is derived from the login *and* a random
salt that exists only in the user's backup file. Lose the file and the secret and nobody, including you, can
find the wallet again. So a session has no wallet until it has a salt.

```ts
// New user
const backup = await session.backup.create();   // { file: Blob, fileName, secret: "ZKR1:…", passkey }
downloadBackup(backup);                          // the encrypted file
showToUser(backup.secret);                       // the recovery secret: store it SEPARATELY from the file

// Returning user (on any device)
await session.backup.restore(fileFromInput, { secret });     // or { passkey: true }
```

**5. Use the wallet.**

```ts
const wallet = await session.wallet();
await wallet.enroll();                            // creates the on-chain wallet; the service sponsor pays
console.log(wallet.address);                      // fund this address with ALGO
await wallet.waitForFunds({ microAlgos: 1_000_000n });

const { txId, explorerUrl } = await wallet.sendAlgo({ to: recipient, amount: algo("0.25") });
await wallet.optIn(31566704);                     // asset ids: number or bigint
await wallet.sendAsset({ assetId: 31566704, to: recipient, amount: 5n });
const { microAlgos, spendable, assets } = await wallet.balance();
```

`sendAlgo`, `optIn` and `sendAsset` enroll the wallet automatically if needed, request the proof once per
session, ask the service for an action plan, check that the plan is exactly what you asked for, sign it in the
browser and wait for confirmation. Calls on one wallet run one at a time, so you can fire several without
nonce clashes. After enrollment, `session.backup.needsExport` becomes true: call `session.backup.export()` and
offer the user the updated file (the earlier file still works).

## React

```tsx
import { ZkAuthProvider, useSession, useWallet } from "@algozkauth/sdk/react";

<ZkAuthProvider service="http://localhost:8780" app="my-dapp">
  <App />
</ZkAuthProvider>

function App() {
  const { session, status, signIn, expiring, renew } = useSession();
  const { wallet, balance, address, busy, error, enroll, sendAlgo } = useWallet({ pollMs: 15_000 });

  if (!session) return <button onClick={() => signIn()}>Sign in</button>;
  if (!wallet) return <button onClick={async () => downloadBackup(await session.backup.create())}>Create wallet</button>;
  return (
    <>
      {expiring && <button onClick={() => renew()}>Session ending: stay signed in</button>}
      <p>{address ?? "Not enrolled yet"} · {balance && formatAlgo(balance.microAlgos)}</p>
      <button disabled={busy !== "idle"} onClick={() => sendAlgo({ to, amount: algo("1") })}>
        {busy === "proving" ? "Proving…" : "Send 1 ALGO"}
      </button>
      {error && <p role="alert">{error.message}</p>}
    </>
  );
}
```

- `ZkAuthProvider` takes the same options as `createZkAuth` (or `zk={existingClient}`).
- `useZkAuth()` → `{ zk, config, session, status: "signed-out" | "signing-in" | "signed-in", error, signIn, signOut }`.
- `useSession()` → the above plus `expiring`, `expired`, `secondsLeft`, `renewing`, `renew()`.
- `useWallet({ pollMs? })` → `{ wallet, balance, address, enrolled, loading, busy, progress, error, refresh, enroll, sendAlgo, optIn, sendAsset, history }`.
  `wallet` is `null` until the session has a salt. Action functions also reject, so `await` them when you need the result; `error` mirrors the last failure. The balance refreshes after every action.

## Hosted shared wallet

The dApp holds no session, salt or key and needs no registration with the service: it connects to the hosted
AlgoZKAuth Wallet (`apps/wallet` in this repository; `http://localhost:8770` on the local stack), which opens in its
own window. The user signs in, opens their backup and approves every connection and action there.

```ts
import { connectWallet, algo } from "@algozkauth/sdk";

connectButton.onclick = async () => {
  const wallet = await connectWallet({ walletOrigin: "https://wallet.example" });  // call inside a click
  console.log(wallet.address);                                    // the same address in every dApp
  const { txId } = await wallet.sendAlgo({ to: recipient, amount: algo("0.1") });  // approved in the wallet window
  const { balance } = await wallet.account();
};
```

- `connectWallet({ walletOrigin, network?, timeoutMs? })` → `HostedWallet { address, walletId, provider, network,
  sendAlgo, optIn, sendAsset, account(), disconnect() }`. It throws `popup_blocked` if the window cannot open; a
  refusal in the wallet is `user_rejected`; closing the window mid-request is `wallet_closed`.
- Call actions from click handlers too: if the user closed the wallet window, the SDK reopens it.
- The dApp sees the wallet's address, id, provider, network and balances, never the login identity.
- Building a wallet of your own: `serveWallet(handlers)` from `@algozkauth/sdk/wallet-host` implements the other
  side of the protocol ([docs/service-architecture.md](../../docs/service-architecture.md#hosted-wallet-protocol)).

## Three things to know

| Thing | What it is | Where it lives |
| --- | --- | --- |
| **Session** | One login. Lasts 10 minutes. Holds a *non-extractable* Ed25519 key in the page. | Memory only. `renew()` signs in again (same account) and keeps the wallet. |
| **Backup** | An encrypted file holding the salt, sealed under a recovery secret and optionally a passkey. | The user's disk/password manager. Never on the service. |
| **Wallet** | An Algorand application account, one per (login, salt, app). | On chain. `wallet.address` receives funds. |

## API reference

### `createZkAuth(options): ZkAuth`

| Option | Default | |
| --- | --- | --- |
| `service` | required | Service base URL. |
| `app` | required | App id registered with the service. |
| `network` | – | `"localnet" \| "testnet" \| "mainnet"`; `config()` fails with `network_mismatch` if the service differs. |
| `proving` | `"service"` | `"browser"` proves in a Web Worker (see below). |
| `browserProver` | – | `{ wasmUrl, zkeyUrl, snarkjsUrl, worker?, run? }`, required for `proving: "browser"`. |
| `login` | built-in | Custom login step, see [Customising](#customising). |
| `approve` | – | `(plan) => boolean \| Promise<boolean>`: last chance to show the user what is about to be signed. Return `false` to cancel (`user_rejected`). |
| `indexerUrl` | service config | Indexer for `history()`. |
| `explorerUrl` | Lora | `(txId, network) => url` for `TxResult.explorerUrl`. |
| `expiringSeconds` | `60` | When `"expiring"` fires before expiry. |
| `pollMs`, `proofTimeoutMs` | `1000`, `300000` | Polling interval; proof deadline. |
| `fetch` | `globalThis.fetch` | Inject for tests or proxies. |

### `ZkAuth`

- `config(): Promise<AppConfig>`: public deployment config (cached).
- `signIn(provider?, { button?, login?, signal? }): Promise<Session>`
- `signOut(): Promise<void>`, `session`, `on("session", fn)`.

### `Session`

`id`, `provider`, `identity` (`{ issuer, audience, subject }`), `expiresAt` (unix s), `secondsLeft`, `expired`,
`backup`, `wallet()`, `renew()`, `close()`, `on("expiring" | "expired" | "change", fn)` (each returns an unsubscribe function).
`wallet()` rejects with `salt_required` until `backup.create()` or `backup.restore()` has succeeded.

### `Backup`

- `create({ passkey? })` → `{ file, fileName, secret, passkey }`. New salt on the first call; later calls re-seal the *same* salt under a new secret (a salt is never replaced). `passkey: true` adds a WebAuthn PRF passkey as a second unlock method (`passkey_unavailable` if the browser/authenticator lacks PRF).
- `restore(file | text, { secret } | { passkey: true })` → `{ walletId, enrolled }`. Checks the account, network and deployment, and that the service's wallet matches the backup.
- `export({ secret? })`: wallet-bound package after enrollment. `hasSalt`, `stage`, `needsExport`.

### `Wallet`

- `enroll()` → `TxResult | null` (null if already enrolled). `id`, `address`, `enrolled` are null/false until then.
- `sendAlgo({ to, amount })`, `optIn(assetId)`, `sendAsset({ assetId, to, amount })` → `TxResult { txId, groupId, confirmedRound, explorerUrl }`.
- `balance()` → `{ microAlgos, minBalance, spendable, assets: [{ id, amount }] }` (all `bigint`).
- `history({ limit? })` → `{ txId, round, time, type, amount, assetId, counterparty }[]` (`assetId` `0n` is ALGO).
- `waitForFunds({ microAlgos, timeoutMs? })`, `refresh()`.
- `status` (`"idle" | "proving" | "enrolling" | "preparing" | "signing" | "submitting"`), `progress`, `on("plan" | "change", fn)`.

Amounts: `bigint` is always µALGO (or asset base units). `algo("1.5")` and `algo(1.5)` build ALGO amounts without
floating-point error; `formatAlgo(x)` prints them; an AlgoKit `AlgoAmount` works too.

## Errors

Every failure is a `ZkAuthError` with `code`, `message`, optional `retryAfter` (seconds) and `retryable`.

```ts
try { await wallet.sendAlgo(...); }
catch (e) {
  if (e instanceof ZkAuthError && e.code === "key_pending_delay") showRetryIn(e.retryAfter);
  else throw e;
}
```

| Code | Meaning / what to do |
| --- | --- |
| `session_expired`, `not_signed_in` | Call `session.renew()` / `signIn()`. |
| `salt_required` | No backup yet: `backup.create()` or `restore()`. |
| `not_enrolled`, `wallet_exists` | Enroll first / already enrolled. |
| `insufficient_funds` | Fund `wallet.address`; the amount exceeds `spendable` (balance minus the minimum balance). |
| `key_pending_delay` | The provider's new signing key is in its approval delay. Retry after `retryAfter` s. |
| `key_inactive`, `registry_paused` | The provider key is not active / the registry is paused. Not retryable by the user. |
| `plan_mismatch` | **The service returned an action that differs from the request. Nothing was signed.** Do not retry blindly. |
| `plan_expired`, `replay` | Prepare the action again. |
| `proof_pending`, `proof_failed`, `timeout` | Proof not ready / could not be produced / took too long. |
| `rate_limited`, `quota_exceeded`, `service_unavailable` | Back off (`retryAfter`) or try later. |
| `origin_not_allowed`, `app_unknown`, `provider_unsupported`, `network_mismatch`, `unauthorized`, `not_found`, `bad_request` | Configuration or input problems. |
| `token_invalid`, `login_consumed`, `login_cancelled`, `login_timeout`, `popup_blocked`, `wrong_account` | Sign-in problems (the user cancelled, closed the window, or renewed with a different account). |
| `backup_invalid`, `passkey_unavailable`, `salt_conflict`, `wallet_mismatch`, `commitment_mismatch`, `nonce_mismatch` | Wrong secret/file/network, no passkey support, or the service contradicted what the browser computed. |
| `user_rejected`, `wallet_closed` | Your `approve` hook or the user in the hosted wallet said no / the wallet window was closed mid-request. |
| `not_supported` | No indexer is configured for `history()` (pass `indexerUrl`). |

## Customising

**Login UI.** `login` receives `{ provider, config, flow, nonce, authorizeUrl?, button?, signal }` and returns the
provider's ID token for `nonce` (in-page flow), or nothing for the code flow (the service exchanges the
authorization code and the SDK polls). Use it for non-Google providers, your own modal, or tests:

```ts
createZkAuth({ ..., login: async ({ nonce, config }) => await myProvider.getIdToken({ clientId: config.clientId, nonce }) });
```

The built-in handler loads Google Identity Services for the `in-page` flow and opens a pop-up for the `code`
flow (opened inside your click handler so blockers allow it).

**Browser proving.** By default the service proves for you (about 10 s with rapidsnark). `proving: "browser"`
keeps the ID token and salt off the service's prover, at the cost of minutes of single-threaded proving and a lot of
browser memory (the circuit is large; recorded runs took about two minutes on a laptop). You host three files and the worker; snarkjs is *not* in the SDK bundle.

```ts
createZkAuth({
  ..., proving: "browser",
  browserProver: {
    wasmUrl: "/zk/google_jwt.wasm", zkeyUrl: "/zk/google_jwt.zkey",     // circuit artifacts
    snarkjsUrl: "/zk/snarkjs.browser.esm.js",                              // copy of node_modules/snarkjs/build/browser.esm.js
    worker: () => new Worker(new URL("@algozkauth/sdk/prover-worker", import.meta.url), { type: "module" }),
  },
});
```

Progress is on `wallet.status === "proving"` and `wallet.progress`. The private circuit input comes from the
service (`POST …/circuit-input`, only to this session), is passed to the worker by `postMessage`, and the proof is
uploaded with `PUT …/proof`; the SDK checks the proof's public signals itself before using it.

## Security notes

**Stays in the browser:** the session private key (a non-extractable WebCrypto key; scripts on your page can
*use* it but never read it), the recovery secret, the decrypted backup, and (with browser proving) the proof
witness. Closing a session wipes the salt and the key reference.

**The service sees:** the provider ID token (to verify it), the wallet salt while a session is open (to find the wallet
and, with service proving, to prove), your user's identity (issuer, audience, subject), and the actions they
request. It cannot move funds: every action needs the session key's signature over a digest of the exact plan,
and the SDK refuses any plan that differs from the request, the wallet nonce, the network or the registry. The
service keeps tokens and salts in memory for at most the session. Use `proving: "browser"` if you want even the
prover never to see them.

**Backups:** the file is AES-GCM encrypted; the secret (`ZKR1:…`) or a passkey unlocks it. Treat file + secret like
a seed phrase split in two: keep them in different places. The SDK never uploads either; it never stores the
secret outside memory. Old backups stay valid forever (offline ciphertext cannot be revoked), so a leaked
file + secret pair compromises the wallet **provided** the attacker can also complete the user's Google login.

**Your dApp:** serve it over HTTPS with a strict Content-Security-Policy; any script on your origin can ask the
session key to sign. Use `approve` to show users the amount and recipient. `Session.id` is a capability: do not log it.

## Testing your dApp

Pass `fetch` and `login` to run the whole SDK offline. `test/fake-api.ts` in this package is an in-memory service
implementing the OpenAPI spec (real nonces, commitments, digests and Ed25519 checks); copy it, or stub just the
endpoints you use.

```ts
const zk = createZkAuth({ service: "http://svc.test", app: "demo", fetch: fakeApi.fetch,
                          login: async ({ nonce }) => makeToken(nonce) });
```

Run this package's tests with `npm test -w @algozkauth/sdk`. Against real services, start the compose local stack
and run `npm test -w @algozkauth/e2e` (Playwright: embedded and hosted flows in Chromium) or
`npm run test:sdk -w @algozkauth/e2e` (the SDK in Node with a scripted dev-issuer login).
