// Read-only TestNet acceptance of the service stack (compose.testnet.yaml).
// Takes each app's public settings from the api, then re-checks everything
// against public chain data: the registries' configuration, every wallet the
// apps' registries created and every proof-carrying enrollment and action
// (Groth16 proof, session-key signature over the exact action, network,
// audience and owner bindings, session window, the provider key's approval at
// that time, the seven-transaction group, sponsor-paid fees and the inner
// transfer). Never loads a mnemonic, token, salt or signing key.
//
//   node evidence/check-service-stack.mjs [--service http://localhost:8780] [--apps demo,example,wallet,demo-slack?] [--out benchmarks/service-stack.testnet.json]
//
// An app id ending in "?" is checked only when the service has it.
//
// With --rejections it also simulates, against TestNet and without submitting
// anything, a replay of each wallet's latest action (the wallet must reject it at
// its nonce check) and that action's proof at another wallet of the same app (it
// must reject it at its owner check). The wallet checks the session window too,
// so run this within ten minutes of the actions; a later run keeps the recorded
// results. --rejections loads the chain package, so it needs the tsx loader:
//
//   node --import ./upstream/snarkjs-algorand/node_modules/tsx/dist/loader.mjs evidence/check-service-stack.mjs --rejections
//
// Exit 0 when every check passes, 1 otherwise. Backend sign-ins are off-chain
// and not covered here.
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ABIMethod, decodeAddress, getApplicationAddress } from "../upstream/snarkjs-algorand/node_modules/algosdk/dist/esm/index.js";
import * as snarkjs from "../upstream/snarkjs-algorand/node_modules/snarkjs/main.js";
import { actionDigest, signalDigest } from "../packages/protocol/src/action-node.mjs";
import { providerById } from "../packages/protocol/src/oidc-providers.mjs";

const root = new URL("../", import.meta.url).pathname;
const { values: opts } = parseArgs({ options: {
  service: { type: "string", default: "http://localhost:8780" },
  apps: { type: "string", default: "demo,example,wallet,demo-slack?" },
  out: { type: "string", default: "benchmarks/service-stack.testnet.json" },
  algod: { type: "string", default: "https://testnet-api.algonode.cloud" },
  indexer: { type: "string", default: "https://testnet-idx.algonode.cloud" },
  rejections: { type: "boolean", default: false },
} });
const previous = existsSync(`${root}${opts.out}`) ? JSON.parse(readFileSync(`${root}${opts.out}`, "utf8")) : undefined;
let chain;
const openedChain = async () => {
  if (!chain) {
    const { openChain } = await import("../packages/chain/src/index.ts");
    chain = await openChain({ network: "testnet", root, algodUrl: opts.algod, indexerUrl: opts.indexer });
  }
  return chain;
};

const EXECUTE = ABIMethod.fromSignature("execute(uint256[],(byte[64],byte[128],byte[64]),uint64,address,uint64,uint64,uint64,byte[64])void");
const ENROLL = ABIMethod.fromSignature("enroll(uint256[],(byte[64],byte[128],byte[64]),address,byte[64])uint64");
const OPERATIONS = { 0: "enroll", 1: "send ALGO", 2: "opt in to asset", 3: "send asset" };
const GROUP_SIZE = 7;

const b64 = (s) => Buffer.from(s, "base64");
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const decimal = (bytes) => BigInt(`0x${Buffer.from(bytes).toString("hex")}`).toString();
const getJson = async (url) => {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (response.ok) return response.json();
    if (attempt >= 3 || (response.status !== 429 && response.status < 500)) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
    await new Promise((done) => setTimeout(done, 1000 * (attempt + 1)));
  }
};
const indexer = (path) => getJson(`${opts.indexer}/v2${path}`);
async function* pages(path, key) {
  let next;
  do {
    const page = await indexer(`${path}${path.includes("?") ? "&" : "?"}limit=1000${next ? `&next=${next}` : ""}`);
    yield* page[key] ?? [];
    next = page["next-token"];
  } while (next);
}
const globalState = (app) => Object.fromEntries((app.params["global-state"] ?? []).map((s) => [b64(s.key).toString(), s.value]));
const stateBytes = (state, key) => (state[key] ? b64(state[key].bytes) : undefined);
const stateUint = (state, key) => (state[key] ? BigInt(state[key].uint) : undefined);

const report = {
  recordedAt: new Date().toISOString(),
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim(),
  network: "testnet-v1.0",
  stack: "compose.testnet.yaml",
  service: opts.service,
  login: "Genuine Google sign-in through @algozkauth/sdk (in-page Google Identity Services)",
  prover: "services/prover in Docker",
  developmentTrustedSetup: true,
  status: "pending",
  checks: [],
  apps: [],
};
const check = (name, passed, details = {}) => { report.checks.push({ check: name, passed: !!passed, ...details }); return !!passed; };

const versions = await getJson(`${opts.algod}/versions`);
const testnetGenesis = b64(versions.genesis_hash_b64);
check("The node is Algorand TestNet", versions.genesis_id === "testnet-v1.0", { genesisId: versions.genesis_id });

const blocks = new Map();
const block = async (round) => { if (!blocks.has(round)) blocks.set(round, await indexer(`/blocks/${round}`)); return blocks.get(round); };

for (const entry of opts.apps.split(",").map((a) => a.trim()).filter(Boolean)) {
  const appId = entry.replace(/\?$/, "");
  if (entry.endsWith("?") && (await fetch(`${opts.service}/v1/apps/${appId}/config`)).status === 404) continue;
  const config = await getJson(`${opts.service}/v1/apps/${appId}/config`);
  const provider = providerById(config.provider);
  const vkBytes = readFileSync(`${root}${provider.circuit.directory}/verification_key.json`);
  const vk = JSON.parse(vkBytes);
  const app = {
    app: appId, provider: config.provider, network: config.network, registryId: config.registryId, keyRegistryId: config.keyRegistryId,
    verifier: config.verifier, sponsor: config.sponsor, audienceHash: config.audienceHash, enrollmentDeposit: config.enrollmentDeposit,
    wallets: [], actions: [],
  };
  report.apps.push(app);
  const label = (text) => `${appId}: ${text}`;

  check(label("the service reports TestNet and its genesis hash"), config.network === "testnet" && b64url(testnetGenesis) === config.genesisHash);
  check(label("the published verification key matches the deployment's"), sha256(vkBytes) === config.verificationKeySha256);

  const registry = (await indexer(`/applications/${config.registryId}`)).application;
  const registryState = globalState(registry);
  check(label("the wallet registry is bound to the app's audience"), b64url(stateBytes(registryState, "audience") ?? []) === config.audienceHash);
  check(label("the wallet registry uses the provider's key registry"), stateUint(registryState, "keyRegistry") === BigInt(config.keyRegistryId));
  check(label("the wallet registry uses the deployment's verifier LogicSig"), stateBytes(registryState, "verifier")?.equals(decodeAddress(config.verifier).publicKey));
  check(label("the wallet registry was created by the sponsor"), registry.params.creator === config.sponsor, { creator: registry.params.creator });

  const keyRegistry = (await indexer(`/applications/${config.keyRegistryId}`)).application;
  const keyState = globalState(keyRegistry);
  app.keyRegistry = { administrator: keyRegistry.params.creator, sealed: stateUint(keyState, "sealed") === 1n, paused: stateUint(keyState, "paused") === 1n };
  check(label("the key registry is sealed and not paused"), app.keyRegistry.sealed && !app.keyRegistry.paused);
  check(label("the key registry's administrator is not the sponsor"), keyRegistry.params.creator !== config.sponsor, { administrator: keyRegistry.params.creator });

  // Every wallet this app's registry created, and its proof-carrying calls.
  const registryAddress = getApplicationAddress(BigInt(config.registryId)).toString();
  const created = (await indexer(`/accounts/${registryAddress}/created-applications`)).applications ?? [];
  const keyApproval = new Map();
  const confirmed = [];
  for (const walletApp of created) {
    const walletId = String(walletApp.id);
    const walletState = globalState(walletApp);
    const owner = stateBytes(walletState, "owner");
    const address = getApplicationAddress(BigInt(walletId)).toString();
    const account = (await indexer(`/accounts/${address}`)).account;
    const wallet = { walletId, address, nonce: String(stateUint(walletState, "nonce") ?? 0n), balanceMicroAlgos: String(account.amount),
      assets: (account.assets ?? []).map((a) => ({ id: String(a["asset-id"]), amount: String(a.amount) })), actions: 0 };
    app.wallets.push(wallet);
    check(label(`wallet ${walletId} is bound to the app's audience and key registry`),
      b64url(stateBytes(walletState, "audience") ?? []) === config.audienceHash && stateUint(walletState, "keyRegistry") === BigInt(config.keyRegistryId)
      && stateUint(walletState, "registry") === BigInt(config.registryId) && !!stateBytes(walletState, "verifier")?.equals(decodeAddress(config.verifier).publicKey));

    // Enrollment is a registry call naming no wallet yet; actions are calls to the wallet.
    const calls = [];
    for await (const t of pages(`/transactions?application-id=${config.registryId}&tx-type=appl`, "transactions")) calls.push(t);
    for await (const t of pages(`/transactions?application-id=${walletId}&tx-type=appl`, "transactions")) calls.push(t);
    // The indexer can list a call more than once; keep each transaction once.
    const unique = [...new Map(calls.map((t) => [t.id, t])).values()];
    for (const txn of unique.sort((a, b) => a["confirmed-round"] - b["confirmed-round"] || a["intra-round-offset"] - b["intra-round-offset"])) {
      // Plain Uint8Arrays: algosdk's ABI decoder misreads pooled Buffers.
      const args = (txn["application-transaction"]["application-args"] ?? []).map((s) => Uint8Array.from(b64(s)));
      const method = [ENROLL, EXECUTE].find((m) => args[0] && Buffer.from(m.getSelector()).equals(Buffer.from(args[0])));
      if (!method) continue;
      const decoded = method.args.map((arg, i) => arg.type.decode(args[i + 1]));
      const signals = decoded[0].map((v) => BigInt(v).toString());
      // Registry calls also cover other wallets; keep the ones whose inner calls created this wallet.
      const enroll = method === ENROLL;
      if (enroll && !(txn["inner-txns"] ?? []).some((i) => String(i["created-application-index"] ?? "") === walletId)) continue;
      const [a, b, c] = decoded[1].map((v) => Buffer.from(v));
      const proof = { protocol: "groth16", curve: "bn128",
        pi_a: [decimal(a.subarray(0, 32)), decimal(a.subarray(32)), "1"],
        pi_b: [[decimal(b.subarray(0, 32)), decimal(b.subarray(32, 64))], [decimal(b.subarray(64, 96)), decimal(b.subarray(96))], ["1", "0"]],
        pi_c: [decimal(c.subarray(0, 32)), decimal(c.subarray(32)), "1"] };
      const operation = enroll ? "0" : String(decoded[2]);
      const recipient = String(decoded[enroll ? 2 : 3]);
      const action = {
        genesisHash: signalDigest(signals, 8), registryId: BigInt(config.registryId), walletId: enroll ? 0n : BigInt(walletId),
        owner: signalDigest(signals, 0), operation: BigInt(operation), recipient: Buffer.from(decodeAddress(recipient).publicKey),
        assetId: enroll ? 0n : BigInt(decoded[4]), amount: enroll ? BigInt(config.enrollmentDeposit) : BigInt(decoded[5]),
        nonce: enroll ? 0n : BigInt(decoded[6]), sessionExpiresAt: BigInt(signals[10]),
      };
      const signature = Buffer.from(decoded[enroll ? 3 : 7]);
      const sessionKey = signalDigest(signals, 6);
      const time = txn["round-time"];

      // The provider key that signed the login, as the key registry held it at that time.
      const keyHash = signalDigest(signals, 2);
      const keyId = keyHash.toString("base64url");
      if (!keyApproval.has(keyId)) {
        const box = await indexer(`/applications/${config.keyRegistryId}/box?name=${encodeURIComponent(`b64:${Buffer.concat([Buffer.from("gk:"), keyHash]).toString("base64")}`)}`).catch(() => undefined);
        const value = box ? b64(box.value) : undefined;
        keyApproval.set(keyId, value ? { validFrom: value.readBigUInt64BE(0), validUntil: value.readBigUInt64BE(8), revoked: value[16] !== 0 } : undefined);
      }
      const key = keyApproval.get(keyId);

      // The outer group from the block: its size and who paid the fees.
      const outer = (await block(txn["confirmed-round"])).transactions.filter((t) => t.group && t.group === txn.group);
      const feePayers = [...new Set(outer.filter((t) => t.fee > 0).map((t) => t.sender))];
      const transfer = (txn["inner-txns"] ?? []).find((i) => i["tx-type"] === "pay" || i["tx-type"] === "axfer");
      const moved = transfer?.["payment-transaction"] ?? transfer?.["asset-transfer-transaction"];

      let proofOk = false;
      try { proofOk = await snarkjs.groth16.verify(vk, signals, proof); } catch { proofOk = false; }
      let signatureOk = false;
      try { signatureOk = verify(null, actionDigest(action), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: sessionKey.toString("base64url") }, format: "jwk" }), signature); } catch { signatureOk = false; }

      const results = {
        "from the verifier LogicSig": txn.sender === config.verifier,
        "Groth16 proof verifies": proofOk,
        "session key signed exactly this action": signatureOk,
        "bound to TestNet": action.genesisHash.equals(testnetGenesis),
        "bound to the app's audience": signalDigest(signals, 4).toString("base64url") === config.audienceHash,
        "owner is the wallet's commitment": !!owner && action.owner.equals(owner),
        "inside the session window": BigInt(signals[11]) <= BigInt(time) && BigInt(time) < action.sessionExpiresAt,
        "provider key approved at the time": !!key && !key.revoked && key.validFrom <= BigInt(time) && BigInt(time) < key.validUntil,
        [`a ${GROUP_SIZE}-transaction atomic group`]: outer.length === GROUP_SIZE,
        "fees paid by the sponsor": feePayers.length === 1 && feePayers[0] === config.sponsor,
        // Enrollment's inner calls create and fund the wallet; an action's inner transfer is the signed one.
        "the inner transfer matches the signed action": enroll || !!moved && moved.receiver === recipient && BigInt(moved.amount) === action.amount
          && (transfer["tx-type"] === "pay" ? action.assetId === 0n : BigInt(moved["asset-id"] ?? transfer["asset-transfer-transaction"]["asset-id"]) === action.assetId),
      };
      const failed = Object.entries(results).filter(([, ok]) => !ok).map(([name]) => name);
      check(label(`${OPERATIONS[operation]} ${txn.id} (wallet ${walletId}, nonce ${action.nonce})`), failed.length === 0, failed.length ? { failed } : {});
      wallet.actions++;
      confirmed.push({ walletId, txId: txn.id, enroll, expiresAt: action.sessionExpiresAt, proof: { proof, publicSignals: signals }, signature,
        plan: { planId: txn.id, version: 1, genesisHash: b64url(action.genesisHash), registryId: config.registryId, walletId: String(action.walletId), owner: b64url(action.owner),
          operation, recipient, recipientPublicKey: b64url(action.recipient), assetId: String(action.assetId), amount: String(action.amount), nonce: String(action.nonce), sessionExpiresAt: String(action.sessionExpiresAt) } });
      app.actions.push({
        txId: txn.id, round: txn["confirmed-round"], roundTime: time, walletId, operation: OPERATIONS[operation], nonce: String(action.nonce),
        recipient, assetId: String(action.assetId), amount: String(action.amount), selfTransfer: recipient === address || undefined,
        groupSize: outer.length, groupFeeMicroAlgos: String(outer.reduce((sum, t) => sum + BigInt(t.fee), 0n)),
        providerKey: keyId, passed: failed.length === 0,
      });
    }
    check(label(`wallet ${walletId}'s nonce equals its confirmed actions`), BigInt(wallet.nonce) === BigInt(app.actions.filter((a) => a.walletId === walletId && a.operation !== "enroll").length));
  }
  check(label("at least one wallet enrolled"), app.wallets.length > 0, { wallets: app.wallets.length });

  // Simulated rejections: recorded ones are kept, new ones need an open session.
  const known = new Set(app.actions.map((a) => a.txId));
  const kept = (previous?.apps?.find((a) => a.app === appId)?.rejections ?? []).filter((r) => known.has(r.sourceTxId));
  const rejections = [...kept];
  if (opts.rejections) {
    const opened = await openedChain();
    const { simulateIsolation, simulateReplay } = await import("../packages/chain/src/rejections.ts");
    const deployments = {
      provider: { network: "testnet", genesisHash: config.genesisHash, provider: config.provider, verifier: config.verifier, verificationKeySha256: config.verificationKeySha256,
        keyRegistryId: config.keyRegistryId, guardian: "", administrator: keyRegistry.params.creator, createdAt: "" },
      app: { app: appId, provider: config.provider, audience: config.clientId, audienceHash: config.audienceHash, registryId: config.registryId,
        enrollmentDeposit: config.enrollmentDeposit, groupFeeMicroAlgos: config.groupFeeMicroAlgos },
    };
    const now = await opened.time();
    const open = (c) => c.expiresAt > now + 30n;
    const already = (kind, txId) => rejections.some((r) => r.kind === kind && r.sourceTxId === txId);
    for (const wallet of app.wallets) {
      const mine = confirmed.filter((c) => c.walletId === wallet.walletId);
      const latestExecution = mine.filter((c) => !c.enroll).at(-1);
      if (latestExecution && open(latestExecution) && !already("replay", latestExecution.txId)) {
        const result = await simulateReplay(opened, deployments, { ...latestExecution, sponsor: config.sponsor });
        rejections.push({ kind: "replay", sourceTxId: latestExecution.txId, walletId: wallet.walletId, simulated: true, simulatedAt: new Date().toISOString(), rejectedBy: result.assertion, passed: result.rejected, ...(result.message ? { message: result.message } : {}) });
      }
      const latest = mine.at(-1);
      const other = app.wallets.find((w) => w.walletId !== wallet.walletId);
      if (latest && other && open(latest) && !already("isolation", latest.txId)) {
        const result = await simulateIsolation(opened, deployments, { ...latest, sponsor: config.sponsor, otherWalletId: other.walletId });
        rejections.push({ kind: "isolation", sourceTxId: latest.txId, walletId: wallet.walletId, otherWalletId: other.walletId, simulated: true, simulatedAt: new Date().toISOString(), rejectedBy: result.assertion, passed: result.rejected, ...(result.message ? { message: result.message } : {}) });
      }
    }
  }
  if (rejections.length) app.rejections = rejections;
  for (const r of rejections) check(label(r.kind === "replay" ? `simulated replay of ${r.sourceTxId} is rejected at the nonce check` : `${r.sourceTxId}'s proof is rejected at wallet ${r.otherWalletId}'s owner check (simulated)`), r.passed);
}

report.status = report.checks.every((c) => c.passed) ? "passed" : "failed";
report.summary = {
  checks: `${report.checks.filter((c) => c.passed).length}/${report.checks.length}`,
  wallets: report.apps.reduce((n, a) => n + a.wallets.length, 0),
  confirmedActions: report.apps.reduce((n, a) => n + a.actions.length, 0),
};
report.summary.simulatedRejections = report.apps.reduce((n, a) => n + (a.rejections?.length ?? 0), 0);
writeFileSync(`${root}${opts.out}`, JSON.stringify(report, null, 2) + "\n");
await chain?.close();
for (const c of report.checks) console.log(`${c.passed ? "ok  " : "FAIL"} ${c.check}${c.failed ? `: ${c.failed.join(", ")}` : ""}`);
console.log(`${report.status}: ${report.summary.checks} checks, ${report.summary.wallets} wallets, ${report.summary.confirmedActions} confirmed groups; wrote ${opts.out}`);
process.exit(report.status === "passed" ? 0 : 1);
