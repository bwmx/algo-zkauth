// Demo-only chain operations (the demo ASA, wallet funding and seeding, the
// replay and isolation checks) and openDemoChain, the TestNet demo's view of one
// provider: its .local/phase6/deployment*.json record, on top of openChain.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { microAlgos } from "./deps.ts";
import { ChainError, GROUP_FEE_MICROALGOS, openChain, type OpenedChain } from "./index.ts";
import type { AppDeployment, KeyChange, ProviderDeployment, Signer } from "./types.ts";
import type { ActionPlan, ProofResult } from "../../protocol/src/types.ts";

type Deployments = { app: AppDeployment; provider: ProviderDeployment };
type Execution = { proof: ProofResult; plan: ActionPlan; signature: Uint8Array; sponsor: Signer };

// A node rejection is attributed to an assertion by its text or its program counter.
const rejectedBy = (error: unknown, spec: any, assertion: string) => {
  const pcs: number[] = spec.sourceInfo?.approval.sourceInfo.filter((s: any) => s.errorMessage === assertion).flatMap((s: any) => s.pc) ?? [];
  const message = String((error as Error)?.message);
  return message.includes(assertion) || pcs.some(pc => new RegExp(`pc[= :]+${pc}(?:\\D|$)`).test(message));
};
const enrolled = async (chain: OpenedChain, { app, provider }: Deployments, owner: Uint8Array) => {
  const wallet = await chain.wallets(app, provider).discover(owner);
  if (!wallet.enrolled) throw new ChainError("not_enrolled", "No enrolled wallet");
  return wallet;
};

/** The demo ASA: 100 000 whole units created by `creator`. */
export async function createDemoAsset(chain: OpenedChain, creator: Signer) {
  const sender = chain.internal.use(creator);
  return String((await chain.internal.algorand.send.assetCreate({ sender, total: 100_000n, decimals: 0, assetName: "AlgoZKAuth Test", unitName: "ZK6" })).assetId);
}

/** Pays ALGO into an enrolled wallet. */
export async function fundWallet(chain: OpenedChain, deployments: Deployments, o: { owner: Uint8Array; funder: Signer; amount: bigint }) {
  const wallet = await enrolled(chain, deployments, o.owner);
  await chain.internal.algorand.send.payment({ sender: chain.internal.use(o.funder), receiver: wallet.address!, amount: microAlgos(o.amount) });
  return chain.wallets(deployments.app, deployments.provider).discover(o.owner);
}

/** Sends an ASA the wallet has opted in to. */
export async function seedWallet(chain: OpenedChain, deployments: Deployments, o: { owner: Uint8Array; funder: Signer; assetId: string; amount: bigint }) {
  const wallet = await enrolled(chain, deployments, o.owner);
  if (!wallet.assets.some(a => a.id === o.assetId)) throw new ChainError("rejected", "Opt in before seeding the demo ASA");
  await chain.internal.algorand.send.assetTransfer({ sender: chain.internal.use(o.funder), receiver: wallet.address!, assetId: BigInt(o.assetId), amount: o.amount });
  return chain.wallets(deployments.app, deployments.provider).discover(o.owner);
}

/** Resubmits a confirmed execution; the node must reject it for its nonce and leave the wallet unchanged. */
export async function checkReplay(chain: OpenedChain, { app, provider }: Deployments, o: Execution) {
  const wallets = chain.wallets(app, provider);
  const owner = Buffer.from(o.plan.owner, "base64url");
  const current = await wallets.discover(owner);
  if (o.plan.operation === "0" || BigInt(current.nonce) <= BigInt(o.plan.nonce)) throw new ChainError("rejected", "First confirm a wallet execution before checking replay");
  const { group } = await wallets.build(o.proof, o.plan, o.signature, chain.internal.use(o.sponsor));
  const signed = await (await (await group.composer()).build()).atc.gatherSignatures();
  try { await chain.internal.algorand.client.algod.sendRawTransaction(signed).do(); }
  catch (error) {
    if (!rejectedBy(error, chain.internal.WALLET_SPEC, "Wrong action nonce")) throw new ChainError("rejected", "Node rejected replay for an unclassified reason");
    return { replayRejectedByNode: true, noncePreserved: (await wallets.discover(owner)).nonce === current.nonce };
  }
  throw new ChainError("rejected", "Unexpected replay acceptance");
}

/** Uses one identity's proof and session signature against another identity's wallet; the node must reject it. */
export async function checkIsolation(chain: OpenedChain, { app, provider }: Deployments, o: Execution & { otherWalletId: string }) {
  const { algorand, walletFactory, WALLET_SPEC, notePrefix } = chain.internal;
  const wallets = chain.wallets(app, provider);
  const sponsor = chain.internal.use(o.sponsor);
  // First verify the existing proof and its previously confirmed signature.
  await wallets.build(o.proof, o.plan, o.signature, sponsor);
  const ctx = await wallets.proofContext(o.proof);
  const other = walletFactory.getAppClientById({ appId: BigInt(o.otherWalletId) });
  const otherOwner = (await other.state.global.getAll()).owner!.asByteArray()!;
  if (Buffer.from(otherOwner).equals(ctx.owner)) throw new ChainError("rejected", "Isolation check requires another identity");
  const before = await wallets.discover(otherOwner);
  const g = other.newGroup();
  await ctx.verifier.verificationParams({ proof: ctx.proof, signals: ctx.signals, composer: g, paramsCallback: async ({ lsigParams, args }: any) => {
    g.execute({ ...lsigParams, args: { ...args, operation: 1n, recipient: sponsor, assetId: 0n, amount: 10_000n, nonce: BigInt(before.nonce), signature: o.signature }, appReferences: [wallets.keysAppId], accountReferences: [sponsor], boxReferences: [{ appId: wallets.keysAppId, name: Buffer.concat([Buffer.from("gk:"), ctx.keyHash]) }] });
    g.addTransaction(await algorand.createTransaction.payment({ sender: sponsor, receiver: sponsor, amount: microAlgos(0), staticFee: microAlgos(GROUP_FEE_MICROALGOS), note: `${notePrefix}-isolation-${randomUUID()}` }));
  } } as any);
  const signed = await (await (await g.composer()).build()).atc.gatherSignatures();
  try { await algorand.client.algod.sendRawTransaction(signed).do(); }
  catch (error) {
    if (!rejectedBy(error, WALLET_SPEC, "Wrong owner")) throw new ChainError("rejected", "Node rejected isolation check for an unclassified reason");
    const after = await wallets.discover(otherOwner);
    if (after.nonce !== before.nonce || after.balanceMicroAlgos !== before.balanceMicroAlgos) throw new ChainError("rejected", "Isolation check changed the other wallet");
    return { available: true, otherWalletId: o.otherWalletId, otherWalletAddress: before.address, wrongOwnerRejectedByNode: true, otherNonceAndBalancePreserved: true, mappedAssertion: "Wrong owner" };
  }
  throw new ChainError("rejected", "Unexpected isolation acceptance");
}

// Each login provider has its own demo deployment: its circuit's verifier LogicSig,
// a key registry holding only that provider's keys, and its OAuth audience. The
// caller passes the provider from packages/protocol/src/oidc-providers.mjs.
type DemoProvider = { id: string; label: string; circuit: { directory: string; name: string }; deployment: string };

/**
 * The TestNet demo (scripts/demo/phase6-server.mjs, scripts/demo/deploy-demo.mjs). One
 * mnemonic is administrator, sponsor and funder; the record at provider.deployment
 * keeps its original format. `network` is for LocalNet checks of this wrapper.
 */
export async function openDemoChain(options: { root: string; mnemonic: string; audience: string; deploy?: boolean; guardian?: string; provider: DemoProvider; network?: "testnet" | "localnet" }) {
  const { root, mnemonic, audience, provider } = options;
  if (!provider?.circuit || !provider.deployment) throw new Error("Unsupported login provider");
  const network = options.network ?? "testnet";
  let chain: OpenedChain;
  try { chain = await openChain({ network, root, notePrefix: "phase6" }); }
  catch (error) { if (error instanceof ChainError && error.code === "wrong_network") throw new Error("Demo requires TestNet"); throw error; }
  const { algorand, serial } = chain.internal;
  const payer = algorand.account.fromMnemonic(mnemonic);
  const sponsor: Signer = { addr: payer.addr.toString(), signer: payer.signer };
  const audienceHash = createHash("sha256").update(audience, "ascii").digest("base64url");
  const verifier = await chain.internal.providerContext(provider.id);
  const storage = resolve(root, provider.deployment);
  let config: any;
  const persist = () => {
    writeFileSync(storage + ".tmp", JSON.stringify(config), { mode: 0o600 }); renameSync(storage + ".tmp", storage);
  };
  if (existsSync(storage)) {
    config = JSON.parse(readFileSync(storage, "utf8"));
    if (config.network !== chain.genesisId || config.genesisHash !== chain.genesisHash || config.audienceHash !== audienceHash || config.verificationKeySha256 !== verifier.vkSha256 || config.verifier !== verifier.address || config.sponsor !== sponsor.addr) throw new Error("Existing demo deployment does not match this configuration");
  } else {
    if (!options.deploy) throw new Error("Run scripts/demo/deploy-demo.sh before starting the demo");
    const balance = await algorand.client.algod.accountInformation(payer.addr).do();
    if (balance.amount - balance.minBalance < 5_000_000n) throw new Error("Demo needs 5 test ALGO spendable for deployment, two wallets, funding and fees");
    if (!options.guardian) throw new Error("Set KEY_GUARDIAN_ADDRESS or KEY_GUARDIAN_MNEMONIC; the guardian can veto key approvals during the 24-hour delay");
    const deployed = await chain.deployProvider({ provider: provider.id, administrator: sponsor, guardian: options.guardian });
    const registry = await chain.deployApp({ provider: deployed, app: provider.id, audience, funder: sponsor });
    const demoAssetId = await createDemoAsset(chain, sponsor);
    config = { network: chain.genesisId, genesisHash: chain.genesisHash, audienceHash, verificationKeySha256: deployed.verificationKeySha256, verifier: deployed.verifier, sponsor: sponsor.addr, keyRegistryId: deployed.keyRegistryId, registryId: registry.registryId, demoAssetId, enrollmentDeposit: registry.enrollmentDeposit, groupFeeMicroAlgos: registry.groupFeeMicroAlgos, createdAt: new Date().toISOString(), fundedWallets: [], seededWallets: [], approvedKeys: [] };
    persist();
  }
  // The legacy record names one mnemonic for every role and does not store the guardian.
  const deployments: Deployments = {
    provider: { network, genesisHash: config.genesisHash, provider: provider.id, verifier: config.verifier, verificationKeySha256: config.verificationKeySha256, keyRegistryId: config.keyRegistryId, guardian: "", administrator: config.sponsor, createdAt: config.createdAt },
    app: { app: provider.id, provider: provider.id, audience, audienceHash: config.audienceHash, registryId: config.registryId, enrollmentDeposit: config.enrollmentDeposit, groupFeeMicroAlgos: config.groupFeeMicroAlgos },
  };
  const keys = chain.keys(deployments.provider);
  const wallets = chain.wallets(deployments.app, deployments.provider);
  try { await wallets.verify({ sender: sponsor.addr }); }
  catch (error) {
    if (!(error instanceof ChainError)) throw error;
    throw new Error(/deposit/.test(error.message) ? "Enrollment deposit changed" : "On-chain registry policy differs from configured deployment");
  }
  const publicConfig = () => ({ ...Object.fromEntries(Object.entries(config).filter(([k]) => !["fundedWallets", "seededWallets"].includes(k))), latestTimestamp: undefined });
  const recordKey = (change: KeyChange) => {
    if (change.kind === "registered") {
      config.approvedKeys.push({ fingerprint: change.fingerprint, validFrom: change.validFrom, validUntil: change.validUntil }); persist();
      return;
    }
    const entry = config.approvedKeys.find((k: any) => k.fingerprint === change.fingerprint);
    if (entry) { entry.renewedUntil = change.renewedUntil; entry.renewalEffectiveAt = change.renewalEffectiveAt; persist(); }
  };
  const ensureKeys = async (jwks: any) => { await keys.ensureKeys({ jwks, administrator: sponsor, onChange: recordKey }); };
  const prepare = async (result: ProofResult, request: any) => {
    let plan: ActionPlan;
    try { plan = await wallets.prepare({ proof: result, request, sponsor: config.sponsor }); }
    catch (error) {
      if (error instanceof ChainError && /^Invalid ASA (opt-in|transfer)$/.test(error.message)) throw new ChainError(error.code, error.message.replace("Invalid ASA", "Invalid demo ASA"));
      throw error;
    }
    if (request.operation === "2" && plan.assetId !== config.demoAssetId) throw new ChainError("rejected", "Invalid demo ASA opt-in");
    if (request.operation === "3" && plan.assetId !== config.demoAssetId) throw new ChainError("rejected", "Invalid demo ASA transfer");
    const { version: _version, ...demoPlan } = plan;
    return demoPlan;
  };
  const submit = async (result: ProofResult, action: ActionPlan, signature: Uint8Array) => {
    const sent = await wallets.submit({ proof: result, plan: action, signature, sponsor });
    const { metrics } = sent;
    return { wallet: sent.wallet, measurement: { operation: action.operation, amount: action.amount, assetId: action.assetId, recipient: action.recipient, nonce: action.nonce, [`genuine${provider.label}Token`]: true, transactionIds: sent.transactionIds, confirmedRound: sent.confirmedRound, confirmationMs: metrics.confirmationMs, groupFeeMicroAlgos: sent.groupFeeMicroAlgos, outerTransactions: metrics.outerTransactions, innerTransactions: metrics.innerTransactions, signedBytes: metrics.signedBytes, appBudgetConsumed: metrics.appBudgetConsumed, logicSigBudgetConsumed: metrics.logicSigBudgetConsumed } };
  };
  const replay = (result: ProofResult, action: ActionPlan, signature: Uint8Array) => serial(() => checkReplay(chain, deployments, { proof: result, plan: action, signature, sponsor }));
  const isolation = (result: ProofResult, action: ActionPlan, signature: Uint8Array, otherWalletId: string) =>
    serial(() => checkIsolation(chain, deployments, { proof: result, plan: action, signature, sponsor, otherWalletId }));
  // At most four wallets are funded, and four seeded, per deployment.
  const fund = (owner: Uint8Array, seed: boolean) => serial(async () => {
    const w = await enrolled(chain, deployments, owner);
    const list = seed ? config.seededWallets : config.fundedWallets;
    if (!list.includes(w.walletId)) {
      if (list.length >= 4) throw new ChainError("rejected", "POC funding cap reached");
      if (seed) await seedWallet(chain, deployments, { owner, funder: sponsor, assetId: config.demoAssetId, amount: 100n });
      else await fundWallet(chain, deployments, { owner, funder: sponsor, amount: 1_000_000n });
      list.push(w.walletId); persist();
    }
    return wallets.discover(owner);
  });
  return { config: publicConfig, time: chain.time, ensureKeys, snapshot: wallets.discover, prepare, submit, replay, isolation, fund, close: () => chain.close() };
}
