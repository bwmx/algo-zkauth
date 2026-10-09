import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createPrivateKey, sign } from "node:crypto";
import { AlgorandClient, microAlgos } from "@algorandfoundation/algokit-utils";
import { decodeAddress, getApplicationAddress } from "algosdk";
import * as snarkjs from "snarkjs";
import { Groth16Bn254LsigVerifier, encodeGroth16Bn254Proof } from "../src/groth16";
import { GoogleKeyRegistryFactory } from "../contracts/clients/GoogleKeyRegistry";
import { WalletRegistryFactory } from "../contracts/clients/WalletRegistry";
import { UserWalletFactory } from "../contracts/clients/UserWallet";
import { actionDigest, signalDigest } from "../src/phase4/action.mjs";
import { createRecoveryPackage, restoreRecoveryPackage, generateRecoverySecret, toBase64Url } from "../src/phase5/recovery.mjs";

const root = resolve(process.cwd(), "../..");
const runDir = process.env.PHASE5_RUN_DIR!;
const read = (p: string) => JSON.parse(readFileSync(`${runDir}/${p}`, "utf8"));
it("restores a salt after original client loss and authorizes the existing wallet with a fresh session", async () => {
  const algorand = AlgorandClient.defaultLocalNet();
  expect(BigInt((await algorand.client.algod.getBlockOffsetTimestamp().do()).offset)).toBe(0n);
  const payer = await algorand.account.localNetDispenser();
  const recipient = algorand.account.random();
  await algorand.account.ensureFunded(recipient, payer, microAlgos(1_000_000));
  const params = await algorand.client.algod.getTransactionParams().do();
  const genesis = params.genesisHash!;
  const status = await algorand.client.algod.status().do();
  const now = (await algorand.client.algod.block(status.lastRound).do()).block.header.timestamp;
  const original = read("original-device/session.json");
  const originalIdentity = read("original-device/identity.json");
  const originalSignals: bigint[] = original.signals.map(BigInt);
  const owner = signalDigest(originalSignals, 0);
  // @ts-expect-error snarkjs does not type curves
  const curve = await snarkjs.curves.getCurveFromName("bn128");
  try {
    const verifier = new Groth16Bn254LsigVerifier({ algorand, appOffset: 0, totalLsigs: 6, zKey: resolve(root, "fixtures/phase3/google_jwt.zkey"), wasmProver: resolve(root, "fixtures/phase3/google_jwt_js/google_jwt.wasm") });
    const lsig = await verifier.lsigAccount();
    const { appClient: keys } = await new GoogleKeyRegistryFactory({ algorand, defaultSender: payer }).send.create.createApplication({ args: {} });
    await algorand.send.payment({ sender: payer, receiver: keys.appAddress, amount: microAlgos(125_000) });
    const keyHash = signalDigest(originalSignals, 2);
    const keyBox = Buffer.concat([Buffer.from("gk:"), keyHash]);
    await keys.send.registerKey({ args: { keyHash, validFrom: now, validUntil: now + 7200n }, boxReferences: [keyBox] });
    const { appClient: registry } = await new WalletRegistryFactory({ algorand, defaultSender: payer }).send.create.createApplication({ args: { verifier: lsig.addr.toString(), keyRegistry: keys.appId, audience: signalDigest(originalSignals, 4) }, appReferences: [keys.appId] });
    await algorand.send.payment({ sender: payer, receiver: registry.appAddress, amount: microAlgos(100_000) });
    const deposit = (await registry.send.enrollmentDeposit()).return!;
    const walletBox = Buffer.concat([Buffer.from("w:"), owner]);
    const group = registry.newGroup();
    group.addTransaction(await algorand.createTransaction.payment({ sender: payer, receiver: registry.appAddress, amount: microAlgos(deposit), staticFee: microAlgos(20_000) }));
    await verifier.verificationParams({ proof: encodeGroth16Bn254Proof(original.proof, curve), signals: originalSignals, composer: group, paramsCallback: async ({ lsigParams, args }) => {
      const digest = actionDigest({ genesisHash: genesis, registryId: registry.appId, walletId: 0n, owner, operation: 0n, recipient: decodeAddress(payer.addr.toString()).publicKey, assetId: 0n, amount: deposit, nonce: 0n, sessionExpiresAt: originalSignals[10]! });
      group.enroll({ ...lsigParams, args: { ...args, payer: payer.addr.toString(), signature: sign(null, digest, createPrivateKey({ key: original.privateKey, format: "jwk" })) }, appReferences: [keys.appId], boxReferences: [walletBox, { appId: keys.appId, name: keyBox }] });
    } });
    await group.send();
    const lookup = async (commitment: Uint8Array) => (await registry.send.lookup({ args: { owner: commitment }, boxReferences: [Buffer.concat([Buffer.from("w:"), commitment])] })).return!;
    const walletId = await lookup(owner);
    expect(walletId).toBeGreaterThan(0n);
    const wallet = new UserWalletFactory({ algorand, defaultSender: payer }).getAppClientById({ appId: walletId });
    await algorand.send.payment({ sender: payer, receiver: wallet.appAddress, amount: microAlgos(1_000_000) });
    const execute = async (session: typeof original, nonce: bigint) => {
      const signals = session.signals.map(BigInt) as bigint[];
      const operation = { operation: 1n, recipient: recipient.addr.toString(), assetId: 0n, amount: 10_000n, nonce };
      const digest = actionDigest({ genesisHash: genesis, registryId: registry.appId, walletId, owner, ...operation, recipient: decodeAddress(operation.recipient).publicKey, sessionExpiresAt: signals[10]! });
      const g = wallet.newGroup();
      await verifier.verificationParams({ proof: encodeGroth16Bn254Proof(session.proof, curve), signals, composer: g, paramsCallback: async ({ lsigParams, args }) => {
        g.execute({ ...lsigParams, args: { ...args, ...operation, signature: sign(null, digest, createPrivateKey({ key: session.privateKey, format: "jwk" })) }, appReferences: [keys.appId], accountReferences: [operation.recipient], boxReferences: [{ appId: keys.appId, name: keyBox }] });
        g.addTransaction(await algorand.createTransaction.payment({ sender: payer, receiver: payer, amount: microAlgos(0), staticFee: microAlgos(20_000), note: `phase5-${nonce}` }));
      } });
      return g.send();
    };
    await execute(original, 0n);
    expect((await wallet.send.getNonce()).return).toBe(1n);
    const binding = { stage: "wallet", networkGenesisHash: toBase64Url(genesis), registryAppId: String(registry.appId), walletAppId: String(walletId), walletAddress: wallet.appAddress.toString() };
    const recoverySecret = await generateRecoverySecret();
    const packageText = await createRecoveryPackage({ salt: new Uint8Array(Buffer.from(originalIdentity.salt, "base64url")), identity: originalIdentity.identity, binding, recoverySecret });
    // A backup is not accepted until an exported/imported copy actually restores.
    for (const d of ["external", "external-secret"]) mkdirSync(`${runDir}/${d}`, { mode: 0o700 });
    writeFileSync(`${runDir}/external/backup.json`, packageText + "\n", { mode: 0o600 });
    writeFileSync(`${runDir}/external/wallet-binding.json`, JSON.stringify(binding), { mode: 0o600 });
    writeFileSync(`${runDir}/external-secret/recovery-secret.txt`, recoverySecret, { mode: 0o600 });
    const checked = await restoreRecoveryPackage({ packageText: readFileSync(`${runDir}/external/backup.json`, "utf8"), identity: originalIdentity.identity, expectedBinding: binding, recoverySecret });
    expect(Buffer.from(checked.commitment)).toEqual(owner); checked.salt.fill(0);
    const originalMeasurements = read("original-device/measurements.json");
    rmSync(`${runDir}/original-device`, { recursive: true });
    expect(existsSync(`${runDir}/original-device`)).toBe(false);
    // A new OS process has no access to the former salt or session state.
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--max-old-space-size=6000", `${root}/scripts/phase5-device.mjs`, "restored"], { cwd: root, env: process.env, stdio: "inherit" });
      child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error("Fresh recovery process failed")));
    });
    const restored = read("restored-device/session.json");
    const restoredIdentity = read("restored-device/identity.json");
    const restoredMeasurements = read("restored-device/measurements.json");
    const restoredSignals: bigint[] = restored.signals.map(BigInt);
    expect(restoredMeasurements.processId).not.toBe(originalMeasurements.processId);
    expect(restoredMeasurements.originalClientStateAbsent).toBe(true);
    expect(signalDigest(restoredSignals, 0)).toEqual(owner);
    expect(restoredIdentity.salt).toBe(originalIdentity.salt);
    expect(signalDigest(restoredSignals, 6)).not.toEqual(signalDigest(originalSignals, 6));
    expect(await snarkjs.groth16.verify(JSON.parse(readFileSync(resolve(root, "fixtures/phase3/verification_key.json"), "utf8")), restored.signals, restored.proof)).toBe(true);
    expect(await lookup(signalDigest(restoredSignals, 0))).toBe(walletId);
    expect(getApplicationAddress(walletId).toString()).toBe(binding.walletAddress);
    const state = await wallet.state.global.getAll();
    expect(state.owner?.asByteArray()).toEqual(new Uint8Array(owner));
    expect(state.registry).toBe(registry.appId); expect(state.keyRegistry).toBe(keys.appId); expect(state.verifier).toBe(lsig.addr.toString());
    const before = await algorand.client.algod.accountInformation(wallet.appAddress).do();
    const recipientBefore = await algorand.client.algod.accountInformation(recipient.addr).do();
    const started = performance.now();
    const sent = await execute(restored, 1n);
    const after = await algorand.client.algod.accountInformation(wallet.appAddress).do();
    expect(before.amount - after.amount).toBe(10_000n);
    expect((await algorand.client.algod.accountInformation(recipient.addr).do()).amount - recipientBefore.amount).toBe(10_000n);
    expect((await wallet.send.getNonce()).return).toBe(2n);
    writeFileSync(resolve(root, "benchmarks/phase5-recovery.localnet.json"), JSON.stringify({ recordedAt: new Date().toISOString(), genuineGoogleTokens: false, circuit: "full Google JWT / 12 signals", developmentTrustedSetup: true, scope: "two isolated Node client processes / synthetic identity provider", physicalSecondDeviceVerified: false, browserPasskeyTested: false, backupVerifiedBeforeLoss: true, originalClientDirectoryDeleted: true, sameSalt: true, sameCommitment: true, sameWalletIdAndAddress: true, freshSessionKey: true, freshNonceBoundJwtProof: true, nonceBeforeRecovery: "1", nonceAfterRecovery: "2", restoredTransferMicroAlgos: "10000", registryAppId: String(registry.appId), keyRegistryAppId: String(keys.appId), walletAppId: String(walletId), walletAddress: binding.walletAddress, transferTransactionIds: sent.txIds, confirmedRound: String(sent.confirmations[0]?.confirmedRound), confirmationMs: Math.round(performance.now() - started), proofs: [originalMeasurements, restoredMeasurements] }, null, 2) + "\n");
  } finally { await curve.terminate(); }
}, 600_000);
