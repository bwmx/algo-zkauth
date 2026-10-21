# @algozkauth/chain

Deployment, key registry, wallet discovery and action groups for AlgoZKAuth on LocalNet or TestNet. The surface is [`src/types.ts`](src/types.ts) (`ChainClient`); [`src/index.ts`](src/index.ts) implements it as `openChain`, and [`src/demo.ts`](src/demo.ts) holds the demo-only operations (demo ASA, funding, seeding, replay and isolation checks) and `openDemoChain`, the TestNet demo's wrapper over the client.

```ts
import { openChain, ChainError } from "./packages/chain/src/index.ts";

const chain = await openChain({ network: "localnet", root }); // root: the repository, for circuit artifacts
const provider = await chain.deployProvider({ provider: "google", administrator, guardian });
const app = await chain.deployApp({ provider, app: "demo", audience: clientId, funder: sponsor });
await chain.keys(provider).ensureKeys({ jwks, administrator });
const wallets = chain.wallets(app, provider);
const plan = await wallets.prepare({ proof, request: { operation: "0" }, sponsor: sponsor.addr });
await wallets.submit({ proof, plan, signature, sponsor });
await chain.close();
```

- **One key registry per provider per network.** `deployProvider` creates the provider's key registry with its guardian and returns the `ProviderDeployment`; `deployApp` creates a `WalletRegistry` for one audience that points at that key registry and the provider's verifier LogicSig. The contracts are unchanged: `WalletRegistry.createApplication` already takes the key registry.
- **Keys.** `ensureKeys` registers the JWKS's RSA-2048 RS256 keys (immediately during the bootstrap, then sealed; afterwards no sooner than the 24-hour approval delay), and renews a key whose approval ends within three days. Registries made before the guardian existed keep immediate approvals.
- **Signers are passed in** as `{ addr, signer }` (an algosdk `TransactionSigner` or an AlgoKit `TransactionSignerAccount`). Nothing reads the environment.
- **Errors** are `ChainError` with a `code` from `ChainErrorCode` and a static message that never carries an SDK trace, token or identifier. AlgoKit itself logs each transaction at info level; a service that must not log app-call arguments should configure AlgoKit's logger (`Config.configure`) before opening a client.

## Dependencies: one algosdk, from the pinned checkout

The package needs algosdk 3.4.0, `@algorandfoundation/algokit-utils` 9.1.x, snarkjs 0.7.5 and the Groth16 LogicSig verifier from `upstream/snarkjs-algorand` (commit 3a970c7, `scripts/setup.sh`). Earlier, `src/phase6/chain.ts` was copied into that checkout so its imports would resolve there. Now the package runs from the repository and [`src/deps.ts`](src/deps.ts) is the one module that loads these dependencies, **by path** from the checkout:

- algosdk, AlgoKit utils and snarkjs from `upstream/snarkjs-algorand/node_modules/...` (their ESM entry points), and the verifier from `upstream/snarkjs-algorand/src/groth16.ts`.
- The generated contract clients from `upstream/snarkjs-algorand/contracts/clients/`, where their bare `algosdk` and `@algorandfoundation/algokit-utils` imports resolve. `scripts/setup.sh` (and `scripts/build/build-wallets.sh`) install them there from the committed `contracts/clients/`; `openChain` refuses to start unless the installed copies are byte-identical to the committed ones.

This gives exactly one instance of each package at runtime. Node resolves every module to its real path, so the checkout's pnpm symlinks, the verifier's and the clients' bare imports, and `deps.ts`'s path imports all reach the same files in the pnpm store, and all of them load as ES modules. The test asserts it (an AlgoKit-made address is an instance of `deps.ts`'s `Address`).

One rule keeps it that way: code that imports this package must be an ES module. `packages/*` are `"type": "module"`; a `.ts` file directly under the repository root's package (which has no `"type"`) is compiled to CommonJS by tsx, which breaks its named imports from this package and would resolve algosdk's and AlgoKit's CommonJS builds, a second instance. That is why the demo scripts import `packages/chain/src/demo.ts` directly and there is no longer a `src/phase6/chain.ts`.

Simpler-looking alternatives were rejected: installing the packages again for the repository (a root or workspace `node_modules`) would add a second algosdk/AlgoKit copy unless every version and peer resolution matched the checkout's lockfile exactly; a `node_modules` symlink into the checkout would be overwritten by the workspace's own installs; and copying sources into the checkout keeps two copies of the code.

Run anything that imports the package with tsx from the checkout:

```sh
node --import ./upstream/snarkjs-algorand/node_modules/tsx/dist/loader.mjs your-script.mjs
```

## Test

`npm run test:localnet:chain` (LocalNet on localhost:4001; it neither moves the block clock nor writes `benchmarks/`). One provider deployment and two apps sharing its key registry; a dev RSA key registered through `ensureKeys` from a synthetic JWKS, a later key held by the approval delay and vetoed by the guardian; a synthetic identity's full-circuit proof (rapidsnark from `.local/bin/<platform>-<arch>/prover` when present, otherwise snarkjs) driving discover → prepare → sign → submit for an enrollment and an ALGO transfer on one app; the same identity and salt having a different, unenrolled wallet on the other app, whose registry refuses the first app's proof. A second test drives `openDemoChain` on LocalNet through its record, reopening and every demo operation.
