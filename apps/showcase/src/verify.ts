// Re-verifies a recorded TestNet authorization in the browser from public data
// only: the transaction from the indexer, the provider's committed verification
// key and the app's deployment record. This repeats the acceptance checkers'
// per-action checks (evidence/check-demo.mjs, evidence/check-service-stack.mjs)
// without any server of ours.
import { ABIMethod, decodeAddress, type ABIType } from "algosdk";
import { actionDigest, fromBase64Url, toBase64Url, type ActionPlan, type Operation } from "@algozkauth/protocol";
import providers from "./data/providers.json";
import { decodeSignals, hex, type DecodedSignals } from "./format";

// The public AlgoNode TestNet indexer; transactions and wallet state are public chain data.
export const INDEXER = "https://testnet-idx.algonode.cloud";

// Each provider's committed verification key (providers.json names its path,
// from packages/protocol/src/oidc-providers.mjs), loaded only when needed.
export const VERIFICATION_KEYS: Record<string, () => Promise<unknown>> = {
  "fixtures/phase3/verification_key.json": async () => (await import("../../../fixtures/phase3/verification_key.json")).default,
  "fixtures/slack/verification_key.json": async () => (await import("../../../fixtures/slack/verification_key.json")).default,
};
export type Provider = { label: string; verificationKey: string };
export function providerOf(id: string): Provider {
  const provider = (providers as Record<string, Provider>)[id];
  if (!provider) throw new Error(`Unknown login provider ${id}`);
  return provider;
}
export async function loadVerificationKey(providerId: string): Promise<unknown> {
  const provider = providerOf(providerId);
  const load = VERIFICATION_KEYS[provider.verificationKey];
  if (!load) throw new Error(`No verification key bundled for ${provider.label}`);
  return load();
}

const EXECUTE = ABIMethod.fromSignature("execute(uint256[],(byte[64],byte[128],byte[64]),uint64,address,uint64,uint64,uint64,byte[64])void");
const ENROLL = ABIMethod.fromSignature("enroll(uint256[],(byte[64],byte[128],byte[64]),address,byte[64])uint64");

export type IndexerAppCall = {
  id: string;
  sender: string;
  "confirmed-round": number;
  "round-time": number;
  "application-transaction": { "application-id": number; "application-args": string[] };
};
/** The app deployment a proof-carrying call belongs to; each provider and app has its own. */
export type Deployment = { provider: string; genesisHash: string; audienceHash: string; verifier: string; registryId: string; enrollmentDeposit: string };
export type SnarkProof = { protocol: "groth16"; curve: "bn128"; pi_a: string[]; pi_b: string[][]; pi_c: string[] };
export type Authorization = {
  txId: string;
  round: number;
  time: number;
  sender: string;
  method: "enroll" | "execute";
  publicSignals: string[];
  signals: DecodedSignals;
  proof: SnarkProof;
  plan: ActionPlan;
  signature: Uint8Array<ArrayBuffer>;
};
export type Check = { label: string; ok: boolean; detail: string };
export type Groth16Verify = (vk: unknown, publicSignals: string[], proof: SnarkProof) => Promise<boolean>;

const base64 = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const bytes = (value: unknown) => Uint8Array.from(value as ArrayLike<number>);
const decimal = (b: Uint8Array) => BigInt(`0x${hex(b)}`).toString();

export async function fetchTransaction(txId: string): Promise<IndexerAppCall> {
  const response = await fetch(`${INDEXER}/v2/transactions/${txId}`);
  if (!response.ok) throw new Error(`TestNet indexer returned HTTP ${response.status}`);
  return (await response.json()).transaction;
}

/** The wallet's immutable owner commitment, read from its on-chain global state. */
export async function fetchWalletOwner(walletId: string): Promise<string> {
  const response = await fetch(`${INDEXER}/v2/applications/${walletId}`);
  if (!response.ok) throw new Error(`TestNet indexer returned HTTP ${response.status}`);
  const state: { key: string; value: { bytes: string } }[] = (await response.json()).application.params["global-state"];
  const owner = state.find(s => s.key === btoa("owner"));
  if (!owner) throw new Error("Wallet has no owner in its global state");
  return toBase64Url(base64(owner.value.bytes));
}

/** Decodes a proof-carrying enroll or execute call into its proof, signals and signed action. */
export function decodeAuthorization(txn: IndexerAppCall, deployment: Deployment): Authorization {
  const call = txn["application-transaction"];
  const raw = (call?.["application-args"] ?? []).map(base64);
  const method = [EXECUTE, ENROLL].find(m => raw[0] && same(m.getSelector(), raw[0]));
  if (!method) throw new Error("Not a wallet enrollment or execution call");
  const args = method.args.map((arg, i) => (arg.type as ABIType).decode(raw[i + 1]));
  const publicSignals = (args[0] as bigint[]).map(v => BigInt(v).toString());
  const signals = decodeSignals(publicSignals);
  // The verifier takes G2 coordinates as x0, x1, y0, y1; snarkjs uses the same pairs.
  const [a, b, c] = (args[1] as unknown[]).map(bytes);
  const proof: SnarkProof = {
    protocol: "groth16",
    curve: "bn128",
    pi_a: [decimal(a.subarray(0, 32)), decimal(a.subarray(32)), "1"],
    pi_b: [[decimal(b.subarray(0, 32)), decimal(b.subarray(32, 64))], [decimal(b.subarray(64, 96)), decimal(b.subarray(96))], ["1", "0"]],
    pi_c: [decimal(c.subarray(0, 32)), decimal(c.subarray(32)), "1"],
  };
  const enroll = method.name === "enroll";
  const recipient = String(args[enroll ? 2 : 3]);
  const plan: ActionPlan = {
    planId: txn.id,
    version: 1,
    genesisHash: signals.genesisHash,
    registryId: deployment.registryId,
    walletId: enroll ? "0" : String(call["application-id"]),
    owner: signals.commitment,
    operation: (enroll ? "0" : String(args[2])) as Operation,
    recipient,
    recipientPublicKey: toBase64Url(decodeAddress(recipient).publicKey),
    assetId: enroll ? "0" : String(args[4]),
    amount: enroll ? deployment.enrollmentDeposit : String(args[5]),
    nonce: enroll ? "0" : String(args[6]),
    sessionExpiresAt: String(signals.expiresAt),
  };
  return {
    txId: txn.id, round: txn["confirmed-round"], time: txn["round-time"], sender: txn.sender,
    method: enroll ? "enroll" : "execute", publicSignals, signals, proof, plan, signature: bytes(args[enroll ? 3 : 7]),
  };
}

const snarkjsVerify: Groth16Verify = async (vk, publicSignals, proof) => (await import("snarkjs")).groth16.verify(vk, publicSignals, proof);

/** Runs every check independently; one failure does not hide the others. */
export async function verifyAuthorization(auth: Authorization, deployment: Deployment, owner: string, groth16: Groth16Verify = snarkjsVerify): Promise<Check[]> {
  const s = auth.signals;
  const provider = providerOf(deployment.provider);
  // A missing key is an error in this page, not a failed proof.
  const verificationKey = await loadVerificationKey(deployment.provider);
  const attempt = async (run: () => Promise<boolean>) => { try { return await run(); } catch { return false; } };
  const proofOk = await attempt(() => groth16(verificationKey, auth.publicSignals, auth.proof));
  const signatureOk = await attempt(async () => {
    const key = await crypto.subtle.importKey("raw", fromBase64Url(s.sessionKey, 32), { name: "Ed25519" }, false, ["verify"]);
    return crypto.subtle.verify("Ed25519", key, auth.signature, await actionDigest(auth.plan));
  });
  return [
    { label: "Signed by the verifier LogicSig", ok: auth.sender === deployment.verifier, detail: "The proof-carrying call comes from the deployment's pinned Groth16 verifier account" },
    { label: "Zero-knowledge proof is valid", ok: proofOk, detail: `Groth16 verification against ${provider.label}'s published verification key, run in this browser` },
    { label: "Bound to Algorand TestNet", ok: s.genesisHash === deployment.genesisHash, detail: "The proof's genesis hash is TestNet's, so it cannot be replayed on another network" },
    { label: `Bound to this app's ${provider.label} client`, ok: s.audienceHash === deployment.audienceHash, detail: "The proof's audience hash matches the deployment's OAuth client ID" },
    { label: "Owner is this wallet's identity commitment", ok: s.commitment === owner, detail: "The proven commitment equals the owner stored in the wallet on-chain" },
    { label: "Session key signed exactly this action", ok: signatureOk, detail: "Ed25519 signature over the recomputed digest of network, wallet, operation, recipient, amount, nonce and expiry" },
    { label: "Used within its session", ok: s.notBefore <= auth.time && auth.time < s.expiresAt, detail: `Confirmed at ${new Date(auth.time * 1000).toLocaleTimeString()}, inside the session window ending ${new Date(s.expiresAt * 1000).toLocaleTimeString()}` },
  ];
}
