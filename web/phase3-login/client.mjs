const DOMAIN = new TextEncoder().encode("algorand-zklogin-session-v1\0");

export function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error("Invalid Base64url text");
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function browserSessionNonce(
  { genesisHash, sessionPublicKey, expiresAt, randomness },
  webCrypto = globalThis.crypto,
) {
  for (const [name, bytes] of [
    ["genesis hash", genesisHash],
    ["session public key", sessionPublicKey],
    ["randomness", randomness],
  ]) {
    if (!(bytes instanceof Uint8Array) || bytes.length !== 32)
      throw new Error(`${name} must be 32 bytes`);
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 0)
    throw new Error("Invalid session expiry");
  const expiry = new Uint8Array(8);
  new DataView(expiry.buffer).setBigUint64(0, BigInt(expiresAt), false);
  const input = new Uint8Array(DOMAIN.length + 32 + 32 + 8 + 32);
  let offset = 0;
  for (const bytes of [
    DOMAIN,
    genesisHash,
    sessionPublicKey,
    expiry,
    randomness,
  ]) {
    input.set(bytes, offset);
    offset += bytes.length;
  }
  return encodeBase64Url(
    new Uint8Array(await webCrypto.subtle.digest("SHA-256", input)),
  );
}
