import { createHash, randomBytes } from "node:crypto";

const DOMAIN = Buffer.from("algorand-zklogin-session-v1\0", "ascii");

function bytes32(value, name) {
  const bytes = Buffer.from(value);
  if (bytes.length !== 32) throw new Error(`${name} must be 32 bytes`);
  return bytes;
}

export function sessionNonce({
  genesisHash,
  sessionPublicKey,
  expiresAt,
  randomness = randomBytes(32),
}) {
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) {
    throw new Error("Session expiry must be a nonnegative Unix timestamp");
  }
  const expiry = Buffer.alloc(8);
  expiry.writeBigUInt64BE(BigInt(expiresAt));
  return createHash("sha256")
    .update(DOMAIN)
    .update(bytes32(genesisHash, "Genesis hash"))
    .update(bytes32(sessionPublicKey, "Session public key"))
    .update(expiry)
    .update(bytes32(randomness, "Session randomness"))
    .digest("base64url");
}
