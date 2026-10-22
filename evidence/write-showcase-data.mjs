// Extracts the public facts that the GitHub Pages showcase (apps/showcase)
// replays from two recorded TestNet runs into apps/showcase/src/data/:
//
//   recorded-run.json       the original demo's Google run (benchmarks/phase6-*):
//                           deployment IDs, wallets, and the ordered steps with
//                           their transaction IDs. User agents and identity tags
//                           are left out.
//   service-stack-run.json  the service stack's run (benchmarks/service-stack.testnet.json,
//                           written by evidence/check-service-stack.mjs): each app's
//                           deployment, wallets, confirmed actions and any simulated
//                           rejections.
//   providers.json          each login provider's label and committed verification key.
//
// Deterministic: the same records always produce the same files.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PROVIDERS } from "../packages/protocol/src/oidc-providers.mjs";

const root = new URL("../", import.meta.url).pathname;
const out = `${root}apps/showcase/src/data/`;
const json = path => JSON.parse(readFileSync(`${root}${path}`, "utf8"));
const write = (name, data) => writeFileSync(`${out}${name}`, JSON.stringify(data, null, 1) + "\n");
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));
mkdirSync(out, { recursive: true });

// --- The original demo's Google run -------------------------------------------
const acceptance = json("benchmarks/phase6-acceptance.testnet.json");
const deployment = json("benchmarks/phase6-deployment.testnet.json");
const demo = json("benchmarks/phase6-demo.testnet.json");

// Only actions that the acceptance checker confirmed in historical blocks.
const confirmed = new Set(acceptance.confirmedActions.map(a => a.transactionIds[0]));
const steps = [];
const pendingProof = {};
const restored = new Set();
const last = account => steps.findLast(s => s.account === account);
for (const e of demo.events) {
  const account = e.accountCase;
  const at = e.recordedAt;
  if (e.kind === "login") {
    if (pendingProof[account]) pendingProof[account].usedBeforeExpiry = false;
    pendingProof[account] = undefined;
    // Consecutive sign-ins without progress are retries of the same step.
    if (last(account)?.kind !== "login") steps.push({ account, kind: "login", at });
    else last(account).at = at;
  } else if (e.kind === "restore-discovery") {
    const kind = e.walletId === "0" ? "backup" : "restore";
    if (kind === "restore") restored.add(account);
    if (last(account)?.kind !== kind) steps.push({ account, kind, at, ...(kind === "restore" ? { walletId: e.walletId } : {}) });
  } else if (e.kind === "proof") {
    const step = { account, kind: "proof", at, seconds: Math.round(e.elapsedMs / 1000), peakMiB: Math.round(e.peakRssBytes / 2 ** 20), usedBeforeExpiry: true };
    pendingProof[account] = step;
    steps.push(step);
  } else if (e.kind === "action" && confirmed.has(e.transactionIds[0])) {
    pendingProof[account] = undefined;
    steps.push({ account, kind: "action", at, operation: e.operation, amount: e.amount, assetId: e.assetId, recipient: e.recipient, nonce: e.nonce, round: e.confirmedRound, transactionIds: e.transactionIds, feeMicroAlgos: e.groupFeeMicroAlgos, confirmationMs: e.confirmationMs, afterRestore: restored.has(account) });
  } else if (e.kind === "fund" || e.kind === "seed") {
    // Funding is once per wallet; later requests return the wallet unchanged.
    if (!steps.some(s => s.account === account && s.kind === e.kind)) steps.push({ account, kind: e.kind, at });
  } else if (e.kind === "replay") {
    steps.push({ account, kind: "replay", at, rejectedByNode: e.replayRejectedByNode === true, noncePreserved: e.noncePreserved === true });
  } else if (e.kind === "isolation" && e.available !== false) {
    steps.push({ account, kind: "isolation", at, otherWalletId: e.otherWalletId, rejectedByNode: e.wrongOwnerRejectedByNode === true });
  }
}

const original = {
  source: "benchmarks/phase6-*.testnet.json, extracted by evidence/write-showcase-data.mjs",
  recordedAt: acceptance.recordedAt,
  status: acceptance.status,
  deployment: Object.fromEntries(["network", "genesisHash", "audienceHash", "verifier", "sponsor", "registryId", "keyRegistryId", "demoAssetId", "enrollmentDeposit"].map(k => [k, deployment[k]])),
  wallets: acceptance.wallets.map(w => Object.fromEntries(["accountCase", "walletId", "address", "ownerCommitment"].map(k => [k, w[k]]))),
  checks: acceptance.checks.map(c => Object.fromEntries(["check", "passed"].map(k => [k, c[k]]))),
  deferred: acceptance.deferred,
  steps,
};
write("recorded-run.json", original);
console.log(`recorded-run.json: ${steps.length} steps for ${original.wallets.length} wallets`);

// --- The service stack's run ---------------------------------------------------
// The checker confirms the node's genesis ID; its record names the network, and
// newer records may also carry the genesis hash itself.
const GENESIS_HASHES = { "testnet-v1.0": "SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9_cOUJOiI" };
const stack = json("benchmarks/service-stack.testnet.json");
const genesisHash = stack.genesisHash ?? GENESIS_HASHES[stack.network];
if (!genesisHash) throw new Error(`No genesis hash for network ${stack.network}`);
const REJECTION_KINDS = new Set(["replay", "isolation"]);

const apps = stack.apps.map(app => {
  if (!Object.hasOwn(PROVIDERS, app.provider)) throw new Error(`${app.app}: unknown provider ${app.provider}`);
  return {
    app: app.app,
    deployment: { provider: app.provider, ...pick(app, ["registryId", "keyRegistryId", "verifier", "audienceHash", "enrollmentDeposit", "sponsor"]) },
    wallets: app.wallets.map(w => pick(w, ["walletId", "address"])),
    actions: app.actions.map(a => ({
      ...pick(a, ["txId", "round", "roundTime", "walletId", "operation", "nonce", "recipient", "assetId", "amount"]),
      selfTransfer: a.selfTransfer === true,
      ...pick(a, ["groupFeeMicroAlgos", "passed"]),
    })),
    // Written by the checker from simulations against TestNet; absent in older records.
    rejections: (app.rejections ?? []).filter(r => REJECTION_KINDS.has(r.kind)).map(r => ({
      ...pick(r, ["kind", "sourceTxId", "walletId", "otherWalletId"]),
      simulated: r.simulated === true,
      ...pick(r, ["rejectedBy"]),
      passed: r.passed === true,
    })),
  };
});
const serviceStack = {
  source: "benchmarks/service-stack.testnet.json, extracted by evidence/write-showcase-data.mjs",
  recordedAt: stack.recordedAt,
  status: stack.status,
  network: stack.network,
  genesisHash,
  login: stack.login,
  prover: stack.prover,
  checks: stack.checks.map(c => pick(c, ["check", "passed"])),
  apps,
};
write("service-stack-run.json", serviceStack);
console.log(`service-stack-run.json: ${apps.length} apps, ${apps.reduce((n, a) => n + a.wallets.length, 0)} wallets, ${apps.reduce((n, a) => n + a.actions.length, 0)} actions, ${apps.reduce((n, a) => n + a.rejections.length, 0)} simulated rejections`);

// --- Providers -------------------------------------------------------------------
write("providers.json", Object.fromEntries(Object.values(PROVIDERS).map(p => [p.id, { label: p.label, verificationKey: `${p.circuit.directory}/verification_key.json` }])));
