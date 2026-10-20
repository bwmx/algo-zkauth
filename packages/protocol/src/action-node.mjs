import { createHash } from "node:crypto";

export const ACTION_DOMAIN = Buffer.from("algorand-zklogin-action-v1\0", "ascii");
const fixed = (value, length) => {
  const data = Buffer.from(value);
  if (data.length !== length) throw new Error(`Expected ${length} bytes`);
  return data;
};
const u64 = (value) => {
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw new Error("Use bigint for uint64 values above the safe integer range");
  const integer = BigInt(value);
  if (integer < 0n || integer > 0xffff_ffff_ffff_ffffn)
    throw new Error("Action value outside uint64 range");
  const data = Buffer.alloc(8);
  data.writeBigUInt64BE(integer);
  return data;
};

/** Ed25519 signs SHA-256 of this fixed-width, domain-separated preimage. */
export function encodeAction({
  genesisHash, registryId, walletId, owner, operation, recipient,
  assetId, amount, nonce, sessionExpiresAt,
}) {
  return Buffer.concat([
    ACTION_DOMAIN, fixed(genesisHash, 32), u64(registryId), u64(walletId),
    fixed(owner, 32), u64(operation), fixed(recipient, 32), u64(assetId),
    u64(amount), u64(nonce), u64(sessionExpiresAt),
  ]);
}

export const actionDigest = (action) => createHash("sha256").update(encodeAction(action)).digest();

export function signalDigest(signals, offset) {
  return Buffer.concat(signals.slice(offset, offset + 2).map((value) => {
    const limb = BigInt(value);
    if (limb < 0n || limb >= 1n << 128n) throw new Error("Noncanonical digest limb");
    return Buffer.from(limb.toString(16).padStart(32, "0"), "hex");
  }));
}
