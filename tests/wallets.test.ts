import { expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { AlgorandClient, microAlgos } from "@algorandfoundation/algokit-utils";
import { decodeAddress, OnApplicationComplete, waitForConfirmation } from "algosdk";
import * as snarkjs from "snarkjs";
import { encodeGroth16Bn254Proof, Groth16Bn254LsigVerifier } from "../src/groth16";
import { GoogleKeyRegistryFactory } from "../contracts/clients/GoogleKeyRegistry";
import { WalletRegistryFactory } from "../contracts/clients/WalletRegistry";
import { UserWalletFactory, type UserWalletClient } from "../contracts/clients/UserWallet";
import { actionDigest, signalDigest } from "../src/phase4/action.mjs";

const root = resolve(process.cwd(), "../..");
const read = (file: string) => JSON.parse(readFileSync(resolve(root, file), "utf8"));
const rejection = /assert|logic eval|rejected|overspend|below min|balance|opted|invalid|not allowed/i;

it("enrolls two independent wallets and enforces the complete proof/action path on LocalNet", async () => {
  const algorand = AlgorandClient.defaultLocalNet();
  if (BigInt((await algorand.client.algod.getBlockOffsetTimestamp().do()).offset) !== 0n)
    throw new Error("Run wallet tests through scripts/run-wallet-localnet.sh for controlled clock setup/restoration");
  const payer = await algorand.account.localNetDispenser();
  const recipient = algorand.account.random();
  await algorand.account.ensureFunded(recipient, payer, microAlgos(1_000_000));
  const genesis = (await algorand.client.algod.getTransactionParams().do()).genesisHash!;
  const nodeTime = async () => {
    const status = await algorand.client.algod.status().do();
    return (await algorand.client.algod.block(status.lastRound).do()).block.header.timestamp;
  };
  const now = await nodeTime();
  const sessions = ["alice", "bob"].map((name) => {
    const data = read(`.local/phase4/${name}-session.json`);
    return {
      rawProof: data.proof, rawSignals: data.signals,
      signals: data.signals.map(BigInt) as bigint[],
      key: createPrivateKey({ key: data.privateKey, format: "jwk" }),
    };
  });
  for (const session of sessions) {
    expect(signalDigest(session.signals, 8)).toEqual(Buffer.from(genesis));
    if (session.signals[10]! <= now + 15n) throw new Error("Generate fresh Phase 4 proofs before running wallet tests");
    expect(await snarkjs.groth16.verify(read("fixtures/phase3/verification_key.json"), session.rawSignals, session.rawProof)).toBe(true);
  }
  const checks: string[] = [];
  const benchmarks: Record<string, unknown>[] = [];
  // @ts-expect-error snarkjs does not type curves
  const curve = await snarkjs.curves.getCurveFromName("bn128");
  try {
    const proofs = sessions.map((s) => encodeGroth16Bn254Proof(s.rawProof, curve));
    const verifier = new Groth16Bn254LsigVerifier({ algorand, appOffset: 0, totalLsigs: 6,
      zKey: resolve(root, "fixtures/phase3/google_jwt.zkey"),
      wasmProver: resolve(root, "fixtures/phase3/google_jwt_js/google_jwt.wasm"),
    });
    const lsig = await verifier.lsigAccount();
    const { appClient: keys } = await new GoogleKeyRegistryFactory({ algorand, defaultSender: payer })
      .send.create.createApplication({ args: {} });
    await algorand.send.payment({ sender: payer, receiver: keys.appAddress, amount: microAlgos(125_000) });
    const keyHash = signalDigest(sessions[0]!.signals, 2);
    expect(signalDigest(sessions[1]!.signals, 2)).toEqual(keyHash);
    const keyBox = Buffer.concat([Buffer.from("gk:"), keyHash]);
    await keys.send.registerKey({ args: { keyHash, validFrom: now, validUntil: now + 7200n }, boxReferences: [keyBox] });
    const registryFactory = new WalletRegistryFactory({ algorand, defaultSender: payer });
    const config = { verifier: lsig.addr.toString(), keyRegistry: keys.appId, audience: signalDigest(sessions[0]!.signals, 4) };
    const { appClient: registry } = await registryFactory.send.create.createApplication({ args: config, appReferences: [keys.appId] });
    await algorand.send.payment({ sender: payer, receiver: registry.appAddress, amount: microAlgos(100_000) });
    const deposit = (await registry.send.enrollmentDeposit()).return!;
    const owners = sessions.map((s) => signalDigest(s.signals, 0));
    const walletBox = (index: number) => Buffer.concat([Buffer.from("w:"), owners[index]!]);
    const lookup = async (index: number) => (await registry.send.lookup({ args: { owner: owners[index]! }, boxReferences: [walletBox(index)] })).return!;
    expect(await lookup(0)).toBe(0n);
    const signAction = (index: number, action: Parameters<typeof actionDigest>[0], wrongKey = false) =>
      sign(null, actionDigest(action), wrongKey ? generateKeyPairSync("ed25519").privateKey : sessions[index]!.key);
    const enrollmentAction = (index: number) => ({ genesisHash: genesis, registryId: registry.appId, walletId: 0n,
      owner: owners[index]!, operation: 0n, recipient: decodeAddress(payer.addr.toString()).publicKey,
      assetId: 0n, amount: deposit, nonce: 0n, sessionExpiresAt: sessions[index]!.signals[10]!,
    });
    let unique = 0;
    const enrollment = async (index: number, options: { badSignature?: boolean; paymentAmount?: bigint; rekeyPayment?: boolean; ownerSignals?: bigint[]; normalSender?: boolean; onComplete?: OnApplicationComplete } = {}) => {
      const group = registry.newGroup();
      group.addTransaction(await algorand.createTransaction.payment({ sender: payer, receiver: registry.appAddress,
        amount: microAlgos(options.paymentAmount ?? deposit), staticFee: microAlgos(20_000),
        ...(options.rekeyPayment ? { rekeyTo: recipient.addr } : {}), note: `phase4-enroll-${Date.now()}-${unique++}` }));
      await verifier.verificationParams({ proof: proofs[index]!, signals: options.ownerSignals ?? sessions[index]!.signals,
        composer: group, paramsCallback: async ({ lsigParams, args }) => {
          group.enroll({ ...lsigParams,
            ...(options.normalSender ? { sender: payer, signer: payer.signer } : {}),
            ...(options.onComplete !== undefined ? { onComplete: options.onComplete as OnApplicationComplete.NoOpOC } : {}),
            ...(options.onComplete === OnApplicationComplete.UpdateApplicationOC ? { approvalProgram: new Uint8Array([11, 129, 1]), clearStateProgram: new Uint8Array([11, 129, 1]) } : {}),
            args: { ...args, payer: payer.addr.toString(), signature: signAction(index, enrollmentAction(index), options.badSignature) },
            appReferences: [keys.appId], boxReferences: [walletBox(index), { appId: keys.appId, name: keyBox }] });
        },
      });
      return group;
    };
    const signedGroup = async (group: { composer: () => Promise<any> }) => {
      const built = await (await group.composer()).build();
      return { built, signed: await built.atc.gatherSignatures() };
    };
    const reject = async (name: string, group: Parameters<typeof signedGroup>[0], pattern = rejection) => {
      const { signed } = await signedGroup(group);
      await expect(algorand.client.algod.sendRawTransaction(signed).do()).rejects.toThrow(pattern);
      checks.push(name);
    };
    const measureAndSend = async (name: string, group: any) => {
      const { built, signed } = await signedGroup(group);
      const simulation = await group.simulate();
      const sim = simulation.simulateResponse.txnGroups[0]!;
      expect(sim.failedAt).toBeUndefined();
      const innerCount = (result: any): number => (result.innerTxns ?? []).reduce((sum: number, inner: any) => sum + 1 + innerCount(inner), 0);
      const started = performance.now();
      const sent = await group.send();
      const txns = built.transactions.map((t: any) => t.txn);
      const appTxn = txns.find((t: any) => t.applicationCall?.appArgs?.length);
      benchmarks.push({ operation: name, confirmationMs: Math.round(performance.now() - started),
        confirmedRound: String(sent.confirmations[0]?.confirmedRound ?? 0), transactionIds: sent.txIds,
        outerTransactions: txns.length, innerTransactions: sim.txnResults.reduce((sum: number, t: any) => sum + innerCount(t.txnResult), 0),
        groupFeeMicroAlgos: String(txns.reduce((sum: bigint, t: any) => sum + t.fee, 0n)),
        signedBytes: signed.reduce((sum: number, t: Uint8Array) => sum + t.length, 0),
        appArgumentBytes: appTxn.applicationCall.appArgs.map((arg: Uint8Array) => arg.length),
        totalAppArgumentBytes: appTxn.applicationCall.appArgs.reduce((sum: number, arg: Uint8Array) => sum + arg.length, 0),
        appBoxReferences: appTxn.applicationCall.boxes.length,
        appBudgetConsumed: sim.appBudgetConsumed,
        logicSigBudgetConsumed: sim.txnResults.reduce((sum: number, t: any) => sum + (t.logicSigBudgetConsumed ?? 0), 0),
      });
      return sent;
    };

    await reject("attacker session signature cannot enroll observed identity", await enrollment(0, { badSignature: true }));
    await reject("normal sender cannot bypass enrollment proof", await enrollment(0, { normalSender: true }));
    expect(await lookup(0)).toBe(0n);
    await reject("underfunded enrollment is atomic", await enrollment(0, { paymentAmount: deposit - 1n }));
    await reject("rekeying enrollment payment rejected", await enrollment(0, { rekeyPayment: true }));
    for (const onComplete of [OnApplicationComplete.UpdateApplicationOC, OnApplicationComplete.DeleteApplicationOC, OnApplicationComplete.CloseOutOC])
      await reject(`registry on-completion ${onComplete} rejected`, await enrollment(0, { onComplete }));
    const registryBefore = await algorand.client.algod.accountInformation(registry.appAddress).do();
    const competing = await Promise.all([enrollment(0), enrollment(0)]);
    await competing[0]!.simulate();
    const competingSigned = await Promise.all(competing.map(signedGroup));
    // Submit independently signed groups concurrently, bypassing client simulation.
    const race = await Promise.allSettled(competingSigned.map(({ signed }) => algorand.client.algod.sendRawTransaction(signed).do()));
    expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(race.filter((r) => r.status === "rejected")).toHaveLength(1);
    const accepted = race.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ txid: string }>;
    const raceConfirmation = await waitForConfirmation(algorand.client.algod, accepted.value.txid, 5);
    expect(raceConfirmation.confirmedRound).toBeGreaterThan(0n);
    checks.push("simultaneous enrollment creates exactly one wallet");
    const registryAfter = await algorand.client.algod.accountInformation(registry.appAddress).do();
    expect(registryAfter.amount - registryBefore.amount).toBe(deposit - 100_000n);
    expect(registryAfter.minBalance - registryBefore.minBalance).toBe(deposit - 100_000n);
    expect(registryAfter.createdApps).toHaveLength(1);
    checks.push("duplicate enrollment payment and creation roll back together");
    await measureAndSend("enrollment", await enrollment(1));
    const ids = [await lookup(0), await lookup(1)];
    expect(ids[0]).not.toBe(ids[1]);
    expect(await lookup(0)).toBe(ids[0]);
    expect(await lookup(1)).toBe(ids[1]);
    await reject("duplicate enrollment rejected without replacing owner", await enrollment(0));
    checks.push("two identities have distinct immutable wallets and stable discovery");
    const walletFactory = new UserWalletFactory({ algorand, defaultSender: payer });
    const wallets = ids.map((appId) => walletFactory.getAppClientById({ appId: appId! }));
    for (let index = 0; index < 2; index++) {
      const wallet = wallets[index]!;
      expect((await algorand.client.algod.accountInformation(wallet.appAddress).do()).amount).toBe(100_000n);
      const state = await wallet.state.global.getAll();
      expect(state.owner?.asByteArray()).toEqual(new Uint8Array(owners[index]!));
      expect(state.registry).toBe(registry.appId);
      expect(state.keyRegistry).toBe(keys.appId);
      expect(state.verifier).toBe(lsig.addr.toString());
      await algorand.send.payment({ sender: payer, receiver: wallet.appAddress, amount: microAlgos(1_000_000) });
    }
    await expect(walletFactory.send.create.createApplication({ args: { owner: owners[0]!, ...config }, appReferences: [keys.appId] })).rejects.toThrow(/Registry creation required|assert/i);
    checks.push("outer wallet creation cannot spoof registry provenance");
    const currentNonce = async (wallet: UserWalletClient) => (await wallet.send.getNonce()).return!;
    type Operation = { operation: bigint; recipient: string; assetId: bigint; amount: bigint; nonce: bigint };
    const baseOperation = (nonce = 0n): Operation => ({ operation: 1n, recipient: recipient.addr.toString(), assetId: 0n, amount: 10_000n, nonce });
    const walletAction = (walletIndex: number, identityIndex: number, operation: Operation) => ({ genesisHash: genesis,
      registryId: registry.appId, walletId: ids[walletIndex]!, owner: owners[identityIndex]!, ...operation,
      recipient: decodeAddress(operation.recipient).publicKey, sessionExpiresAt: sessions[identityIndex]!.signals[10]!,
    });
    const execution = async (walletIndex: number, identityIndex: number, operation: Operation, options: {
      signedAction?: Parameters<typeof actionDigest>[0]; badSignature?: boolean; signals?: bigint[];
      normalSender?: boolean; rekey?: boolean; prefixPayment?: boolean; onComplete?: OnApplicationComplete;
    } = {}) => {
      const wallet = wallets[walletIndex]!;
      const group = wallet.newGroup();
      if (options.prefixPayment) group.addTransaction(await algorand.createTransaction.payment({ sender: payer, receiver: payer, amount: microAlgos(0) }));
      await verifier.verificationParams({ proof: proofs[identityIndex]!, signals: options.signals ?? sessions[identityIndex]!.signals,
        composer: group, paramsCallback: async ({ lsigParams, args }) => {
          group.execute({ ...lsigParams, ...(options.normalSender ? { sender: payer, signer: payer.signer } : {}),
            ...(options.rekey ? { rekeyTo: recipient.addr } : {}),
            ...(options.onComplete !== undefined ? { onComplete: options.onComplete as OnApplicationComplete.NoOpOC } : {}),
            ...(options.onComplete === OnApplicationComplete.UpdateApplicationOC ? { approvalProgram: new Uint8Array([11, 129, 1]), clearStateProgram: new Uint8Array([11, 129, 1]) } : {}),
            args: { ...args, ...operation, signature: signAction(identityIndex, options.signedAction ?? walletAction(walletIndex, identityIndex, operation), options.badSignature) },
            appReferences: [keys.appId], accountReferences: [operation.recipient],
            assetReferences: operation.assetId ? [operation.assetId] : [], boxReferences: [{ appId: keys.appId, name: keyBox }],
          });
          group.addTransaction(await algorand.createTransaction.payment({ sender: payer, receiver: payer, amount: microAlgos(0),
            staticFee: microAlgos(20_000), note: `phase4-action-${Date.now()}-${unique++}` }));
        },
      });
      return group;
    };
    const nonce0 = await currentNonce(wallets[0]!);
    expect(nonce0).toBe(0n);
    await reject("normal sender cannot bypass Groth16 verification", await execution(0, 0, baseOperation(), { normalSender: true }));
    await reject("wrong identity cannot spend another wallet", await execution(0, 1, baseOperation()));
    await reject("proof possession without session private key cannot spend", await execution(0, 0, baseOperation(), { badSignature: true }));
    for (const field of ["genesisHash", "registryId", "walletId", "owner", "operation", "recipient", "assetId", "amount", "nonce", "sessionExpiresAt"] as const) {
      const action = walletAction(0, 0, baseOperation());
      const original = action[field];
      const changed = typeof original === "bigint" ? original + 1n : Buffer.from(original);
      if (Buffer.isBuffer(changed)) changed[0] = changed[0]! ^ 1;
      await reject(`signature binds ${field}`, await execution(0, 0, baseOperation(), { signedAction: { ...action, [field]: changed } }));
    }
    const alteredSignals = [...sessions[0]!.signals];
    alteredSignals[0] = alteredSignals[0]! + 1n;
    await reject("modified public signal rejected by actual LogicSig", await execution(0, 0, baseOperation(), { signals: alteredSignals }));
    await reject("wallet rekey route rejected", await execution(0, 0, baseOperation(), { rekey: true }));
    await reject("unintended group position rejected", await execution(0, 0, baseOperation(), { prefixPayment: true }));
    for (const onComplete of [OnApplicationComplete.UpdateApplicationOC, OnApplicationComplete.DeleteApplicationOC, OnApplicationComplete.CloseOutOC, OnApplicationComplete.OptInOC, OnApplicationComplete.ClearStateOC]) {
      await reject(`wallet on-completion ${onComplete} rejected`, await execution(0, 0, baseOperation(), { onComplete }));
    }
    expect(await currentNonce(wallets[0]!)).toBe(0n);
    const before = await algorand.client.algod.accountInformation(wallets[0]!.appAddress).do();
    const recipientBefore = await algorand.client.algod.accountInformation(recipient.addr).do();
    await measureAndSend("ALGO transfer", await execution(0, 0, baseOperation()));
    const after = await algorand.client.algod.accountInformation(wallets[0]!.appAddress).do();
    expect(before.amount - after.amount).toBe(10_000n);
    expect(await currentNonce(wallets[0]!)).toBe(1n);
    await reject("replay rejected after successful ALGO action", await execution(0, 0, baseOperation()));
    await reject("underfunded ALGO transfer rolls back nonce", await execution(0, 0, { ...baseOperation(1n), amount: 2_000_000n }));
    expect(await currentNonce(wallets[0]!)).toBe(1n);
    await measureAndSend("second identity ALGO transfer", await execution(1, 1, baseOperation()));
    expect(await currentNonce(wallets[1]!)).toBe(1n);
    expect((await algorand.client.algod.accountInformation(recipient.addr).do()).amount - recipientBefore.amount).toBe(20_000n);
    checks.push("both identities exclusively spend their own ALGO without wallet fee deductions");

    const assetId = (await algorand.send.assetCreate({ sender: payer, total: 1_000n, decimals: 0, assetName: "Phase4LocalNet", unitName: "P4" })).assetId;
    await algorand.send.assetOptIn({ sender: recipient, assetId });
    for (let index = 0; index < 2; index++) {
      const wallet = wallets[index]!;
      await measureAndSend(index ? "second identity ASA opt-in" : "ASA opt-in", await execution(index, index, {
        operation: 2n, recipient: wallet.appAddress.toString(), assetId, amount: 0n, nonce: 1n,
      }));
      await algorand.send.assetTransfer({ sender: payer, receiver: wallet.appAddress, assetId, amount: 100n });
      expect((await algorand.client.algod.accountInformation(wallet.appAddress).do()).minBalance).toBe(200_000n);
      await measureAndSend(index ? "second identity ASA transfer" : "ASA transfer", await execution(index, index, {
        operation: 3n, recipient: recipient.addr.toString(), assetId, amount: 7n, nonce: 2n,
      }));
      expect(await currentNonce(wallet)).toBe(3n);
      expect((await algorand.client.algod.accountAssetInformation(wallet.appAddress, assetId).do()).assetHolding!.amount).toBe(93n);
    }
    const notOptedIn = algorand.account.random();
    await algorand.account.ensureFunded(notOptedIn, payer, microAlgos(100_000));
    await reject("ASA receiver failure rolls back nonce and balance", await execution(0, 0, { operation: 3n, recipient: notOptedIn.addr.toString(), assetId, amount: 1n, nonce: 3n }));
    expect(await currentNonce(wallets[0]!)).toBe(3n);
    expect((await algorand.client.algod.accountAssetInformation(wallets[0]!.appAddress, assetId).do()).assetHolding!.amount).toBe(93n);
    expect((await algorand.client.algod.accountAssetInformation(recipient.addr, assetId).do()).assetHolding!.amount).toBe(14n);
    await reject("second identity cannot spend first wallet ASA", await execution(0, 1, { operation: 3n, recipient: recipient.addr.toString(), assetId, amount: 1n, nonce: 3n }));
    await reject("first identity cannot spend second wallet ASA", await execution(1, 0, { operation: 3n, recipient: recipient.addr.toString(), assetId, amount: 1n, nonce: 3n }));
    await reject("insufficient ASA balance rolls back nonce", await execution(0, 0, { operation: 3n, recipient: recipient.addr.toString(), assetId, amount: 100n, nonce: 3n }));
    const walletBalance = await algorand.client.algod.accountInformation(wallets[0]!.appAddress).do();
    await reject("ALGO transfer cannot drain wallet below minimum", await execution(0, 0, { ...baseOperation(3n), amount: walletBalance.amount - walletBalance.minBalance + 1n }));
    expect(await currentNonce(wallets[0]!)).toBe(3n);
    expect((await algorand.client.algod.accountInformation(wallets[0]!.appAddress).do()).amount).toBe(walletBalance.amount);
    await keys.send.setPaused({ args: { paused: true } });
    await reject("paused key policy blocks otherwise valid wallet action", await execution(0, 0, baseOperation(3n)));
    await keys.send.setPaused({ args: { paused: false } });
    await keys.send.retireKey({ args: { keyHash, validUntil: sessions[1]!.signals[10]! }, boxReferences: [keyBox] });
    // The runner freezes the developer clock, then restores its original mode.
    // Advance to precise policy boundaries using harmless sponsor payments.
    const expiry = sessions[0]!.signals[10]!;
    const advance = async (target: bigint) => {
      if (target < await nodeTime()) throw new Error("Development clock cannot move backwards");
      await algorand.client.algod.setBlockOffsetTimestamp(target - await nodeTime()).do();
      await algorand.send.payment({ sender: payer, receiver: payer, amount: microAlgos(0), note: `phase4-clock-${unique++}` });
      await algorand.client.algod.setBlockOffsetTimestamp(0).do();
    };
    await advance(expiry - 1n);
    expect(await nodeTime()).toBe(expiry - 1n);
    await (await execution(0, 0, baseOperation(3n))).simulate();
    checks.push("full wallet action accepted one second before session expiry");
    await advance(expiry);
    expect(await nodeTime()).toBe(expiry);
    await expect((await execution(0, 0, baseOperation(3n))).simulate()).rejects.toThrow(/Session expired/);
    await reject("full wallet action rejected at exact session expiry", await execution(0, 0, baseOperation(3n)));
    // The later session is active and ends exactly at the shortened key endpoint.
    await (await execution(1, 1, baseOperation(3n))).simulate();
    checks.push("session expiry equal to key retirement endpoint is accepted while active");
    await keys.send.revokeKey({ args: { keyHash }, boxReferences: [keyBox] });
    await reject("revoked key blocks previously valid proof and signature", await execution(1, 1, baseOperation(3n)));
    expect(await currentNonce(wallets[0]!)).toBe(3n);
    expect(await currentNonce(wallets[1]!)).toBe(3n);
    const registryInfo = await algorand.client.algod.getApplicationByID(registry.appId).do();
    const walletInfo = await algorand.client.algod.getApplicationByID(ids[0]!).do();
    const record = { recordedAt: new Date().toISOString(), network: "localnet", genuineGoogleTokens: false,
      fullJwtCircuit: true, publicSignals: 12, developmentSetupOnly: true,
      registryAppId: String(registry.appId), keyRegistryAppId: String(keys.appId), walletAppIds: ids.map(String),
      walletAddresses: wallets.map((w) => w.appAddress.toString()), verifierLogicSig: lsig.addr.toString(),
      verificationKeySha256: createHash("sha256").update(readFileSync(resolve(root, "fixtures/phase3/verification_key.json"))).digest("hex"),
      registryApprovalBytes: registryInfo.params.approvalProgram.length, walletApprovalBytes: walletInfo.params.approvalProgram.length,
      verifierLogicSigProgramBytes: lsig.account.lsig.logic.length,
      environment: { node: process.version, snarkjs: read("upstream/snarkjs-algorand/node_modules/snarkjs/package.json").version,
        algoKitUtils: read("upstream/snarkjs-algorand/node_modules/@algorandfoundation/algokit-utils/package.json").version,
        algorandTypescript: read("upstream/snarkjs-algorand/node_modules/@algorandfoundation/algorand-typescript/package.json").version,
        verifierSourceCommit: "3a970c7fb47efadd60c0b09a3200e8428ac47df2", targetAvm: 11 },
      contractSourceSha256: Object.fromEntries(["wallet_authorization", "user_wallet", "wallet_registry", "google_key_registry"].map((name) => [name, createHash("sha256").update(readFileSync(resolve(root, `contracts/${name}.algo.ts`))).digest("hex")])),
      enrollmentDepositMicroAlgos: String(deposit), registryBaseMicroAlgos: "100000", initialWalletMicroAlgos: "100000",
      walletAsaOptInMbrMicroAlgos: "100000", checks, flows: benchmarks,
    };
    writeFileSync(resolve(root, "benchmarks/phase4-wallets.localnet.json"), JSON.stringify(record, null, 2) + "\n");
  } finally { await curve.terminate(); }
}, 600_000);
