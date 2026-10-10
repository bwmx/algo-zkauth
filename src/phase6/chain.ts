// Copied to the pinned checkout by prepare-demo.sh for its SDK/typed clients.
import { AlgorandClient, microAlgos } from "@algorandfoundation/algokit-utils";
import { decodeAddress, getApplicationAddress } from "algosdk";
import * as snarkjs from "snarkjs";
import { Groth16Bn254LsigVerifier, encodeGroth16Bn254Proof } from "../groth16";
import { GoogleKeyRegistryFactory } from "../../contracts/clients/GoogleKeyRegistry";
import { WalletRegistryFactory } from "../../contracts/clients/WalletRegistry";
import { UserWalletFactory, APP_SPEC as WALLET_SPEC } from "../../contracts/clients/UserWallet";
import { createHash, createPublicKey, verify, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { actionDigest, signalDigest } from "../phase4/action.mjs";

export async function openDemoChain(options: { root: string; mnemonic: string; audience: string; deploy?: boolean }) {
  const { root, mnemonic, audience } = options;
  const algorand = AlgorandClient.testNet();
  const payer = algorand.account.fromMnemonic(mnemonic);
  const params = await algorand.client.algod.getTransactionParams().do();
  if (params.genesisID !== "testnet-v1.0") throw new Error("Demo requires TestNet");
  const genesis = Buffer.from(params.genesisHash!);
  const audienceHash = createHash("sha256").update(audience, "ascii").digest();
  const vkFile = resolve(root, "fixtures/phase3/verification_key.json");
  const vk = JSON.parse(readFileSync(vkFile, "utf8"));
  const vkHash = createHash("sha256").update(readFileSync(vkFile)).digest("hex");
  const storage = resolve(root, ".local/phase6/deployment.json");
  const verifier = new Groth16Bn254LsigVerifier({ algorand, appOffset: 0, totalLsigs: 6, zKey: resolve(root, "fixtures/phase3/google_jwt.zkey"), wasmProver: resolve(root, "fixtures/phase3/google_jwt_js/google_jwt.wasm") });
  const lsig = await verifier.lsigAccount();
  // @ts-expect-error snarkjs does not type curves
  const curve = await snarkjs.curves.getCurveFromName("bn128");
  let config: any;
  const persist = () => {
    writeFileSync(storage + ".tmp", JSON.stringify(config), { mode: 0o600 }); renameSync(storage + ".tmp", storage);
  };
  const keyFactory = new GoogleKeyRegistryFactory({ algorand, defaultSender: payer });
  const registryFactory = new WalletRegistryFactory({ algorand, defaultSender: payer });
  const walletFactory = new UserWalletFactory({ algorand, defaultSender: payer });
  const time = async () => {
    const status = await algorand.client.algod.status().do();
    return (await algorand.client.algod.block(status.lastRound).do()).block.header.timestamp;
  };
  if (existsSync(storage)) {
    config = JSON.parse(readFileSync(storage, "utf8"));
    if (config.network !== "testnet-v1.0" || config.genesisHash !== genesis.toString("base64url") || config.audienceHash !== audienceHash.toString("base64url") || config.verificationKeySha256 !== vkHash || config.verifier !== lsig.addr.toString() || config.sponsor !== payer.addr.toString()) throw new Error("Existing demo deployment does not match this configuration");
  } else {
    if (!options.deploy) throw new Error("Run scripts/deploy-demo.sh before starting the demo");
    const balance = await algorand.client.algod.accountInformation(payer.addr).do();
    if (balance.amount - balance.minBalance < 5_000_000n) throw new Error("Demo needs 5 test ALGO spendable for deployment, two wallets, funding and fees");
    const { appClient: keys } = await keyFactory.send.create.createApplication({ args: {} });
    // Four key boxes plus buffer. They are registered from authenticated Google JWKS.
    await algorand.send.payment({ sender: payer, receiver: keys.appAddress, amount: microAlgos(300_000) });
    const { appClient: registry } = await registryFactory.send.create.createApplication({ args: { verifier: lsig.addr.toString(), keyRegistry: keys.appId, audience: audienceHash }, appReferences: [keys.appId] });
    await algorand.send.payment({ sender: payer, receiver: registry.appAddress, amount: microAlgos(100_000) });
    const asset = await algorand.send.assetCreate({ sender: payer, total: 100_000n, decimals: 0, assetName: "AlgoZKAuth Test", unitName: "ZK6" });
    config = { network: "testnet-v1.0", genesisHash: genesis.toString("base64url"), audienceHash: audienceHash.toString("base64url"), verificationKeySha256: vkHash, verifier: lsig.addr.toString(), sponsor: payer.addr.toString(), keyRegistryId: String(keys.appId), registryId: String(registry.appId), demoAssetId: String(asset.assetId), enrollmentDeposit: "454800", groupFeeMicroAlgos: "20000", createdAt: new Date().toISOString(), fundedWallets: [], seededWallets: [], approvedKeys: [] };
    persist();
  }
  const keys = keyFactory.getAppClientById({ appId: BigInt(config.keyRegistryId) });
  const registry = registryFactory.getAppClientById({ appId: BigInt(config.registryId) });
  const state = await registry.state.global.getAll();
  if (state.verifier !== config.verifier || state.keyRegistry !== BigInt(config.keyRegistryId) || !Buffer.from(state.audience!.asByteArray()!).equals(audienceHash)) throw new Error("On-chain registry policy differs from configured deployment");
  const deposit = (await registry.send.enrollmentDeposit()).return!;
  if (String(deposit) !== config.enrollmentDeposit) throw new Error("Enrollment deposit changed");
  let queue: Promise<any> = Promise.resolve();
  const serial = <T>(callback: () => Promise<T>): Promise<T> => {
    const next = queue.then(callback); queue = next.catch(() => {}); return next;
  };
  const publicConfig = () => ({ ...Object.fromEntries(Object.entries(config).filter(([k]) => !["fundedWallets", "seededWallets"].includes(k))), latestTimestamp: undefined });
  const snapshot = async (owner: Uint8Array) => {
    let id = 0n;
    try {
      const box = await algorand.client.algod.getApplicationBoxByName(registry.appId, Buffer.concat([Buffer.from("w:"), owner])).do();
      if (box.value.length !== 8) throw new Error("Invalid canonical wallet box");
      id = Buffer.from(box.value).readBigUInt64BE();
    } catch (error: any) { if (error.status !== 404) throw error; }
    if (!id) return { walletId: "0", address: null, nonce: "0", balanceMicroAlgos: "0", minBalanceMicroAlgos: "0", assets: [], enrolled: false };
    const wallet = walletFactory.getAppClientById({ appId: id });
    const s = await wallet.state.global.getAll();
    if (!Buffer.from(s.owner!.asByteArray()!).equals(Buffer.from(owner)) || s.registry !== registry.appId || s.keyRegistry !== keys.appId || s.verifier !== config.verifier || !Buffer.from(s.audience!.asByteArray()!).equals(audienceHash) || wallet.appAddress.toString() !== getApplicationAddress(id).toString()) throw new Error("Discovered wallet owner/address/policy mismatch");
    const account = await algorand.client.algod.accountInformation(wallet.appAddress).do();
    return { walletId: String(id), address: wallet.appAddress.toString(), nonce: String(s.nonce), balanceMicroAlgos: String(account.amount), minBalanceMicroAlgos: String(account.minBalance), assets: (account.assets ?? []).map(a => ({ id: String(a.assetId), amount: String(a.amount) })), enrolled: true };
  };
  const ensureGoogleKeys = (jwks: any) => serial(async () => {
    const now = await time();
    for (const jwk of jwks.keys) {
      const modulus = Buffer.from(jwk.n ?? "", "base64url");
      if (jwk.kty !== "RSA" || jwk.e !== "AQAB" || modulus.length !== 256 || jwk.alg !== "RS256" || jwk.use !== "sig") continue;
      const hash = createHash("sha256").update(modulus).digest();
      let existing;
      try { existing = await keys.state.box.keys.value(hash); }
      catch (error: any) { if (error.status !== 404) throw error; }
      if (!existing) {
        const info = await algorand.client.algod.accountInformation(keys.appAddress).do();
        if (info.amount - info.minBalance < 50_000n) await algorand.send.payment({ sender: payer, receiver: keys.appAddress, amount: microAlgos(100_000) });
        await keys.send.registerKey({ args: { keyHash: hash, validFrom: now - 60n, validUntil: now + 7n * 86400n }, boxReferences: [Buffer.concat([Buffer.from("gk:"), hash])] });
        config.approvedKeys.push({ fingerprint: hash.toString("base64url"), validFrom: String(now - 60n), validUntil: String(now + 7n * 86400n) }); persist();
      }
    }
  });
  const proofContext = async (result: any) => {
    const signals = result.publicSignals.map(BigInt) as bigint[];
    if (signals.length !== 12 || !signalDigest(signals, 8).equals(genesis) || !signalDigest(signals, 4).equals(audienceHash) || !(await snarkjs.groth16.verify(vk, result.publicSignals, result.proof))) throw new Error("Invalid proof or network/audience binding");
    const now = await time();
    if (signals[10]! <= now + 15n || signals[11]! > now || signals[10]! > now + 600n) throw new Error("Session expired or inactive; renew Google login and prove again");
    const keyHash = signalDigest(signals, 2);
    const key = await keys.state.box.keys.value(keyHash);
    if (!key || key.revoked || key.validFrom > now || key.validUntil < signals[10]! || key.validUntil <= now || (await keys.state.global.paused()) !== 0n) throw new Error("Google key policy is inactive");
    return { signals, owner: signalDigest(signals, 0), keyHash, proof: encodeGroth16Bn254Proof(structuredClone(result.proof), curve) };
  };
  const prepare = async (result: any, request: any) => {
    const { signals, owner } = await proofContext(result);
    const wallet = await snapshot(owner);
    const enrollment = request.operation === "0";
    if (enrollment && wallet.enrolled) throw new Error("Wallet already exists; use discovery");
    if (!enrollment && !wallet.enrolled) throw new Error("Enroll the original identity first");
    if (!["0", "1", "2", "3"].includes(request.operation)) throw new Error("Unsupported wallet operation");
    const recipient = enrollment ? config.sponsor : request.recipient;
    const recipientPublicKey = Buffer.from(decodeAddress(recipient).publicKey).toString("base64url");
    const amount = enrollment ? config.enrollmentDeposit : request.amount;
    const assetId = enrollment ? "0" : request.assetId;
    for (const v of [amount, assetId]) if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(v) || BigInt(v) > 0xffffffffffffffffn) throw new Error("Invalid action uint64");
    if (request.operation === "1" && (assetId !== "0" || BigInt(amount) === 0n)) throw new Error("ALGO transfer requires positive amount and asset 0");
    if (request.operation === "2" && (recipient !== wallet.address || assetId !== config.demoAssetId || amount !== "0")) throw new Error("Invalid demo ASA opt-in");
    if (request.operation === "3" && (assetId !== config.demoAssetId || BigInt(amount) === 0n)) throw new Error("Invalid demo ASA transfer");
    return { planId: randomUUID(), genesisHash: config.genesisHash, registryId: config.registryId, walletId: enrollment ? "0" : wallet.walletId, owner: owner.toString("base64url"), operation: request.operation, recipient, recipientPublicKey, assetId, amount, nonce: enrollment ? "0" : wallet.nonce, sessionExpiresAt: String(signals[10]) };
  };
  const build = async (result: any, action: any, signature: Uint8Array) => {
    const { signals, owner, keyHash, proof } = await proofContext(result);
    if (action.genesisHash !== config.genesisHash || action.registryId !== config.registryId || action.owner !== owner.toString("base64url") || action.sessionExpiresAt !== String(signals[10])) throw new Error("Action context mismatch");
    const digest = actionDigest({ ...action, genesisHash: genesis, registryId: BigInt(action.registryId), walletId: BigInt(action.walletId), owner, operation: BigInt(action.operation), recipient: decodeAddress(action.recipient).publicKey, assetId: BigInt(action.assetId), amount: BigInt(action.amount), nonce: BigInt(action.nonce), sessionExpiresAt: BigInt(action.sessionExpiresAt) });
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: signalDigest(signals, 6).toString("base64url") }, format: "jwk" });
    if (signature.length !== 64 || !verify(null, digest, publicKey, signature)) throw new Error("Browser action signature is invalid");
    const keyBox = Buffer.concat([Buffer.from("gk:"), keyHash]);
    if (action.operation === "0") {
      const g = registry.newGroup();
      g.addTransaction(await algorand.createTransaction.payment({ sender: payer, receiver: registry.appAddress, amount: microAlgos(BigInt(config.enrollmentDeposit)), staticFee: microAlgos(20_000), note: `phase6-enroll-${randomUUID()}` }));
      await verifier.verificationParams({ proof, signals, composer: g, paramsCallback: async ({ lsigParams, args }) => {
        g.enroll({ ...lsigParams, args: { ...args, payer: config.sponsor, signature }, appReferences: [keys.appId], boxReferences: [Buffer.concat([Buffer.from("w:"), owner]), { appId: keys.appId, name: keyBox }] });
      } }); return g;
    }
    const wallet = walletFactory.getAppClientById({ appId: BigInt(action.walletId) });
    const known = await snapshot(owner);
    if (known.walletId !== action.walletId) throw new Error("Action targets another identity's wallet");
    const g = wallet.newGroup();
    await verifier.verificationParams({ proof, signals, composer: g, paramsCallback: async ({ lsigParams, args }) => {
      g.execute({ ...lsigParams, args: { ...args, operation: BigInt(action.operation), recipient: action.recipient, assetId: BigInt(action.assetId), amount: BigInt(action.amount), nonce: BigInt(action.nonce), signature }, appReferences: [keys.appId], accountReferences: [action.recipient], assetReferences: action.assetId === "0" ? [] : [BigInt(action.assetId)], boxReferences: [{ appId: keys.appId, name: keyBox }] });
      g.addTransaction(await algorand.createTransaction.payment({ sender: payer, receiver: payer, amount: microAlgos(0), staticFee: microAlgos(20_000), note: `phase6-action-${randomUUID()}` }));
    } }); return g;
  };
  const submit = (result: any, action: any, signature: Uint8Array) => serial(async () => {
    const before = await snapshot(Buffer.from(action.owner, "base64url"));
    if (action.operation !== "0" && before.nonce !== action.nonce) throw new Error("Action nonce changed; prepare a new action");
    const g = await build(result, action, signature);
    const built = await (await g.composer()).build(); const signed = await built.atc.gatherSignatures();
    const simulated = await g.simulate(); const sim = simulated.simulateResponse.txnGroups[0]!;
    if (sim.failedAt) throw new Error("Wallet simulation rejected the action");
    const started = performance.now(); const sent = await g.send();
    const txns = built.transactions.map(t => t.txn);
    const count = (r: any): number => (r.innerTxns ?? []).reduce((n: number, t: any) => n + 1 + count(t), 0);
    return { wallet: await snapshot(Buffer.from(action.owner, "base64url")), measurement: { operation: action.operation, amount: action.amount, assetId: action.assetId, recipient: action.recipient, nonce: action.nonce, genuineGoogleToken: true, transactionIds: sent.txIds, confirmedRound: String(sent.confirmations[0]?.confirmedRound ?? 0), confirmationMs: Math.round(performance.now() - started), groupFeeMicroAlgos: String(txns.reduce((n, t) => n + t.fee, 0n)), outerTransactions: txns.length, innerTransactions: sim.txnResults.reduce((n, t) => n + count(t.txnResult), 0), signedBytes: signed.reduce((n, t) => n + t.length, 0), appBudgetConsumed: sim.appBudgetConsumed, logicSigBudgetConsumed: sim.txnResults.reduce((n, t) => n + (t.logicSigBudgetConsumed ?? 0), 0) } };
  });
  const replay = (result: any, action: any, signature: Uint8Array) => serial(async () => {
    const current = await snapshot(Buffer.from(action.owner, "base64url"));
    if (action.operation === "0" || BigInt(current.nonce) <= BigInt(action.nonce)) throw new Error("First confirm a wallet execution before checking replay");
    const g = await build(result, action, signature);
    const signed = await (await (await g.composer()).build()).atc.gatherSignatures();
    try { await algorand.client.algod.sendRawTransaction(signed).do(); }
    catch (error: any) {
      const info = WALLET_SPEC.sourceInfo?.approval.sourceInfo.find(s => s.errorMessage === "Wrong action nonce");
      const message = String(error.message);
      if (!message.includes("Wrong action nonce") && !info?.pc?.some(pc => new RegExp(`pc[= :]+${pc}(?:\\D|$)`).test(message))) throw new Error("Node rejected replay for an unclassified reason");
      return { replayRejectedByNode: true, noncePreserved: (await snapshot(Buffer.from(action.owner, "base64url"))).nonce === current.nonce };
    }
    throw new Error("Unexpected replay acceptance");
  });
  const fund = (owner: Uint8Array, seed: boolean) => serial(async () => {
    const w = await snapshot(owner); if (!w.enrolled) throw new Error("No enrolled wallet");
    const list = seed ? config.seededWallets : config.fundedWallets;
    if (!list.includes(w.walletId)) {
      if (list.length >= 4) throw new Error("POC funding cap reached");
      if (seed) {
        if (!w.assets.some(a => a.id === config.demoAssetId)) throw new Error("Opt in before seeding the demo ASA");
        await algorand.send.assetTransfer({ sender: payer, receiver: w.address!, assetId: BigInt(config.demoAssetId), amount: 100n });
      } else await algorand.send.payment({ sender: payer, receiver: w.address!, amount: microAlgos(1_000_000) });
      list.push(w.walletId); persist();
    } return snapshot(owner);
  });
  const isolation = (result: any, originalAction: any, signature: Uint8Array, otherWalletId: string) => serial(async () => {
    // First verify the existing proof and its previously confirmed signature.
    await build(result, originalAction, signature);
    const ctx = await proofContext(result);
    const other = walletFactory.getAppClientById({ appId: BigInt(otherWalletId) });
    const otherState = await other.state.global.getAll();
    const otherOwner = otherState.owner!.asByteArray()!;
    if (Buffer.from(otherOwner).equals(ctx.owner)) throw new Error("Isolation check requires another identity");
    const before = await snapshot(otherOwner);
    const g = other.newGroup();
    await verifier.verificationParams({ proof: ctx.proof, signals: ctx.signals, composer: g, paramsCallback: async ({ lsigParams, args }) => {
      g.execute({ ...lsigParams, args: { ...args, operation: 1n, recipient: config.sponsor, assetId: 0n, amount: 10_000n, nonce: BigInt(before.nonce), signature }, appReferences: [keys.appId], accountReferences: [config.sponsor], boxReferences: [{ appId: keys.appId, name: Buffer.concat([Buffer.from("gk:"), ctx.keyHash]) }] });
      g.addTransaction(await algorand.createTransaction.payment({ sender: payer, receiver: payer, amount: microAlgos(0), staticFee: microAlgos(20_000), note: `phase6-isolation-${randomUUID()}` }));
    } });
    const signed = await (await (await g.composer()).build()).atc.gatherSignatures();
    try { await algorand.client.algod.sendRawTransaction(signed).do(); }
    catch (error: any) {
      const pcs = WALLET_SPEC.sourceInfo?.approval.sourceInfo.filter(s => s.errorMessage === "Wrong owner").flatMap(s => s.pc) ?? [];
      if (!String(error.message).includes("Wrong owner") && !pcs.some(pc => new RegExp(`pc[= :]+${pc}(?:\\D|$)`).test(String(error.message)))) throw new Error("Node rejected isolation check for an unclassified reason");
      const after = await snapshot(otherOwner);
      if (after.nonce !== before.nonce || after.balanceMicroAlgos !== before.balanceMicroAlgos) throw new Error("Isolation check changed the other wallet");
      return { available: true, otherWalletId, otherWalletAddress: before.address, wrongOwnerRejectedByNode: true, otherNonceAndBalancePreserved: true, mappedAssertion: "Wrong owner" };
    }
    throw new Error("Unexpected isolation acceptance");
  });
  return { config: publicConfig, time, ensureGoogleKeys, snapshot, prepare, submit, replay, isolation, fund, close: () => curve.terminate() };
}
