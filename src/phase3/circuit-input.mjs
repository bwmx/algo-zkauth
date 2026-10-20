import { createHash } from "node:crypto";
import { parseUniqueJson, verifyIdToken } from "./id-token.mjs";
import { identityCommitment } from "./identity-commitment.mjs";
import { sessionNonce } from "./session-nonce.mjs";
import { circuitProfile, rawJsonText } from "./circuit-profile.mjs";

const bytes = (text) => Buffer.from(text, "ascii");
const pad = (data, capacity) => {
  if (data.length > capacity)
    throw new Error("Token exceeds the circuit byte capacity");
  return [...data, ...Array(capacity - data.length).fill(0)];
};
const limbs = (data) => {
  if (data.length !== 32) throw new Error("Expected a 32-byte public value");
  return [data.subarray(0, 16), data.subarray(16)].map((part) =>
    BigInt(`0x${part.toString("hex")}`).toString(),
  );
};
const rsaLimbs = (data) => {
  let value = BigInt(`0x${data.toString("hex")}`);
  const mask = (1n << 121n) - 1n;
  return Array.from({ length: 17 }, () => {
    const limb = (value & mask).toString();
    value >>= 121n;
    return limb;
  });
};
const lengthPrefixed = (data) => {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(data.length);
  return Buffer.concat([length, data]);
};

export function flatJsonHints(data, keys, kinds, escapedSlashes = false) {
  const raw = (value) => rawJsonText(value, escapedSlashes);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  const object = parseUniqueJson(text);
  if (!object || typeof object !== "object" || Array.isArray(object))
    throw new Error("Circuit JSON must be a flat object");
  const entries = Object.entries(object);
  if (
    entries.length === 0 ||
    entries.length > keys.length ||
    raw(JSON.stringify(object)) !== text
  ) {
    throw new Error("Circuit requires compact canonical flat JSON");
  }
  const keyLengths = [];
  const valueLengths = [];
  for (const [key, value] of entries) {
    const index = keys.indexOf(key);
    if (index < 0)
      throw new Error(
        "Token contains a claim outside the supported circuit profile",
      );
    const kind = kinds[index];
    // Kind 0 must be unescaped in its signed spelling; kind 3 may contain
    // only the "\/" escape. Both are printable ASCII up to 255 signed bytes.
    if (
      (kind === 0 || kind === 3) &&
      (typeof value !== "string" ||
        !/^[\x20-\x21\x23-\x5b\x5d-\x7e]*$/.test(kind === 3 ? value : raw(value)) ||
        raw(value).length > 255)
    ) {
      throw new Error(
        "Circuit strings must be unescaped printable ASCII, at most 255 bytes",
      );
    }
    if (
      kind === 1 &&
      (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff)
    )
      throw new Error("Circuit times must be uint32 integers");
    if (kind === 2 && typeof value !== "boolean")
      throw new Error("Circuit boolean has the wrong type");
    keyLengths.push(raw(key).length);
    valueLengths.push(
      kind === 0 || kind === 3 ? raw(value).length : String(value).length,
    );
  }
  while (keyLengths.length < keys.length) {
    keyLengths.push(0);
    valueLengths.push(0);
  }
  return { object, fieldCount: entries.length, keyLengths, valueLengths };
}

export function oidcCircuitInput({
  provider,
  token,
  jwks,
  audience,
  nonce,
  genesisHash,
  sessionPublicKey,
  expiresAt,
  randomness,
  salt,
  nowSeconds,
}) {
  const profile = circuitProfile(provider);
  const verified = verifyIdToken(token, {
    provider,
    audience,
    nonce,
    jwks,
    nowSeconds,
  });
  if (
    sessionNonce({ genesisHash, sessionPublicKey, expiresAt, randomness }) !==
    nonce
  )
    throw new Error("Missing or inconsistent session witness context");
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= verified.issuedAt ||
    expiresAt > verified.issuedAt + 600 ||
    (provider.sessionWithinTokenExpiry && expiresAt > verified.expiresAt)
  )
    throw new Error("Circuit session is outside the signed token window");
  const segments = token.split(".");
  const header = flatJsonHints(
    Buffer.from(segments[0], "base64url"),
    profile.headerKeys,
    [0, 0, 0],
    profile.escapedSlashes,
  );
  const payload = flatJsonHints(
    Buffer.from(segments[1], "base64url"),
    profile.payloadKeys,
    profile.payloadKinds,
    profile.escapedSlashes,
  );
  const typ = profile.requireTyp ? header.object.typ : header.object.typ ?? "JWT";
  if (typ !== "JWT" || header.object.kid.length > 64)
    throw new Error("Header is outside the circuit profile");
  const message = bytes(`${segments[0]}.${segments[1]}`);
  if (
    message.length > 1015 ||
    segments[0].length > 128 ||
    segments[1].length > 896
  )
    throw new Error("Token exceeds the circuit byte capacity");
  const approvedKey = jwks.keys.find((key) => key.kid === verified.keyId);
  const modulus = Buffer.from(approvedKey.n, "base64url");
  const saltBytes = Buffer.from(salt);
  const commitment = identityCommitment({
    issuer: verified.issuer,
    audience,
    subject: verified.subject,
    salt: saltBytes,
  });
  const identityPreimage = Buffer.concat([
    bytes("algorand-zklogin-identity-v1\0"),
    lengthPrefixed(bytes(provider.issuer)),
    lengthPrefixed(bytes(audience)),
    lengthPrefixed(bytes(verified.subject)),
    saltBytes,
  ]);
  const identityCapacity =
    bytes("algorand-zklogin-identity-v1\0").length +
    2 +
    provider.issuer.length +
    2 +
    255 +
    2 +
    255 +
    32;
  const notBefore = Math.max(verified.issuedAt - 60, payload.object.nbf ?? 0);
  if (notBefore >= expiresAt)
    throw new Error("Session has no valid execution window");
  const digest = (data) => createHash("sha256").update(data).digest();
  return {
    identity: limbs(commitment.digest),
    keyHash: limbs(digest(modulus)),
    audienceHash: limbs(digest(bytes(audience))),
    sessionKey: limbs(Buffer.from(sessionPublicKey)),
    genesisHash: limbs(Buffer.from(genesisHash)),
    sessionExpiresAt: expiresAt,
    notBefore,
    message: pad(message, 1024),
    messageLength: message.length,
    headerLength: segments[0].length,
    modulus: rsaLimbs(modulus),
    signature: rsaLimbs(Buffer.from(segments[2], "base64url")),
    headerFieldCount: header.fieldCount,
    headerKeyLengths: header.keyLengths,
    headerValueLengths: header.valueLengths,
    payloadFieldCount: payload.fieldCount,
    payloadKeyLengths: payload.keyLengths,
    payloadValueLengths: payload.valueLengths,
    salt: [...saltBytes],
    randomness: [...Buffer.from(randomness)],
    identityPreimage: pad(identityPreimage, identityCapacity),
  };
}
