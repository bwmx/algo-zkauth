import { fromBase64Url } from "../phase5/recovery.mjs";
const enc = new TextEncoder();
const u64 = value => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > 0xffffffffffffffffn) throw new Error("Noncanonical action uint64");
  const out = new Uint8Array(8); new DataView(out.buffer).setBigUint64(0, BigInt(value)); return out;
};
export function browserActionBytes(action) {
  const parts = [enc.encode("algorand-zklogin-action-v1\0"), fromBase64Url(action.genesisHash, 32), u64(action.registryId), u64(action.walletId), fromBase64Url(action.owner, 32), u64(action.operation), fromBase64Url(action.recipientPublicKey, 32), u64(action.assetId), u64(action.amount), u64(action.nonce), u64(action.sessionExpiresAt)];
  const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0; for (const p of parts) { data.set(p, offset); offset += p.length; } return data;
}
export const browserActionDigest = async action => new Uint8Array(await crypto.subtle.digest("SHA-256", browserActionBytes(action)));

// A returned server plan must describe exactly the operation the user requested.
export function validateActionPlan(plan, expected, config, decodeAddress) {
  for (const field of ["walletId", "operation", "recipient", "assetId", "amount", "nonce", "owner", "sessionExpiresAt"]) {
    if (plan[field] !== expected[field]) throw new Error(`Action plan changed ${field}`);
  }
  if (plan.genesisHash !== config.genesisHash || plan.registryId !== config.registryId) throw new Error("Action plan changed network or registry");
  const decoded = decodeAddress(plan.recipient).publicKey;
  const advertised = fromBase64Url(plan.recipientPublicKey, 32);
  if (decoded.length !== advertised.length || !decoded.every((v, i) => v === advertised[i])) throw new Error("Action plan changed recipient bytes");
  browserActionBytes(plan); return plan;
}
