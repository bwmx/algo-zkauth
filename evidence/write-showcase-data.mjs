// Extracts the public facts that the GitHub Pages showcase replays from the
// recorded Google TestNet run: deployment IDs, wallets, and the ordered steps
// with their transaction IDs. User agents and identity tags are left out.
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url).pathname;
const json = path => JSON.parse(readFileSync(`${root}${path}`, "utf8"));
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

const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k]]));
const data = {
  source: "benchmarks/phase6-*.testnet.json, extracted by scripts/write-showcase-data.mjs",
  recordedAt: acceptance.recordedAt,
  status: acceptance.status,
  deployment: pick(deployment, ["network", "genesisHash", "audienceHash", "verifier", "sponsor", "registryId", "keyRegistryId", "demoAssetId", "enrollmentDeposit"]),
  wallets: acceptance.wallets.map(w => pick(w, ["accountCase", "walletId", "address", "ownerCommitment"])),
  checks: acceptance.checks.map(c => pick(c, ["check", "passed"])),
  deferred: acceptance.deferred,
  steps,
};
writeFileSync(`${root}web/app/src/site/recorded-run.json`, JSON.stringify(data, null, 1) + "\n");
console.log(`wrote ${steps.length} steps for ${data.wallets.length} wallets`);
