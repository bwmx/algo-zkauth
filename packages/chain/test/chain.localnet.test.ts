// @algozkauth/chain on LocalNet: one provider deployment shared by two apps, a dev
// key registered through ensureKeys, and a synthetic identity's full-circuit proof
// driving enrollment and an ALGO transfer on one app. Run by scripts/run-chain-localnet.sh.
// Development fixtures only: the token is synthetic and signed by a throwaway key.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { Address, AlgorandClient, microAlgos, snarkjs } from "../src/deps.ts";
import { ChainError, openChain } from "../src/index.ts";
import { checkReplay, fundWallet, openDemoChain } from "../src/demo.ts";
import { secretKeyToMnemonic } from "../../../upstream/snarkjs-algorand/node_modules/algosdk/dist/esm/index.js";
import { providerById } from "../../protocol/src/oidc-providers.mjs";
import { syntheticToken } from "../../protocol/src/synthetic-token.mjs";
import { oidcCircuitInput } from "../../protocol/src/circuit-input.mjs";
import { sessionNonce } from "../../protocol/src/session-nonce.mjs";
import { identityCommitment } from "../../protocol/src/identity-commitment.mjs";
import { expectedPublicSignals } from "../../protocol/src/node.ts";
import { browserActionDigest } from "../../protocol/src/action.mjs";

const root = new URL("../../../", import.meta.url).pathname;
const google = providerById("google");
const audiences = ["algozkauth-test-a.apps.googleusercontent.com", "algozkauth-test-b.apps.googleusercontent.com"];
const rejects = async (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error: unknown) => error instanceof ChainError && error.code === code);

// Witness in-process, then rapidsnark (the binary scripts/artifacts.mjs installs) or snarkjs.
async function prove(input: Record<string, unknown>) {
  const { directory, name } = google.circuit;
  const dir = `${root}.local/chain-test/${randomUUID()}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(`${root}.local/chain-test`, 0o700);
  try {
    const { default: witnessBuilder } = await import(`${root}${directory}/${name}_js/witness_calculator.js`);
    const calculator = await witnessBuilder(readFileSync(`${root}${directory}/${name}_js/${name}.wasm`));
    writeFileSync(`${dir}/proof.wtns`, Buffer.from(await calculator.calculateWTNSBin(input, true)), { mode: 0o600 });
    const rapidsnark = `${root}.local/bin/${process.platform}-${process.arch}/prover`;
    if (existsSync(rapidsnark)) {
      await promisify(execFile)(rapidsnark, [`${root}${directory}/${name}.zkey`, `${dir}/proof.wtns`, `${dir}/proof.json`, `${dir}/public.json`]);
      return { proof: JSON.parse(readFileSync(`${dir}/proof.json`, "utf8")), publicSignals: JSON.parse(readFileSync(`${dir}/public.json`, "utf8")) as string[] };
    }
    return await snarkjs.groth16.prove(`${root}${directory}/${name}.zkey`, `${dir}/proof.wtns`, undefined, { singleThread: true } as any);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

type Chain = Awaited<ReturnType<typeof openChain>>;
const localnet = AlgorandClient.defaultLocalNet();
const funded = async (algos: number) => {
  const dispenser = await localnet.account.localNetDispenser();
  const a = localnet.account.random();
  await localnet.send.payment({ sender: dispenser, receiver: a.addr, amount: microAlgos(algos * 1_000_000) });
  return { addr: a.addr.toString(), signer: a.signer, mnemonic: secretKeyToMnemonic(a.account.sk) };
};
// A synthetic token for `audience`, its session bound to this LocalNet, and its proof.
async function identity(chain: Chain, o: { rsa: ReturnType<typeof generateKeyPairSync>; jwk: object; audience: string; subject: string }) {
  const dispenser = await localnet.account.localNetDispenser();
  // A fresh block makes the issue time current on an idle LocalNet.
  await localnet.send.payment({ sender: dispenser, receiver: dispenser, amount: microAlgos(0), note: `chain-test-clock-${randomUUID()}` });
  const issuedAt = Number(await chain.time());
  const genesisHash = Buffer.from(chain.genesisHash, "base64url");
  const session = generateKeyPairSync("ed25519");
  const sessionPublicKey = Buffer.from(session.publicKey.export({ format: "jwk" }).x!, "base64url");
  const randomness = randomBytes(32), salt = randomBytes(32), expiresAt = issuedAt + 600;
  const nonce = sessionNonce({ genesisHash, sessionPublicKey, expiresAt, randomness });
  const token = syntheticToken(google, { privateKey: o.rsa.privateKey, kid: "dev-1", audience: o.audience, subject: o.subject, nonce, issuedAt });
  const input = oidcCircuitInput({ provider: google, token, jwks: { keys: [o.jwk] }, audience: o.audience, nonce, genesisHash, sessionPublicKey, expiresAt, randomness, salt, nowSeconds: issuedAt + 1 });
  const result = await prove(input);
  assert.deepEqual(result.publicSignals, expectedPublicSignals(input));
  return {
    result, salt, expiresAt,
    owner: identityCommitment({ issuer: google.issuer, audience: o.audience, subject: o.subject, salt }).digest as Buffer,
    sign: async (plan: any) => sign(null, await browserActionDigest(plan), session.privateKey),
  };
}
const devKey = () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { rsa, jwk: { ...rsa.publicKey.export({ format: "jwk" }), kid: "dev-1", alg: "RS256", use: "sig" } };
};

test("one provider deployment serves two apps; a synthetic identity enrolls and transfers on one", { timeout: 900_000 }, async () => {
  const algorand = localnet;
  const chain = await openChain({ network: "localnet", root });
  try {
    // One algosdk instance: addresses made by algokit and by the clients are this Address.
    assert.ok(chain.internal.algorand.account.random().addr instanceof Address);
    const [administrator, sponsor, guardian] = [await funded(5), await funded(10), await funded(1)];

    const provider = await chain.deployProvider({ provider: "google", administrator, guardian: guardian.addr });
    assert.equal(provider.network, "localnet");
    assert.equal(provider.guardian, guardian.addr);
    assert.equal(provider.administrator, administrator.addr);
    await rejects(chain.deployProvider({ provider: "google", administrator, guardian: administrator.addr }), "rejected");
    const apps = [];
    for (const [index, audience] of audiences.entries()) apps.push(await chain.deployApp({ provider, app: `test-${"ab"[index]}`, audience, funder: sponsor }));
    const [appA, appB] = apps as [typeof apps[0], typeof apps[0]];
    assert.notEqual(appA.registryId, appB.registryId);
    // Both registries are bound to the provider's one key registry and verifier.
    for (const app of apps) await chain.wallets(app, provider).verify({ sender: sponsor.addr });
    await rejects(chain.wallets({ ...appA, registryId: appB.registryId }, provider).verify({ sender: sponsor.addr }), "rejected");

    // Dev RSA key, registered during the bootstrap, which ensureKeys then seals.
    const { rsa, jwk } = devKey();
    const keys = chain.keys(provider);
    assert.deepEqual(await keys.flags(), { paused: false, sealed: false, timelocked: true });
    const first = await keys.ensureKeys({ jwks: { keys: [jwk] }, administrator });
    assert.equal(first.registered.length, 1); assert.equal(first.sealed, true);
    assert.deepEqual(await keys.flags(), { paused: false, sealed: true, timelocked: true });
    assert.deepEqual(await keys.ensureKeys({ jwks: { keys: [jwk] }, administrator }), { registered: [], renewed: [], sealed: false, changes: [] });
    // After sealing, a new key waits out the approval delay; the guardian vetoes it.
    const later = { ...generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "jwk" }), kid: "dev-2", alg: "RS256" };
    const second = await keys.ensureKeys({ jwks: { keys: [jwk, later] }, administrator });
    assert.equal(second.registered.length, 1);
    const now = await chain.time();
    const pending = (await keys.list()).find(k => k.fingerprint === second.registered[0])!;
    assert.ok(BigInt(pending.validFrom) > now + 86_000n);
    await keys.revoke({ fingerprint: pending.fingerprint, signer: guardian });
    assert.equal((await keys.list()).find(k => k.fingerprint === pending.fingerprint)!.revoked, true);
    assert.equal((await keys.list()).find(k => k.fingerprint === first.registered[0])!.revoked, undefined);

    // Synthetic identity for app A.
    const subject = "alice";
    const { result, owner, salt, expiresAt, sign: signPlan } = await identity(chain, { rsa, jwk, audience: audiences[0], subject });
    const walletsA = chain.wallets(appA, provider);
    const checked = await walletsA.checkProof(result);
    assert.deepEqual(Buffer.from(checked.owner), owner);
    assert.equal(checked.expiresAt, BigInt(expiresAt));
    assert.equal((await walletsA.discover(owner)).enrolled, false);
    await rejects(walletsA.prepare({ proof: result, request: { operation: "1", recipient: sponsor.addr, assetId: "0", amount: "1" } }), "not_enrolled");
    await rejects(walletsA.checkProof({ ...result, publicSignals: result.publicSignals.map((s, i) => i === 0 ? String(BigInt(s) + 1n) : s) }), "invalid_proof");

    const enroll = await walletsA.prepare({ proof: result, request: { operation: "0" }, sponsor: sponsor.addr });
    assert.equal(enroll.recipient, sponsor.addr);
    assert.equal(enroll.amount, appA.enrollmentDeposit);
    await rejects(walletsA.submit({ proof: result, plan: enroll, signature: randomBytes(64), sponsor }), "rejected");
    const enrolled = await walletsA.submit({ proof: result, plan: enroll, signature: await signPlan(enroll), sponsor });
    assert.ok(enrolled.wallet.enrolled && enrolled.wallet.walletId !== "0");
    assert.ok(enrolled.transactionIds.includes(enrolled.txId));
    assert.equal(enrolled.groupFeeMicroAlgos, appA.groupFeeMicroAlgos);
    assert.deepEqual(await walletsA.snapshotByAddress(enrolled.wallet.address!), enrolled.wallet);
    await rejects(walletsA.prepare({ proof: result, request: { operation: "0" }, sponsor: sponsor.addr }), "wallet_exists");

    await fundWallet(chain, { app: appA, provider }, { owner, funder: sponsor, amount: 1_000_000n });
    const recipient = algorand.account.random().addr.toString();
    const transfer = await walletsA.prepare({ proof: result, request: { operation: "1", recipient, assetId: "0", amount: "200000" } });
    assert.equal(transfer.walletId, enrolled.wallet.walletId);
    const signature = await signPlan(transfer);
    const sent = await walletsA.submit({ proof: result, plan: transfer, signature, sponsor });
    assert.equal(sent.wallet.nonce, "1");
    assert.equal(sent.wallet.balanceMicroAlgos, String(1_100_000 - 200_000));
    assert.equal((await algorand.client.algod.accountInformation(recipient).do()).amount, 200_000n);
    await rejects(walletsA.submit({ proof: result, plan: transfer, signature, sponsor }), "replay");
    assert.deepEqual(await checkReplay(chain, { app: appA, provider }, { proof: result, plan: transfer, signature, sponsor }), { replayRejectedByNode: true, noncePreserved: true });

    // The same identity and salt on app B: another commitment, no wallet, and app A's proof is refused.
    const walletsB = chain.wallets(appB, provider);
    const ownerB = identityCommitment({ issuer: google.issuer, audience: audiences[1], subject, salt }).digest;
    assert.ok(!ownerB.equals(owner));
    assert.deepEqual(await walletsB.discover(ownerB), { walletId: "0", address: null, nonce: "0", balanceMicroAlgos: "0", minBalanceMicroAlgos: "0", assets: [], enrolled: false });
    assert.equal((await walletsB.discover(owner)).enrolled, false);
    await rejects(walletsB.checkProof(result), "wrong_audience");
  } finally { await chain.close(); }
});

// The TestNet demo's wrapper, on LocalNet: its deployment record, reopening from
// it, and the chain call behind every demo route.
test("openDemoChain keeps the demo's record and operations", { timeout: 900_000 }, async () => {
  const sponsor = await funded(10);
  const guardian = await funded(1);
  const dir = `${root}.local/chain-test/${randomUUID()}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const audience = "algozkauth-test-demo.apps.googleusercontent.com";
  const options = { root, mnemonic: sponsor.mnemonic, audience, network: "localnet" as const, provider: { ...google, deployment: `${dir.slice(root.length)}/deployment.json` } };
  const chain = await openChain({ network: "localnet", root });
  try {
    await assert.rejects(openDemoChain(options), /Run scripts\/deploy-demo.sh/);
    const demo = await openDemoChain({ ...options, deploy: true, guardian: guardian.addr });
    const { rsa, jwk } = devKey();
    await demo.ensureKeys({ keys: [jwk] });
    await demo.close();
    const record = JSON.parse(readFileSync(`${dir}/deployment.json`, "utf8"));
    assert.deepEqual(Object.keys(record), ["network", "genesisHash", "audienceHash", "verificationKeySha256", "verifier", "sponsor", "keyRegistryId", "registryId", "demoAssetId", "enrollmentDeposit", "groupFeeMicroAlgos", "createdAt", "fundedWallets", "seededWallets", "approvedKeys"]);
    assert.equal(record.network, chain.genesisId);
    assert.equal(record.sponsor, sponsor.addr);
    assert.equal(record.enrollmentDeposit, "454800");
    assert.equal(record.groupFeeMicroAlgos, "20000");
    assert.deepEqual(Object.keys(record.approvedKeys[0]), ["fingerprint", "validFrom", "validUntil"]);
    await assert.rejects(openDemoChain({ ...options, audience: "other.apps.googleusercontent.com" }), /does not match this configuration/);

    // Reopened from the record, as scripts/phase6-server.mjs does.
    const server = await openDemoChain(options);
    try {
      const config = server.config() as any;
      assert.equal(config.fundedWallets, undefined);
      assert.equal(config.registryId, record.registryId);
      const people = [];
      for (const subject of ["alice", "bob"]) {
        const person = await identity(chain, { rsa, jwk, audience, subject });
        const plan = await server.prepare(person.result, { operation: "0" });
        assert.equal("version" in plan, false);
        const { wallet, measurement } = await server.submit(person.result, plan as any, await person.sign(plan));
        assert.ok(wallet.enrolled);
        assert.deepEqual(Object.keys(measurement), ["operation", "amount", "assetId", "recipient", "nonce", "genuineGoogleToken", "transactionIds", "confirmedRound", "confirmationMs", "groupFeeMicroAlgos", "outerTransactions", "innerTransactions", "signedBytes", "appBudgetConsumed", "logicSigBudgetConsumed"]);
        people.push({ ...person, wallet });
      }
      const [alice, bob] = people as [typeof people[0], typeof people[0]];
      await assert.rejects(server.prepare(alice.result, { operation: "0" }), /^ChainError: Wallet already exists; use discovery$/);
      await assert.rejects(server.fund(alice.owner, true), /Opt in before seeding the demo ASA/);
      assert.equal((await server.fund(alice.owner, false)).balanceMicroAlgos, "1100000");
      await assert.rejects(server.prepare(alice.result, { operation: "2", recipient: alice.wallet.address, assetId: "1", amount: "0" }), /Invalid demo ASA opt-in/);
      await assert.rejects(server.prepare(alice.result, { operation: "2", recipient: alice.wallet.address, assetId: "0", amount: "0" }), /Invalid demo ASA opt-in/);
      const run = async (request: object) => {
        const plan = await server.prepare(alice.result, request);
        const signature = await alice.sign(plan);
        return { plan, signature, ...(await server.submit(alice.result, plan as any, signature)) };
      };
      await run({ operation: "2", recipient: alice.wallet.address, assetId: record.demoAssetId, amount: "0" });
      assert.ok((await server.fund(alice.owner, true)).assets.some(a => a.id === record.demoAssetId && a.amount === "100"));
      const transfer = await run({ operation: "3", recipient: sponsor.addr, assetId: record.demoAssetId, amount: "7" });
      assert.equal(transfer.wallet.nonce, "2");
      assert.deepEqual(await server.replay(alice.result, transfer.plan as any, transfer.signature), { replayRejectedByNode: true, noncePreserved: true });
      const isolation = await server.isolation(alice.result, transfer.plan as any, transfer.signature, bob.wallet.walletId);
      assert.equal(isolation.wrongOwnerRejectedByNode, true);
      assert.equal(isolation.otherWalletAddress, bob.wallet.address);
      const saved = JSON.parse(readFileSync(`${dir}/deployment.json`, "utf8"));
      assert.deepEqual([saved.fundedWallets, saved.seededWallets], [[alice.wallet.walletId], [alice.wallet.walletId]]);
    } finally { await server.close(); }
  } finally {
    await chain.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

after(async () => { await (globalThis as any).curve_bn128?.terminate(); });
