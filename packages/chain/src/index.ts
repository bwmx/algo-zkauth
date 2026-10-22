// @bwmx/algo-zkauth-chain — deployment, key registry, wallet discovery and action
// groups on any Algorand network. Signing accounts are passed in; nothing here
// reads the environment. One key registry (with its guardian) and one verifier
// LogicSig serve each provider on a network; each app (OAuth audience) has its
// own WalletRegistry bound to that key registry.
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AlgorandClient, microAlgos, decodeAddress, getApplicationAddress, snarkjs,
  Groth16Bn254LsigVerifier, encodeGroth16Bn254Proof, loadContracts,
} from "./deps.ts";
import { providerById } from "../../protocol/src/oidc-providers.mjs";
import { actionDigest, signalDigest } from "../../protocol/src/action-node.mjs";
import { ChainError } from "./errors.ts";
import type {
  ActionRequest, AppDeployment, ApprovedKey, ChainClient, ChainErrorCode, KeyChange, OpenChainOptions,
  ProviderDeployment, RegistryFlags, Signer, Submitted, WalletSnapshot,
} from "./types.ts";
import type { ActionPlan, ProofResult } from "../../protocol/src/types.ts";

export { ChainError } from "./errors.ts";
export type {
  ActionRequest, AppDeployment, ApprovedKey, ChainClient, ChainErrorCode, KeyChange, OpenChainOptions,
  ProviderDeployment, RegistryFlags, Signer, SubmitMetrics, Submitted, WalletSnapshot,
} from "./types.ts";

// A key registry seals its bootstrap at deployment; after that the administrator's
// approvals take effect no sooner than this delay (contracts/key_registry.algo.ts).
export const APPROVAL_DELAY = 86400n;
export const KEY_INTERVAL = 7n * 86400n;
// A key whose approval ends within this margin is renewed, so the renewal takes effect in time.
export const RENEWAL_MARGIN = APPROVAL_DELAY + 2n * 86400n;
export const GROUP_FEE_MICROALGOS = 20_000n;
// Funding at deployment: four key boxes plus buffer; a registry's base balance.
const KEY_REGISTRY_FUNDING = 300_000n;
const REGISTRY_FUNDING = 100_000n;
const PUBLIC_NETWORKS = ["mainnet-v1.0", "testnet-v1.0", "betanet-v1.0"];

const fail = (code: ChainErrorCode, message: string): never => { throw new ChainError(code, message); };
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const isUint64 = (value: unknown): value is string =>
  typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
const isAddress = (value: unknown) => { try { decodeAddress(value as string); return true; } catch { return false; } };
const fingerprintBytes = (fingerprint: string) => {
  const hash = typeof fingerprint === "string" && /^[A-Za-z0-9_-]{43}$/.test(fingerprint) ? Buffer.from(fingerprint, "base64url") : undefined;
  return hash?.length === 32 ? hash : fail("rejected", "A key fingerprint is 32 bytes in base64url");
};
const keyBox = (hash: Uint8Array) => Buffer.concat([Buffer.from("gk:"), hash]);
// Node and simulation failures are classified by text, then replaced by a static message.
const classify = (error: unknown, message: string): ChainError => {
  if (error instanceof ChainError) return error;
  const text = String((error as Error)?.message ?? "");
  const code: ChainErrorCode = /Wrong action nonce/.test(text) ? "replay"
    : /Wallet already registered/.test(text) ? "wallet_exists"
    : /overspend|below min|insufficient/i.test(text) ? "insufficient_funds"
    : "rejected";
  return new ChainError(code, message);
};
const attempt = async <T>(message: string, callback: () => Promise<T>): Promise<T> => {
  try { return await callback(); } catch (error) { throw classify(error, message); }
};

/** Internal options, used by ./demo.ts; services leave them unset. */
type Internal = { notePrefix?: string };

export async function openChain(options: OpenChainOptions & Internal) {
  const { network, root } = options;
  const notePrefix = options.notePrefix ?? "algozkauth";
  if (network === "mainnet") fail("wrong_network", "MainNet is not supported yet");
  if (network !== "localnet" && network !== "testnet") fail("wrong_network", "Unknown network");
  const algorand = options.algodUrl
    ? AlgorandClient.fromConfig({
      algodConfig: { server: options.algodUrl, token: options.algodToken ?? "" },
      ...(options.indexerUrl ? { indexerConfig: { server: options.indexerUrl, token: "" } } : {}),
    })
    : network === "testnet" ? AlgorandClient.testNet() : AlgorandClient.defaultLocalNet();
  const algod = algorand.client.algod;
  const params = await attempt("Algorand node is unreachable", () => algod.getTransactionParams().do());
  const genesisId = params.genesisID!;
  if (network === "testnet" ? genesisId !== "testnet-v1.0" : PUBLIC_NETWORKS.includes(genesisId))
    fail("wrong_network", network === "testnet" ? "Node is not on TestNet" : "Node is not a LocalNet");
  const genesis = Buffer.from(params.genesisHash!);
  const genesisHash = b64(genesis);
  const { KeyRegistryFactory, WalletRegistryFactory, UserWalletFactory, WALLET_SPEC } = await loadContracts();
  const keyFactory = new KeyRegistryFactory({ algorand });
  const registryFactory = new WalletRegistryFactory({ algorand });
  const walletFactory = new UserWalletFactory({ algorand });

  // Signers are registered with this client's AlgorandClient, then named by address.
  const use = (account: Signer): string => {
    const addr = String(account?.addr ?? "");
    const signer = typeof account?.signer === "function" ? account.signer : (account?.signer as { signer?: unknown })?.signer;
    if (!isAddress(addr) || typeof signer !== "function") fail("rejected", "A signer needs an address and a transaction signer");
    algorand.setSigner(addr, signer as any);
    return addr;
  };
  // Sends that depend on chain state (key changes, wallet actions, demo funding) run one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(callback: () => Promise<T>): Promise<T> => {
    const next = queue.then(callback); queue = next.catch(() => {}); return next;
  };
  const time = async (): Promise<bigint> => {
    const status = await algod.status().do();
    return (await algod.block(status.lastRound).do()).block.header.timestamp;
  };
  let curve: any;
  const bn128 = async () => (curve ??= await (snarkjs as any).curves.getCurveFromName("bn128"));

  // Per provider: its circuit's verifier LogicSig and verification key.
  type ProviderContext = { provider: any; verifier: InstanceType<typeof Groth16Bn254LsigVerifier>; address: string; vk: unknown; vkSha256: string };
  const contexts = new Map<string, Promise<ProviderContext>>();
  const providerContext = (id: string): Promise<ProviderContext> => {
    if (!contexts.has(id)) {
      const loading = (async () => {
        let provider: any;
        try { provider = providerById(id); } catch { fail("rejected", "Unsupported login provider"); }
        const { directory, name } = provider.circuit;
        const vkBytes = readFileSync(resolve(root, `${directory}/verification_key.json`));
        const verifier = new Groth16Bn254LsigVerifier({ algorand, appOffset: 0, totalLsigs: 6, zKey: resolve(root, `${directory}/${name}.zkey`), wasmProver: resolve(root, `${directory}/${name}_js/${name}.wasm`) });
        const lsig = await verifier.lsigAccount();
        return { provider, verifier, address: lsig.addr.toString(), vk: JSON.parse(vkBytes.toString("utf8")), vkSha256: createHash("sha256").update(vkBytes).digest("hex") };
      })();
      loading.catch(() => contexts.delete(id));
      contexts.set(id, loading);
    }
    return contexts.get(id)!;
  };
  const onNetwork = (deployment: ProviderDeployment) => {
    if (deployment?.genesisHash !== genesisHash) fail("wrong_network", "Deployment is for another network");
  };
  // The circuit artifacts here must be the ones the deployment's verifier was built from.
  const checkedProvider = async (deployment: ProviderDeployment) => {
    onNetwork(deployment);
    const context = await providerContext(deployment.provider);
    if (context.address !== deployment.verifier || context.vkSha256 !== deployment.verificationKeySha256)
      fail("rejected", "Circuit artifacts differ from the provider deployment");
    return context;
  };

  const keyRegistry = (deployment: ProviderDeployment) => {
    onNetwork(deployment);
    const client = keyFactory.getAppClientById({ appId: BigInt(deployment.keyRegistryId) });
    // Registries made before the approval delay have no guardian or bootstrap
    // seal, and their approvals take effect immediately.
    let guarded: Promise<boolean> | undefined;
    const timelocked = () => (guarded ??= client.state.global.guardian().then((g: unknown) => g !== undefined));
    const flags = async (): Promise<RegistryFlags> => {
      const [state, locked] = await Promise.all([client.state.global.getAll(), timelocked()]);
      return { paused: (state.paused ?? 0n) !== 0n, sealed: !locked || (state.sealed ?? 0n) !== 0n, timelocked: locked };
    };
    // Raw ARC-4 record: validFrom, validUntil, revoked bit, then (timelocked registries)
    // a pending renewal, applied here as the contract applies it once it takes effect.
    const record = async (hash: Uint8Array, now: bigint) => {
      let value: Buffer;
      try { value = Buffer.from((await algod.getApplicationBoxByName(client.appId, keyBox(hash)).do()).value); }
      catch (error: any) { if (error.status === 404) return undefined; throw error; }
      const key = { validFrom: value.readBigUInt64BE(0), validUntil: value.readBigUInt64BE(8), revoked: (value[16]! & 0x80) !== 0, renewedUntil: 0n, renewalEffectiveAt: 0n };
      if (value.length >= 33) { key.renewedUntil = value.readBigUInt64BE(17); key.renewalEffectiveAt = value.readBigUInt64BE(25); }
      if (key.renewalEffectiveAt && now >= key.renewalEffectiveAt) { key.validUntil = key.renewedUntil; key.renewedUntil = 0n; key.renewalEffectiveAt = 0n; }
      return key;
    };
    const list = async (): Promise<ApprovedKey[]> => {
      const now = await time();
      const keys: ApprovedKey[] = [];
      for (const { name } of (await algod.getApplicationBoxes(client.appId).do()).boxes) {
        const box = Buffer.from(name);
        if (box.length !== 35 || !box.subarray(0, 3).equals(Buffer.from("gk:"))) continue;
        const key = (await record(box.subarray(3), now))!;
        keys.push({ fingerprint: b64(box.subarray(3)), validFrom: String(key.validFrom), validUntil: String(key.validUntil),
          ...(key.renewalEffectiveAt ? { renewedUntil: String(key.renewedUntil), renewalEffectiveAt: String(key.renewalEffectiveAt) } : {}),
          ...(key.revoked ? { revoked: true } : {}) });
      }
      return keys;
    };
    // Registers the provider's current keys. Before the bootstrap is sealed they take
    // effect at once and the registry is then sealed; afterwards a new key, or the
    // renewal of one nearing the end of its approval, takes effect after the delay.
    const ensureKeys = (o: { jwks: { keys: unknown[] }; administrator: Signer; onChange?: (change: KeyChange) => void }) => serial(async () => {
      if (!Array.isArray(o?.jwks?.keys)) fail("rejected", "Invalid JWKS");
      const sender = use(o.administrator);
      const now = await time();
      const { sealed } = await flags();
      const locked = await timelocked();
      const changes: KeyChange[] = [];
      const change = (value: KeyChange) => { changes.push(value); o.onChange?.(value); };
      for (const jwk of o.jwks.keys as any[]) {
        const modulus = Buffer.from(typeof jwk?.n === "string" ? jwk.n : "", "base64url");
        // A JWKS may omit "use" (Slack's does) or set it to "sig" (Google's).
        if (jwk?.kty !== "RSA" || jwk.e !== "AQAB" || modulus.length !== 256 || jwk.alg !== "RS256" || (jwk.use ?? "sig") !== "sig") continue;
        const hash = createHash("sha256").update(modulus).digest();
        const existing = await record(hash, now);
        if (!existing) {
          const info = await algod.accountInformation(client.appAddress).do();
          if (info.amount - info.minBalance < 50_000n)
            await attempt("Key registry funding was rejected", () => algorand.send.payment({ sender, receiver: client.appAddress, amount: microAlgos(100_000) }));
          // The 60 s margin covers the gap between this read and the next block's timestamp.
          const validFrom = locked && sealed ? now + APPROVAL_DELAY + 60n : now - 60n;
          await attempt("Key registration was rejected", () => client.send.registerKey({ sender, args: { keyHash: hash, validFrom, validUntil: validFrom + KEY_INTERVAL }, boxReferences: [keyBox(hash)] }));
          change({ kind: "registered", fingerprint: b64(hash), validFrom: String(validFrom), validUntil: String(validFrom + KEY_INTERVAL) });
        } else if (locked && !existing.revoked && !existing.renewalEffectiveAt && existing.validUntil < now + RENEWAL_MARGIN) {
          const validUntil = (existing.validUntil > now + APPROVAL_DELAY ? existing.validUntil : now + APPROVAL_DELAY) + KEY_INTERVAL;
          await attempt("Key renewal was rejected", () => client.send.renewKey({ sender, args: { keyHash: hash, validUntil }, boxReferences: [keyBox(hash)] }));
          change({ kind: "renewed", fingerprint: b64(hash), renewedUntil: String(validUntil), renewalEffectiveAt: String(sealed ? now + APPROVAL_DELAY : now) });
        }
      }
      if (!sealed) await attempt("Sealing the key registry was rejected", () => client.send.sealBootstrap({ sender, args: [] }));
      return {
        registered: changes.filter(c => c.kind === "registered").map(c => c.fingerprint),
        renewed: changes.filter(c => c.kind === "renewed").map(c => c.fingerprint),
        sealed: !sealed, changes,
      };
    });
    const keyCall = (method: "revokeKey" | "cancelRenewal", message: string) => (o: { fingerprint: string; signer: Signer }) => serial(async () => {
      const keyHash = fingerprintBytes(o?.fingerprint);
      const sender = use(o.signer);
      await attempt(message, () => client.send[method]({ sender, args: { keyHash }, boxReferences: [keyBox(keyHash)] }));
    });
    const setPaused = (paused: boolean, signer: Signer) => serial(async () => {
      const sender = use(signer);
      await attempt(paused ? "Pausing the key registry was rejected" : "Resuming the key registry was rejected", () => client.send.setPaused({ sender, args: { paused } }));
    });
    return {
      client, timelocked, record,
      flags, list, ensureKeys,
      revoke: keyCall("revokeKey", "Key revocation was rejected"),
      cancelRenewal: keyCall("cancelRenewal", "Renewal cancellation was rejected"),
      pause: (o: { signer: Signer }) => setPaused(true, o?.signer),
      resume: (o: { administrator: Signer }) => setPaused(false, o?.administrator),
    };
  };

  const wallets = (app: AppDeployment, provider: ProviderDeployment) => {
    onNetwork(provider);
    if (app?.provider !== provider.provider) fail("rejected", "App and provider deployments differ");
    const audienceHash = Buffer.from(app.audienceHash, "base64url");
    if (!audienceHash.equals(createHash("sha256").update(app.audience, "ascii").digest())) fail("wrong_audience", "App deployment audience hash is inconsistent");
    const registry = registryFactory.getAppClientById({ appId: BigInt(app.registryId) });
    const keys = keyRegistry(provider);
    const keysAppId = keys.client.appId;

    const empty = (): WalletSnapshot => ({ walletId: "0", address: null, nonce: "0", balanceMicroAlgos: "0", minBalanceMicroAlgos: "0", assets: [], enrolled: false });
    const discover = async (owner: Uint8Array): Promise<WalletSnapshot> => {
      if (!(owner instanceof Uint8Array) || owner.length !== 32) fail("rejected", "Invalid owner commitment");
      let id = 0n;
      try {
        const box = await algod.getApplicationBoxByName(registry.appId, Buffer.concat([Buffer.from("w:"), owner])).do();
        if (box.value.length !== 8) fail("rejected", "Invalid canonical wallet box");
        id = Buffer.from(box.value).readBigUInt64BE();
      } catch (error: any) { if (error instanceof ChainError) throw error; if (error.status !== 404) throw classify(error, "Wallet discovery failed"); }
      if (!id) return empty();
      const wallet = walletFactory.getAppClientById({ appId: id });
      const s = await wallet.state.global.getAll();
      if (!Buffer.from(s.owner!.asByteArray()!).equals(Buffer.from(owner)) || s.registry !== registry.appId || s.keyRegistry !== keysAppId || s.verifier !== provider.verifier || !Buffer.from(s.audience!.asByteArray()!).equals(audienceHash) || wallet.appAddress.toString() !== getApplicationAddress(id).toString())
        fail("rejected", "Discovered wallet owner/address/policy mismatch");
      const account = await algod.accountInformation(wallet.appAddress).do();
      return { walletId: String(id), address: wallet.appAddress.toString(), nonce: String(s.nonce), balanceMicroAlgos: String(account.amount), minBalanceMicroAlgos: String(account.minBalance), assets: (account.assets ?? []).map((a: any) => ({ id: String(a.assetId), amount: String(a.amount) })), enrolled: true };
    };
    // Wallets are created by the registry, so its created apps hold every wallet address.
    const snapshotByAddress = async (address: string): Promise<WalletSnapshot> => {
      if (!isAddress(address)) fail("rejected", "Invalid wallet address");
      const info = await algod.accountInformation(registry.appAddress).do();
      const app = (info.createdApps ?? []).find((a: any) => getApplicationAddress(a.id).toString() === address);
      if (!app) fail("not_enrolled", "No enrolled wallet at this address");
      const state = await walletFactory.getAppClientById({ appId: app.id }).state.global.getAll();
      return discover(state.owner!.asByteArray()!);
    };
    const proofContext = async (result: ProofResult) => {
      const context = await checkedProvider(provider);
      const { label } = context.provider;
      const publicSignals = result?.publicSignals;
      let signals: bigint[] = [];
      try { if (Array.isArray(publicSignals) && publicSignals.every(s => typeof s === "string" && /^[0-9]{1,78}$/.test(s))) signals = publicSignals.map(BigInt); } catch { /* invalid */ }
      const binding = "Invalid proof or network/audience binding";
      if (signals.length !== 12) fail("invalid_proof", binding);
      if (!signalDigest(signals, 8).equals(genesis)) fail("wrong_network", binding);
      if (!signalDigest(signals, 4).equals(audienceHash)) fail("wrong_audience", binding);
      let valid = false;
      try { valid = await snarkjs.groth16.verify(context.vk as any, publicSignals, result.proof as any); } catch { /* invalid */ }
      if (!valid) fail("invalid_proof", binding);
      const now = await time();
      if (signals[10]! <= now + 15n || signals[11]! > now || signals[10]! > now + 600n) fail("session_expired", `Session expired or inactive; renew ${label} login and prove again`);
      const keyHash = signalDigest(signals, 2);
      const key = await keys.record(keyHash, now);
      const flags = await keys.flags();
      const pending = !!key && key.validFrom > now;
      if (!key || key.revoked || key.validFrom > now || key.validUntil < signals[10]! || key.validUntil <= now || flags.paused || !flags.sealed)
        fail(flags.paused ? "registry_paused" : pending ? "key_pending_delay" : "key_inactive", `${label} key policy is inactive${pending ? ` until ${new Date(Number(key!.validFrom) * 1000).toISOString()} (24-hour approval delay)` : ""}`);
      return { signals, owner: signalDigest(signals, 0) as Buffer, keyHash: keyHash as Buffer, proof: encodeGroth16Bn254Proof(structuredClone(result.proof) as any, await bn128()), verifier: context.verifier };
    };
    const checkProof = async (result: ProofResult) => {
      const { owner, keyHash, signals } = await proofContext(result);
      return { owner: new Uint8Array(owner), keyHash: new Uint8Array(keyHash), expiresAt: signals[10]! };
    };
    const prepare = async (o: { proof: ProofResult; request: ActionRequest; sponsor?: string }): Promise<ActionPlan> => {
      const { signals, owner } = await proofContext(o?.proof);
      const request: Partial<ActionRequest> = o.request ?? {};
      const wallet = await discover(owner);
      const enrollment = request.operation === "0";
      if (enrollment && wallet.enrolled) fail("wallet_exists", "Wallet already exists; use discovery");
      if (!enrollment && !wallet.enrolled) fail("not_enrolled", "Enroll the original identity first");
      if (!["0", "1", "2", "3"].includes(request.operation as string)) fail("rejected", "Unsupported wallet operation");
      if (enrollment && !isAddress(o.sponsor)) fail("rejected", "Enrollment needs the sponsor's address");
      const recipient = (enrollment ? o.sponsor : request.recipient) as string;
      if (!isAddress(recipient)) fail("rejected", "Recipient is not an Algorand address");
      const amount = enrollment ? app.enrollmentDeposit : request.amount;
      const assetId = enrollment ? "0" : request.assetId;
      if (!isUint64(amount) || !isUint64(assetId)) fail("rejected", "Invalid action uint64");
      if (request.operation === "1" && (assetId !== "0" || BigInt(amount!) === 0n)) fail("rejected", "ALGO transfer requires positive amount and asset 0");
      if (request.operation === "2" && (recipient !== wallet.address || assetId === "0" || amount !== "0")) fail("rejected", "Invalid ASA opt-in");
      if (request.operation === "3" && (assetId === "0" || BigInt(amount!) === 0n)) fail("rejected", "Invalid ASA transfer");
      return { planId: randomUUID(), version: 1, genesisHash, registryId: app.registryId, walletId: enrollment ? "0" : wallet.walletId, owner: b64(owner), operation: request.operation!, recipient, recipientPublicKey: b64(decodeAddress(recipient).publicKey), assetId: assetId!, amount: amount!, nonce: enrollment ? "0" : wallet.nonce, sessionExpiresAt: String(signals[10]) };
    };
    // The group for a plan the session key signed: the proof's LogicSig and the
    // registry's enroll or the wallet's execute, with the sponsor paying the fees.
    const build = async (result: ProofResult, action: ActionPlan, signature: Uint8Array, sponsor: string) => {
      const { signals, owner, keyHash, proof, verifier } = await proofContext(result);
      if (action?.genesisHash !== genesisHash || action.registryId !== app.registryId || action.owner !== b64(owner) || action.sessionExpiresAt !== String(signals[10])) fail("rejected", "Action context mismatch");
      if (!["0", "1", "2", "3"].includes(action.operation)) fail("rejected", "Unsupported wallet operation");
      if (![action.walletId, action.assetId, action.amount, action.nonce].every(isUint64)) fail("rejected", "Invalid action uint64");
      if (!isAddress(action.recipient)) fail("rejected", "Recipient is not an Algorand address");
      if (action.operation === "0" && action.recipient !== sponsor) fail("rejected", "Action context mismatch");
      const digest = actionDigest({ ...action, genesisHash: genesis, registryId: BigInt(action.registryId), walletId: BigInt(action.walletId), owner, operation: BigInt(action.operation), recipient: decodeAddress(action.recipient).publicKey, assetId: BigInt(action.assetId), amount: BigInt(action.amount), nonce: BigInt(action.nonce), sessionExpiresAt: BigInt(action.sessionExpiresAt) });
      const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: signalDigest(signals, 6).toString("base64url") }, format: "jwk" });
      if (!(signature instanceof Uint8Array) || signature.length !== 64 || !verify(null, digest, publicKey, signature)) fail("rejected", "Browser action signature is invalid");
      const box = keyBox(keyHash);
      if (action.operation === "0") {
        const g = registry.newGroup();
        g.addTransaction(await algorand.createTransaction.payment({ sender: sponsor, receiver: registry.appAddress, amount: microAlgos(BigInt(app.enrollmentDeposit)), staticFee: microAlgos(GROUP_FEE_MICROALGOS), note: `${notePrefix}-enroll-${randomUUID()}` }));
        await verifier.verificationParams({ proof, signals, composer: g, paramsCallback: async ({ lsigParams, args }: any) => {
          g.enroll({ ...lsigParams, args: { ...args, payer: sponsor, signature }, appReferences: [keysAppId], boxReferences: [Buffer.concat([Buffer.from("w:"), owner]), { appId: keysAppId, name: box }] });
        } } as any);
        return { group: g, target: registry.appId };
      }
      const known = await discover(owner);
      if (known.walletId !== action.walletId) fail("rejected", "Action targets another identity's wallet");
      const wallet = walletFactory.getAppClientById({ appId: BigInt(action.walletId) });
      const g = wallet.newGroup();
      await verifier.verificationParams({ proof, signals, composer: g, paramsCallback: async ({ lsigParams, args }: any) => {
        g.execute({ ...lsigParams, args: { ...args, operation: BigInt(action.operation), recipient: action.recipient, assetId: BigInt(action.assetId), amount: BigInt(action.amount), nonce: BigInt(action.nonce), signature }, appReferences: [keysAppId], accountReferences: [action.recipient], assetReferences: action.assetId === "0" ? [] : [BigInt(action.assetId)], boxReferences: [{ appId: keysAppId, name: box }] });
        g.addTransaction(await algorand.createTransaction.payment({ sender: sponsor, receiver: sponsor, amount: microAlgos(0), staticFee: microAlgos(GROUP_FEE_MICROALGOS), note: `${notePrefix}-action-${randomUUID()}` }));
      } } as any);
      return { group: g, target: wallet.appId };
    };
    const ownerOf = (action: ActionPlan) => {
      const owner = typeof action?.owner === "string" ? Buffer.from(action.owner, "base64url") : Buffer.alloc(0);
      return owner.length === 32 ? owner : fail("rejected", "Action context mismatch");
    };
    const submit = (o: { proof: ProofResult; plan: ActionPlan; signature: Uint8Array; sponsor: Signer }) => serial(async (): Promise<Submitted> => {
      const sponsor = use(o?.sponsor);
      const action = o.plan;
      const before = await discover(ownerOf(action));
      if (action.operation !== "0" && before.nonce !== action.nonce) fail("replay", "Action nonce changed; prepare a new action");
      const { group: g, target } = await build(o.proof, action, o.signature, sponsor);
      const built = await (await g.composer()).build(); const signed = await built.atc.gatherSignatures();
      const rejected = "Wallet simulation rejected the action";
      const simulated = await attempt(rejected, () => g.simulate()); const sim = simulated.simulateResponse.txnGroups[0]!;
      if (sim.failedAt) throw classify(new Error(sim.failureMessage ?? ""), rejected);
      const started = performance.now();
      const sent = await attempt("Node rejected the action", () => g.send());
      const confirmationMs = Math.round(performance.now() - started);
      const txns = built.transactions.map((t: any) => t.txn);
      const count = (r: any): number => (r.innerTxns ?? []).reduce((n: number, t: any) => n + 1 + count(t), 0);
      const call = txns.findIndex((t: any) => t.applicationCall?.appIndex === target);
      return {
        txId: sent.txIds[call] ?? sent.txIds.at(-1)!, transactionIds: sent.txIds, groupId: sent.groupId ?? "",
        confirmedRound: String(sent.confirmations[0]?.confirmedRound ?? 0),
        wallet: await discover(ownerOf(action)),
        groupFeeMicroAlgos: String(txns.reduce((n: bigint, t: any) => n + t.fee, 0n)),
        metrics: { confirmationMs, outerTransactions: txns.length, innerTransactions: sim.txnResults.reduce((n: number, t: any) => n + count(t.txnResult), 0), signedBytes: signed.reduce((n: number, t: Uint8Array) => n + t.length, 0), appBudgetConsumed: sim.appBudgetConsumed ?? 0, logicSigBudgetConsumed: sim.txnResults.reduce((n: number, t: any) => n + (t.logicSigBudgetConsumed ?? 0), 0) },
      };
    });
    const verifyDeployment = async (o: { sender: string }) => {
      const state = await registry.state.global.getAll();
      if (state.verifier !== provider.verifier || state.keyRegistry !== keysAppId || !Buffer.from(state.audience!.asByteArray()!).equals(audienceHash))
        fail("rejected", "On-chain registry policy differs from the deployment record");
      const deposit = (await attempt("Reading the enrollment deposit failed", () => registry.send.enrollmentDeposit({ sender: o?.sender, args: [] }))).return;
      if (String(deposit) !== app.enrollmentDeposit) fail("rejected", "Enrollment deposit differs from the deployment record");
    };
    return {
      discover, snapshotByAddress, checkProof, prepare, submit, verify: verifyDeployment,
      // For ./demo.ts: the registry, its key registry and the unsent group of a plan.
      registry, keysAppId, proofContext, build,
    };
  };

  const client = {
    network,
    genesisId,
    genesisHash,
    time,
    async deployProvider(o: { provider: string; administrator: Signer; guardian: string }): Promise<ProviderDeployment> {
      const context = await providerContext(o?.provider);
      const administrator = use(o.administrator);
      if (!isAddress(o.guardian)) fail("rejected", "The guardian must be an Algorand address");
      if (o.guardian === administrator) fail("rejected", "The guardian must differ from the administrator");
      const { appClient: keys } = await attempt("Key registry creation was rejected", () => keyFactory.send.create.createApplication({ sender: administrator, args: { guardian: o.guardian } }));
      await attempt("Key registry funding was rejected", () => algorand.send.payment({ sender: administrator, receiver: keys.appAddress, amount: microAlgos(KEY_REGISTRY_FUNDING) }));
      return { network, genesisHash, provider: context.provider.id, verifier: context.address, verificationKeySha256: context.vkSha256, keyRegistryId: String(keys.appId), guardian: o.guardian, administrator, createdAt: new Date().toISOString() };
    },
    async deployApp(o: { provider: ProviderDeployment; app: string; audience: string; funder: Signer }): Promise<AppDeployment> {
      await checkedProvider(o?.provider);
      if (typeof o.app !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(o.app)) fail("rejected", "Invalid app id");
      if (typeof o.audience !== "string" || !/^[\x21-\x7e]{1,255}$/.test(o.audience)) fail("wrong_audience", "Invalid audience");
      const sender = use(o.funder);
      const keyRegistryId = BigInt(o.provider.keyRegistryId);
      const audienceHash = createHash("sha256").update(o.audience, "ascii").digest();
      const { appClient: registry } = await attempt("Wallet registry creation was rejected", () => registryFactory.send.create.createApplication({ sender, args: { verifier: o.provider.verifier, keyRegistry: keyRegistryId, audience: audienceHash }, appReferences: [keyRegistryId] }));
      await attempt("Wallet registry funding was rejected", () => algorand.send.payment({ sender, receiver: registry.appAddress, amount: microAlgos(REGISTRY_FUNDING) }));
      const deposit = (await attempt("Reading the enrollment deposit failed", () => registry.send.enrollmentDeposit({ sender, args: [] }))).return!;
      return { app: o.app, provider: o.provider.provider, audience: o.audience, audienceHash: b64(audienceHash), registryId: String(registry.appId), enrollmentDeposit: String(deposit), groupFeeMicroAlgos: String(GROUP_FEE_MICROALGOS) };
    },
    keys: keyRegistry,
    wallets,
    async close() { await curve?.terminate(); curve = undefined; },
    // For ./demo.ts and tests: the underlying AlgorandClient, signer registration and the send queue.
    internal: { algorand, use, serial, notePrefix, providerContext, WALLET_SPEC, walletFactory },
  };
  return client satisfies ChainClient;
}

export type OpenedChain = Awaited<ReturnType<typeof openChain>>;
