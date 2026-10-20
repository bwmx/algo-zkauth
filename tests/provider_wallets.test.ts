import { expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { AlgorandClient, microAlgos } from "@algorandfoundation/algokit-utils";
import { decodeAddress } from "algosdk";
import * as snarkjs from "snarkjs";
import { encodeGroth16Bn254Proof, Groth16Bn254LsigVerifier } from "../src/groth16";
import { KeyRegistryFactory } from "../contracts/clients/KeyRegistry";
import { WalletRegistryFactory } from "../contracts/clients/WalletRegistry";
import { UserWalletFactory } from "../contracts/clients/UserWallet";
import { actionDigest, signalDigest } from "../src/phase4/action.mjs";
import { DEFAULT_PROVIDER, providerById } from "../src/phase3/oidc-providers.mjs";

const root = resolve(process.cwd(), "../..");
const read = (file: string) => JSON.parse(readFileSync(resolve(root, file), "utf8"));
const rejection = /assert|logic eval|rejected/i;

// Another provider's wallets reuse the unchanged contracts in their own
// deployment: its circuit's verifier LogicSig, a key registry holding only its
// keys and its audience. Neither its nor the default provider's (Google's)
// proofs or keys work in the other's. PROVIDER names the provider under test.
const other = providerById(process.env.PROVIDER);
const primary = providerById(DEFAULT_PROVIDER);
if (other.id === primary.id) throw new Error(`PROVIDER must name a provider other than ${primary.id}`);
const { label } = other;
it(`enrolls and operates a ${label} wallet isolated from a ${primary.label} deployment on LocalNet`, async () => {
  const algorand = AlgorandClient.defaultLocalNet();
  // algod answers 404 when no offset was ever set, i.e. the real clock is in use.
  let offset = 0n;
  try { offset = BigInt((await algorand.client.algod.getBlockOffsetTimestamp().do()).offset); }
  catch (error: any) { if (error.status !== 404) throw error; }
  if (offset !== 0n) throw new Error(`Reset the LocalNet block timestamp offset before running ${label} wallet tests`);
  // A long-running LocalNet marks its default accounts offline when their
  // participation keys expire; dev mode still produces blocks.
  const payer = await algorand.account.fromKmd("unencrypted-default-wallet", (a) => a.amount > 1_000_000_000);
  const recipient = algorand.account.random();
  await algorand.account.ensureFunded(recipient, payer, microAlgos(1_000_000));
  const genesis = (await algorand.client.algod.getTransactionParams().do()).genesisHash!;
  const nodeTime = async () => {
    const status = await algorand.client.algod.status().do();
    return (await algorand.client.algod.block(status.lastRound).do()).block.header.timestamp;
  };
  const now = await nodeTime();
  const load = (file: string) => {
    const data = read(file);
    return { rawProof: data.proof, rawSignals: data.signals, signals: data.signals.map(BigInt) as bigint[],
      key: createPrivateKey({ key: data.privateKey, format: "jwk" }) };
  };
  const otherSession = load(`${other.local}/localnet-session.json`);
  expect(signalDigest(otherSession.signals, 8)).toEqual(Buffer.from(genesis));
  if (otherSession.signals[10]! <= now + 60n) throw new Error(`Generate a fresh proof with scripts/prepare-provider-wallet-proof.mjs ${other.id}`);
  expect(await snarkjs.groth16.verify(read(`${other.circuit.directory}/verification_key.json`), otherSession.rawSignals, otherSession.rawProof)).toBe(true);
  // A Phase 4 Google proof, used only for cross-deployment rejection.
  const primarySession = load(".local/phase4/alice-session.json");
  expect(await snarkjs.groth16.verify(read(`${primary.circuit.directory}/verification_key.json`), primarySession.rawSignals, primarySession.rawProof)).toBe(true);
  expect(await snarkjs.groth16.verify(read(`${primary.circuit.directory}/verification_key.json`), otherSession.rawSignals, otherSession.rawProof)).toBe(false);

  const checks: string[] = [];
  const flows: Record<string, unknown>[] = [];
  // @ts-expect-error snarkjs does not type curves
  const curve = await snarkjs.curves.getCurveFromName("bn128");
  try {
    const otherProof = encodeGroth16Bn254Proof(structuredClone(otherSession.rawProof), curve);
    const primaryProof = encodeGroth16Bn254Proof(structuredClone(primarySession.rawProof), curve);
    const verifierFor = (directory: string, name: string) => new Groth16Bn254LsigVerifier({ algorand, appOffset: 0, totalLsigs: 6,
      zKey: resolve(root, `${directory}/${name}.zkey`), wasmProver: resolve(root, `${directory}/${name}_js/${name}.wasm`) });
    const otherVerifier = verifierFor(other.circuit.directory, other.circuit.name);
    const primaryVerifier = verifierFor(primary.circuit.directory, primary.circuit.name);
    const otherLsig = await otherVerifier.lsigAccount();
    const primaryLsig = await primaryVerifier.lsigAccount();
    expect(otherLsig.addr.toString()).not.toBe(primaryLsig.addr.toString());
    const keyFactory = new KeyRegistryFactory({ algorand, defaultSender: payer });
    const registryFactory = new WalletRegistryFactory({ algorand, defaultSender: payer });
    const walletFactory = new UserWalletFactory({ algorand, defaultSender: payer });
    const keyBox = (hash: Uint8Array) => Buffer.concat([Buffer.from("gk:"), hash]);
    let unique = 0;
    const keyRegistry = async (session: typeof otherSession) => {
      const { appClient } = await keyFactory.send.create.createApplication({ args: { guardian: algorand.account.random().addr.toString() }, note: `${other.id}-keys-${unique++}` });
      await algorand.send.payment({ sender: payer, receiver: appClient.appAddress, amount: microAlgos(150_000) });
      const hash = signalDigest(session.signals, 2);
      await appClient.send.registerKey({ args: { keyHash: hash, validFrom: now - 60n, validUntil: now + 7200n }, boxReferences: [keyBox(hash)] });
      await appClient.send.sealBootstrap();
      return appClient;
    };
    const walletRegistry = async (lsig: typeof otherLsig, keys: Awaited<ReturnType<typeof keyRegistry>>, session: typeof otherSession) => {
      const { appClient } = await registryFactory.send.create.createApplication({ args: { verifier: lsig.addr.toString(), keyRegistry: keys.appId, audience: signalDigest(session.signals, 4) }, appReferences: [keys.appId], note: `${other.id}-registry-${unique++}` });
      await algorand.send.payment({ sender: payer, receiver: appClient.appAddress, amount: microAlgos(100_000) });
      return { registry: appClient, keys };
    };
    const otherKeys = await keyRegistry(otherSession);
    const primaryKeys = await keyRegistry(primarySession);
    const otherDeployment = await walletRegistry(otherLsig, otherKeys, otherSession);
    const primaryDeployment = await walletRegistry(primaryLsig, primaryKeys, primarySession);
    // The provider's verifier and audience, but a key registry holding only Google's key.
    const crossedKeys = await walletRegistry(otherLsig, primaryKeys, otherSession);

    const enrollment = async (deployment: typeof otherDeployment, verifier: typeof otherVerifier, session: typeof otherSession, proof: typeof otherProof) => {
      const { registry, keys } = deployment;
      const deposit = (await registry.send.enrollmentDeposit()).return!;
      const owner = signalDigest(session.signals, 0);
      const action = { genesisHash: genesis, registryId: registry.appId, walletId: 0n, owner, operation: 0n,
        recipient: decodeAddress(payer.addr.toString()).publicKey, assetId: 0n, amount: deposit, nonce: 0n, sessionExpiresAt: session.signals[10]! };
      const group = registry.newGroup();
      group.addTransaction(await algorand.createTransaction.payment({ sender: payer, receiver: registry.appAddress,
        amount: microAlgos(deposit), staticFee: microAlgos(20_000), note: `${other.id}-enroll-${Date.now()}-${unique++}` }));
      await verifier.verificationParams({ proof, signals: session.signals, composer: group, paramsCallback: async ({ lsigParams, args }) => {
        group.enroll({ ...lsigParams, args: { ...args, payer: payer.addr.toString(), signature: sign(null, actionDigest(action), session.key) },
          appReferences: [keys.appId], boxReferences: [Buffer.concat([Buffer.from("w:"), owner]), { appId: keys.appId, name: keyBox(signalDigest(session.signals, 2)) }] });
      } });
      return group;
    };
    const rejectBoth = async (name: string, group: any, reason: RegExp) => {
      await expect(group.simulate()).rejects.toThrow(reason);
      const signed = await (await (await group.composer()).build()).atc.gatherSignatures();
      await expect(algorand.client.algod.sendRawTransaction(signed).do()).rejects.toThrow(rejection);
      checks.push(name);
    };
    const send = async (name: string, group: any) => {
      const built = await (await group.composer()).build();
      const sim = (await group.simulate()).simulateResponse.txnGroups[0]!;
      expect(sim.failedAt).toBeUndefined();
      const sent = await group.send();
      const txns = built.transactions.map((t: any) => t.txn);
      flows.push({ operation: name, confirmedRound: String(sent.confirmations[0]?.confirmedRound ?? 0), transactionIds: sent.txIds,
        outerTransactions: txns.length, groupFeeMicroAlgos: String(txns.reduce((sum: bigint, t: any) => sum + t.fee, 0n)),
        appBudgetConsumed: sim.appBudgetConsumed,
        logicSigBudgetConsumed: sim.txnResults.reduce((sum: number, t: any) => sum + (t.logicSigBudgetConsumed ?? 0), 0) });
      return sent;
    };

    await rejectBoth(`${label} proof cannot enroll in a ${primary.label} deployment`,
      await enrollment(primaryDeployment, otherVerifier, otherSession, otherProof), /Proof verifier required/);
    await rejectBoth(`${primary.label} proof cannot enroll in a ${label} deployment`,
      await enrollment(otherDeployment, primaryVerifier, primarySession, primaryProof), /Proof verifier required/);
    await rejectBoth(`${label} proof is rejected by a key registry without ${label}'s key`,
      await enrollment(crossedKeys, otherVerifier, otherSession, otherProof), /Key inactive/);

    const { registry, keys } = otherDeployment;
    const owner = signalDigest(otherSession.signals, 0);
    const walletBox = Buffer.concat([Buffer.from("w:"), owner]);
    await send(`${label} enrollment`, await enrollment(otherDeployment, otherVerifier, otherSession, otherProof));
    const walletId = (await registry.send.lookup({ args: { owner }, boxReferences: [walletBox] })).return!;
    expect(walletId).toBeGreaterThan(0n);
    const wallet = walletFactory.getAppClientById({ appId: walletId });
    const state = await wallet.state.global.getAll();
    expect(Buffer.from(state.owner!.asByteArray()!)).toEqual(owner);
    expect(state.verifier).toBe(otherLsig.addr.toString());
    expect(state.keyRegistry).toBe(keys.appId);
    checks.push(`${label} identity enrolled an immutable wallet bound to the ${label} verifier and key registry`);
    await algorand.send.payment({ sender: payer, receiver: wallet.appAddress, amount: microAlgos(1_000_000) });

    const transfer = async () => {
      const nonce = BigInt((await wallet.state.global.getAll()).nonce!);
      const action = { genesisHash: genesis, registryId: registry.appId, walletId, owner, operation: 1n,
        recipient: decodeAddress(recipient.addr.toString()).publicKey, assetId: 0n, amount: 10_000n, nonce: 0n, sessionExpiresAt: otherSession.signals[10]! };
      const signature = sign(null, actionDigest(action), otherSession.key);
      const group = wallet.newGroup();
      await otherVerifier.verificationParams({ proof: otherProof, signals: otherSession.signals, composer: group, paramsCallback: async ({ lsigParams, args }) => {
        group.execute({ ...lsigParams, args: { ...args, operation: 1n, recipient: recipient.addr.toString(), assetId: 0n, amount: 10_000n, nonce: 0n, signature },
          appReferences: [keys.appId], accountReferences: [recipient.addr.toString()], boxReferences: [{ appId: keys.appId, name: keyBox(signalDigest(otherSession.signals, 2)) }] });
        group.addTransaction(await algorand.createTransaction.payment({ sender: payer, receiver: payer, amount: microAlgos(0),
          staticFee: microAlgos(20_000), note: `${other.id}-action-${Date.now()}-${unique++}` }));
      } });
      return { group, nonce };
    };
    const before = (await algorand.client.algod.accountInformation(recipient.addr).do()).amount;
    const first = await transfer();
    expect(first.nonce).toBe(0n);
    await send(`${label}-authorized ALGO transfer`, first.group);
    expect((await algorand.client.algod.accountInformation(recipient.addr).do()).amount - before).toBe(10_000n);
    expect(BigInt((await wallet.state.global.getAll()).nonce!)).toBe(1n);
    checks.push(`${label} session key authorized an exact ALGO transfer`);
    await rejectBoth(`signed ${label} action cannot be replayed`, (await transfer()).group, /Wrong action nonce/);

    const record = { recordedAt: new Date().toISOString(), network: "localnet", provider: other.id, [`genuine${label}Tokens`]: false,
      fullJwtCircuit: true, publicSignals: 12, developmentSetupOnly: true, contractsChanged: false,
      [`${other.id}RegistryAppId`]: String(registry.appId), [`${other.id}KeyRegistryAppId`]: String(keys.appId), walletAppId: String(walletId),
      [`${other.id}VerifierLogicSig`]: otherLsig.addr.toString(), [`${primary.id}VerifierLogicSig`]: primaryLsig.addr.toString(),
      verificationKeySha256: createHash("sha256").update(readFileSync(resolve(root, `${other.circuit.directory}/verification_key.json`))).digest("hex"),
      contractSourceSha256: Object.fromEntries(["wallet_authorization", "user_wallet", "wallet_registry", "key_registry"].map((name) => [name, createHash("sha256").update(readFileSync(resolve(root, `contracts/${name}.algo.ts`))).digest("hex")])),
      checks, flows };
    writeFileSync(resolve(root, `benchmarks/${other.records.localnetWallets}`), JSON.stringify(record, null, 2) + "\n");
  } finally { await curve.terminate(); }
}, 600_000);
