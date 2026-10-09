// Read-only acceptance. Reads public TestNet data and private local proof
// results; never loads a mnemonic, JWT, salt, recovery secret or signing key.
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { createHash, createPublicKey, verify } from "node:crypto";
import { AlgorandClient } from "../upstream/snarkjs-algorand/node_modules/@algorandfoundation/algokit-utils/index.mjs";
import { ABIMethod, decodeAddress, encodeAddress, getApplicationAddress } from "../upstream/snarkjs-algorand/node_modules/algosdk/dist/esm/index.js";
import * as snarkjs from "../upstream/snarkjs-algorand/node_modules/snarkjs/main.js";
import { encodeGroth16Bn254Proof } from "../upstream/snarkjs-algorand/src/groth16.ts";
import { APP_SPEC as WALLET_SPEC } from "../upstream/snarkjs-algorand/contracts/clients/UserWallet.ts";
import { APP_SPEC as REGISTRY_SPEC } from "../upstream/snarkjs-algorand/contracts/clients/WalletRegistry.ts";
import { actionDigest, signalDigest } from "../src/phase4/action.mjs";
import { confirmedGroupFromBlock } from "../src/phase6/receipts.mjs";

const root = new URL("../", import.meta.url).pathname;
const json = path => JSON.parse(readFileSync(`${root}${path}`, "utf8"));
const sameBytes = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const report = { recordedAt: new Date().toISOString(), network: "testnet-v1.0", status: "pending", checks: [], wallets: [], confirmedActions: [], deferred: ["Actual passkey PRF", "Other-browser recovery", "Physical second-device recovery"], developmentTrustedSetup: true, localNodeProver: true };
const check = (name, passed, details = {}) => { report.checks.push({ check: name, passed: !!passed, ...details }); return !!passed; };
const requireCheck = (name, condition) => { if (!condition) throw new Error(name); };
const save = () => {
  writeFileSync(`${root}benchmarks/phase6-acceptance.testnet.json`, JSON.stringify(report, null, 2) + "\n");
  const path = `${root}docs/poc-report.md`;
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf8");
  const pending = report.checks.filter(c => !c.passed).map(c => `- ${c.check}`).join("\n");
  const wallets = report.wallets.map(w => `| ${w.accountCase} | ${w.walletId} | ${w.address} | ${w.nonce} | ${w.balanceMicroAlgos} | ${w.assets.find(a => a.id === report.demoAssetId)?.amount ?? "Not opted in"} |`).join("\n");
  const proofs = (report.proofMeasurements ?? []).map(p => `- Account ${p.accountCase}: ${(p.elapsedMs / 1000).toFixed(1)} s total, ${(p.witnessMs / 1000).toFixed(1)} s witness, ${(p.proveMs / 1000).toFixed(1)} s proving; ${(p.peakRssBytes / 1024 ** 3).toFixed(2)} GiB sampled peak Node RSS (${p.nodeVersion ?? "unrecorded version"}, ${p.platform ?? "unknown platform"}/${p.architecture ?? "unknown architecture"}).`).join("\n");
  const outcome = report.status === "failed" ? "The latest validation run failed. Earlier successful evidence is not revoked; resolve the checker error before making an updated acceptance decision.\n\n" : pending ? `Pending:\n\n${pending}\n\n` : "The local Google/TestNet scenario passed. Physical second-device recovery remains unverified.\n\n";
  const block = `<!-- phase6-acceptance:start -->\nLatest read-only acceptance: **${report.status}**, recorded ${report.recordedAt}. ${report.checks.filter(c => c.passed).length}/${report.checks.length} checks passed; ${report.confirmedActions.length} confirmed actions independently inspected. [Machine-readable result](../benchmarks/phase6-acceptance.testnet.json).\n\n${outcome}${wallets ? `| Account | Wallet app | Address | Nonce | Balance (µALGO) | Demo ASA units |\n| --- | --- | --- | ---: | ---: | ---: |\n${wallets}\n\n` : "No wallet state was validated in this run.\n\n"}${proofs ? `Measured Phase 6 proofs:\n\n${proofs}\n\n` : "Proof measurements were not collected by this validation run.\n\n"}<!-- phase6-acceptance:end -->`;
  writeFileSync(path, content.replace(/<!-- phase6-acceptance:start -->[\s\S]*?<!-- phase6-acceptance:end -->/, block));
};
const globalState = params => Object.fromEntries((params.globalState ?? []).map(s => [Buffer.from(s.key).toString("utf8"), s.value.type === 1 ? Buffer.from(s.value.bytes) : s.value.uint]));
const innerResults = r => (r.innerTxns ?? []).flatMap(i => [i, ...innerResults(i)]);
let curve;
try {
  const deployment = json("benchmarks/phase6-deployment.testnet.json");
  const policy = json("benchmarks/phase6-policy.testnet.json");
  report.registryId = deployment.registryId; report.keyRegistryId = deployment.keyRegistryId; report.demoAssetId = deployment.demoAssetId;
  const vkBytes = readFileSync(`${root}fixtures/phase3/verification_key.json`);
  requireCheck("Verification key differs from deployment", sha256(vkBytes) === deployment.verificationKeySha256);
  const vk = JSON.parse(vkBytes);
  const algod = AlgorandClient.testNet().client.algod;
  const blocks = new Map();
  const params = await algod.getTransactionParams().do();
  requireCheck("Unexpected network genesis", params.genesisID === deployment.network && sameBytes(params.genesisHash, Buffer.from(deployment.genesisHash, "base64url")));
  const registry = await algod.getApplicationByID(BigInt(deployment.registryId)).do();
  const registryState = globalState(registry.params);
  requireCheck("Deployed registry code or policy differs", sameBytes(registry.params.approvalProgram, Buffer.from(REGISTRY_SPEC.byteCode.approval, "base64")) && String(registryState.keyRegistry) === deployment.keyRegistryId && encodeAddress(registryState.verifier) === deployment.verifier && sameBytes(registryState.audience, Buffer.from(deployment.audienceHash, "base64url")));
  check("Pinned TestNet registry code, verifier, key registry and audience", true);
  check("Disposable TestNet key/session-policy checks", policy.network === deployment.network && policy.mainDemoRegistryUnchanged && policy.checks.length === 9 && policy.checks.every(c => c.passed), { policyRegistryId: policy.policyRegistryId, actualProviderRotationTriggered: false });

  const benchmarkPath = `${root}benchmarks/phase6-demo.testnet.json`;
  const benchmark = existsSync(benchmarkPath) ? json("benchmarks/phase6-demo.testnet.json") : { events: [] };
  requireCheck("Browser evidence belongs to another registry", !benchmark.registryId || benchmark.registryId === deployment.registryId);
  const events = benchmark.events;
  const identities = existsSync(`${root}.local/phase6/audit-identities.json`) ? json(".local/phase6/audit-identities.json") : [];
  const genuine = new Set(events.filter(e => e.kind === "login" && e.genuineGoogleToken).map(e => e.accountCase));
  const cases = [...genuine].filter(label => identities.some(i => i.label === label));
  const tags = cases.map(label => identities.find(i => i.label === label).tag);
  check("Two distinct authenticated Google identities", cases.length >= 2 && new Set(tags).size >= 2, { accountCases: cases, identityTagsKeptPrivate: true });
  const results = [];
  const jobsDir = `${root}.local/phase6/jobs`;
  // Only result.json contains public proof/signals. Do not inspect input.json.
  if (existsSync(jobsDir)) for (const jobId of readdirSync(jobsDir)) {
    if (!/^[a-f0-9-]{36}$/.test(jobId) || !existsSync(`${jobsDir}/${jobId}/result.json`)) continue;
    const result = JSON.parse(readFileSync(`${jobsDir}/${jobId}/result.json`, "utf8"));
    results.push({ jobId, ...result });
  }
  curve = await snarkjs.curves.getCurveFromName("bn128");
  const checkedProofs = new Set(); const owners = new Set();
  const confirmed = events.filter(e => e.kind === "action");
  for (const accountCase of cases) {
    const actions = confirmed.filter(e => e.accountCase === accountCase);
    if (!actions.length) continue;
    const walletId = actions[0].walletId;
    requireCheck("One account used inconsistent wallet IDs", actions.every(e => e.walletId === walletId));
    const application = await algod.getApplicationByID(BigInt(walletId)).do();
    const state = globalState(application.params);
    const owner = state.owner; const address = getApplicationAddress(BigInt(walletId)).toString();
    requireCheck("Wallet code, address, owner or policy differs", owner?.length === 32 && sameBytes(application.params.approvalProgram, Buffer.from(WALLET_SPEC.byteCode.approval, "base64")) && String(state.registry) === deployment.registryId && String(state.keyRegistry) === deployment.keyRegistryId && encodeAddress(state.verifier) === deployment.verifier && sameBytes(state.audience, registryState.audience) && actions.every(e => e.address === address));
    const canonical = await algod.getApplicationBoxByName(BigInt(deployment.registryId), Buffer.concat([Buffer.from("w:"), owner])).do();
    requireCheck("Registry does not map owner to original wallet", Buffer.from(canonical.value).length === 8 && Buffer.from(canonical.value).readBigUInt64BE() === BigInt(walletId));
    const ownerText = owner.toString("base64url"); owners.add(ownerText);
    const account = await algod.accountInformation(address).do();
    const publicKeys = new Set(); let nextNonce = 0n;
    for (const event of actions) {
      requireCheck("Missing genuine proof flag or transaction IDs", event.genuineGoogleToken === true && event.transactionIds?.length === 7);
      if (!blocks.has(event.confirmedRound)) blocks.set(event.confirmedRound, algod.block(BigInt(event.confirmedRound)).do());
      const block = (await blocks.get(event.confirmedRound)).block;
      const receipts = confirmedGroupFromBlock(block, event.transactionIds, { round: event.confirmedRound, genesisID: params.genesisID, genesisHash: params.genesisHash });
      const round = receipts[0].confirmedRound;
      requireCheck("Unconfirmed or inconsistent atomic group", round > 0n && String(round) === event.confirmedRound && receipts.every((r, i) => !r.poolError && r.confirmedRound === round && r.txn.txn.txID() === event.transactionIds[i] && sameBytes(r.txn.txn.group, receipts[0].txn.txn.group) && sameBytes(r.txn.txn.genesisHash, params.genesisHash)));
      const enrollment = event.operation === "0";
      const main = receipts[enrollment ? 1 : 0].txn.txn;
      const method = ABIMethod.fromSignature(enrollment ? "enroll(uint256[],(byte[64],byte[128],byte[64]),address,byte[64])uint64" : "execute(uint256[],(byte[64],byte[128],byte[64]),uint64,address,uint64,uint64,uint64,byte[64])void");
      const call = main.applicationCall;
      requireCheck("Unexpected application, method or verifier", main.type === "appl" && String(call.appIndex) === (enrollment ? deployment.registryId : walletId) && main.sender.toString() === deployment.verifier && sameBytes(call.appArgs[0], method.getSelector()) && call.onComplete === 0);
      // SDK 3.4's dynamic-array decoder reads its backing buffer at offset 0.
      // RPC byte views can have a nonzero offset; copy before ABI decoding.
      const args = method.args.map((arg, i) => arg.type.decode(Uint8Array.from(call.appArgs[i + 1])));
      const signals = args[0].map(BigInt);
      requireCheck("Proof public bindings differ from wallet", signals.length === 12 && signalDigest(signals, 0).equals(owner) && sameBytes(signalDigest(signals, 4), registryState.audience) && sameBytes(signalDigest(signals, 8), params.genesisHash));
      const matching = results.find(result => JSON.stringify(result.publicSignals) === JSON.stringify(signals.map(String)));
      requireCheck("Missing locally recorded public proof", !!matching);
      const proofEvent = events.find(e => e.kind === "proof" && e.accountCase === accountCase && e.genuineGoogleToken && e.jobId === matching.jobId);
      requireCheck("Proof lacks authenticated account provenance", !!proofEvent);
      if (!checkedProofs.has(matching.jobId)) {
        requireCheck("Independent Groth16 verification failed", await snarkjs.groth16.verify(vk, matching.publicSignals, matching.proof));
        checkedProofs.add(matching.jobId);
      }
      const encoded = encodeGroth16Bn254Proof(structuredClone(matching.proof), curve);
      requireCheck("On-chain proof differs from verified proof", sameBytes(call.appArgs[2], Buffer.concat([encoded.piA, encoded.piB, encoded.piC])));
      const sessionKey = signalDigest(signals, 6); publicKeys.add(sessionKey.toString("base64url"));
      const action = { genesisHash: params.genesisHash, registryId: BigInt(deployment.registryId), walletId: enrollment ? 0n : BigInt(walletId), owner, operation: enrollment ? 0n : args[2], recipient: decodeAddress(enrollment ? args[2] : args[3]).publicKey, assetId: enrollment ? 0n : args[4], amount: enrollment ? BigInt(deployment.enrollmentDeposit) : args[5], nonce: enrollment ? 0n : args[6], sessionExpiresAt: signals[10] };
      const signature = enrollment ? args[3] : args[7];
      requireCheck("On-chain action differs from recorded request", String(action.operation) === event.operation && String(action.assetId) === event.assetId && String(action.amount) === event.amount && String(action.nonce) === event.nonce && encodeAddress(action.recipient) === event.recipient);
      requireCheck("Independent browser action signature verification failed", verify(null, actionDigest(action), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: sessionKey.toString("base64url") }, format: "jwk" }), Buffer.from(signature)));
      requireCheck("Execution nonce sequence differs", enrollment || action.nonce === nextNonce);
      if (!enrollment) nextNonce++;
      const inners = receipts.flatMap(innerResults);
      requireCheck("Inner transaction charged wallet fees", inners.every(i => i.txn.txn.fee === 0n));
      if (enrollment) {
        const payment = receipts[0].txn.txn;
        requireCheck("Wrong enrollment deposit or created wallet", payment.type === "pay" && payment.sender.toString() === deployment.sponsor && payment.payment.receiver.toString() === getApplicationAddress(BigInt(deployment.registryId)).toString() && payment.payment.amount === action.amount && inners.some(i => i.applicationIndex === BigInt(walletId)));
      } else {
        const transfer = inners.find(i => i.txn.txn.sender.toString() === address && ["pay", "axfer"].includes(i.txn.txn.type))?.txn.txn;
        requireCheck("No matching wallet inner transfer", !!transfer);
        if (action.operation === 1n) requireCheck("ALGO inner transfer differs from signed action", transfer.type === "pay" && transfer.payment.amount === action.amount && transfer.payment.receiver.toString() === event.recipient);
        else requireCheck("ASA inner transfer differs from signed action", transfer.type === "axfer" && transfer.assetTransfer.assetIndex === action.assetId && transfer.assetTransfer.amount === action.amount && transfer.assetTransfer.receiver.toString() === event.recipient);
      }
      const fees = receipts.reduce((sum, r) => sum + r.txn.txn.fee, 0n);
      requireCheck("Group fee differs from benchmark", String(fees) === event.groupFeeMicroAlgos && fees === BigInt(deployment.groupFeeMicroAlgos));
      report.confirmedActions.push({ accountCase, walletId, operation: event.operation, transactionIds: event.transactionIds, confirmedRound: String(round), confirmationSource: "algod-historical-block", feeMicroAlgos: String(fees), independentProofAndActionSignatureVerified: true, innerTransferChecked: true });
    }
    requireCheck("Current wallet nonce differs from confirmed actions", state.nonce === nextNonce);
    const baseline = events.findLast(e => e.accountCase === accountCase && e.walletId === walletId && ["fund", "seed"].includes(e.kind));
    if (baseline) {
      const after = events.slice(events.indexOf(baseline) + 1).filter(e => e.kind === "action" && e.accountCase === accountCase);
      const expectedBalance = BigInt(baseline.balanceMicroAlgos) - after.filter(e => e.operation === "1" && e.recipient !== address).reduce((s, e) => s + BigInt(e.amount), 0n);
      requireCheck("ALGO balance differs from funding and signed transfers", account.amount === expectedBalance);
      const seed = events.findLast(e => e.kind === "seed" && e.accountCase === accountCase && e.walletId === walletId);
      if (seed) {
        const expectedAsset = BigInt(seed.assets.find(a => a.id === deployment.demoAssetId).amount) - events.slice(events.indexOf(seed) + 1).filter(e => e.kind === "action" && e.accountCase === accountCase && e.operation === "3" && e.assetId === deployment.demoAssetId && e.recipient !== address).reduce((s, e) => s + BigInt(e.amount), 0n);
        requireCheck("ASA balance differs from funding and signed transfers", account.assets.find(a => String(a.assetId) === deployment.demoAssetId)?.amount === expectedAsset);
      }
    }
    report.wallets.push({ accountCase, walletId, address, ownerCommitment: ownerText, nonce: String(state.nonce), balanceMicroAlgos: String(account.amount), minBalanceMicroAlgos: String(account.minBalance), assets: (account.assets ?? []).map(a => ({ id: String(a.assetId), amount: String(a.amount) })), originalRegistryDiscoveryVerified: true, distinctConfirmedSessionKeys: publicKeys.size });
    check(`Account ${accountCase}: enrollment, funding, ALGO and ASA transfers`, ["0", "1", "2", "3"].every(op => actions.some(e => e.operation === op)) && events.some(e => e.kind === "fund" && e.accountCase === accountCase) && events.some(e => e.kind === "seed" && e.accountCase === accountCase));
    check(`Account ${accountCase}: real node replay rejection`, events.some(e => e.kind === "replay" && e.accountCase === accountCase && e.replayRejectedByNode && e.noncePreserved));
  }
  check("Two distinct original wallets with confirmed ALGO/ASA actions", report.wallets.length >= 2 && owners.size === report.wallets.length && new Set(report.wallets.map(w => w.address)).size === report.wallets.length);
  check("Other-wallet owner rejection at the TestNet node", events.some(e => e.kind === "isolation" && e.wrongOwnerRejectedByNode && e.otherNonceAndBalancePreserved && e.mappedAssertion === "Wrong owner"));
  check("Fresh Google session key authorizes the original wallet", report.wallets.some(w => w.distinctConfirmedSessionKeys >= 2));
  check("Secret restore discovers and transfers from an existing TestNet wallet", events.some(e => e.kind === "restore-discovery" && e.walletId !== "0" && e.ownerAndPolicyChecked && events.some(a => a.kind === "action" && a.operation === "1" && a.accountCase === e.accountCase && a.walletId === e.walletId && a.recordedAt > e.recordedAt)));
  report.proofsIndependentlyVerified = checkedProofs.size;
  report.proofMeasurements = events.filter(e => e.kind === "proof").map(({ accountCase, witnessMs, proveMs, elapsedMs, peakRssBytes, nodeVersion, platform, architecture }) => ({ accountCase, witnessMs, proveMs, elapsedMs, peakRssBytes, nodeVersion, platform, architecture }));
  report.actionMeasurements = confirmed.map(({ accountCase, operation, groupFeeMicroAlgos, outerTransactions, innerTransactions, signedBytes, appBudgetConsumed, logicSigBudgetConsumed, confirmationMs }) => ({ accountCase, operation, groupFeeMicroAlgos, outerTransactions, innerTransactions, signedBytes, appBudgetConsumed, logicSigBudgetConsumed, confirmationMs }));
  report.status = report.checks.every(c => c.passed) ? "passed-with-deferred-device-gate" : "pending";
  save();
  console.log(JSON.stringify({ status: report.status, checksPassed: report.checks.filter(c => c.passed).length, checksTotal: report.checks.length, confirmedActions: report.confirmedActions.length, pending: report.checks.filter(c => !c.passed).map(c => c.check), evidence: "benchmarks/phase6-acceptance.testnet.json" }, null, 2));
  if (report.status === "pending") process.exitCode = 2;
} catch (error) {
  report.status = "failed";
  // External SDK errors can contain request traces; keep them out of artifacts.
  report.error = "Read-only acceptance failed; inspect the public node data and local acceptance checks.";
  save(); console.error(report.error); process.exitCode = 1;
  if (process.env.DEMO_CHECK_DEBUG === "1") console.error(error.name + ": " + error.message);
} finally { await curve?.terminate(); await globalThis.curve_bn128?.terminate(); }
