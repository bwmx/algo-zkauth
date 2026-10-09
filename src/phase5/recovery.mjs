// Shared Node/browser WebCrypto implementation. No storage, network, or logging.
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });
const FORMAT = "algorand-zklogin-recovery";
const SCHEME = "algorand-zklogin-identity-v1";
const ISSUER = "https://accounts.google.com";
export const MAX_PACKAGE_BYTES = 16_384;
/** @returns {never} */
const fail = (message = "Invalid recovery package") => { throw new Error(message); };
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
export const generateWalletSalt = () => random(32);
export function toBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function fromBase64Url(value, min, max = min) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > Math.ceil(max * 4 / 3)) fail();
  let data;
  try { data = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0)); }
  catch { fail(); }
  if (data.length < min || data.length > max || toBase64Url(data) !== value) fail();
  return data;
}
const bytes32 = (value) => {
  if (!(value instanceof Uint8Array) || value.length !== 32) fail("Expected 32 bytes");
  return value;
};
const sha = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
const concat = (...parts) => {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { result.set(p, offset); offset += p.length; }
  return result;
};
const ascii = (value) => {
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,255}$/.test(value)) fail("Invalid identity claim");
  return value;
};
const issuer = (value) => {
  if (![ISSUER, "accounts.google.com"].includes(value)) fail("Unsupported issuer");
  return ISSUER;
};
const identity = (value) => ({ issuer: issuer(value.issuer), audience: ascii(value.audience), subject: ascii(value.subject) });
export async function recoveryCommitment(value, salt) {
  const id = identity(value);
  const field = (v) => { const b = enc.encode(v); return concat(new Uint8Array([b.length >> 8, b.length & 255]), b); };
  return sha(concat(enc.encode(`${SCHEME}\0`), field(id.issuer), field(id.audience), field(id.subject), bytes32(salt)));
}
const checksum = async (raw) => toBase64Url((await sha(concat(enc.encode("algorand-zklogin-recovery-secret-v1\0"), raw))).slice(0, 4));
export async function generateRecoverySecret() {
  const raw = random(32);
  try { return `ZKR1:${toBase64Url(raw)}:${await checksum(raw)}`; }
  finally { raw.fill(0); }
}
async function decodeSecret(value) {
  if (typeof value !== "string" || !/^ZKR1:[A-Za-z0-9_-]{43}:[A-Za-z0-9_-]{6}$/.test(value)) fail("Invalid recovery secret; use the generated ZKR1 code");
  const [, data, check] = value.split(":");
  const raw = fromBase64Url(data, 32);
  if (await checksum(raw) !== check) { raw.fill(0); fail("Recovery secret checksum failed"); }
  return raw;
}
const u64 = (v) => {
  if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(v) || BigInt(v) > 0xffffffffffffffffn) fail();
  return v;
};
const exact = (v, fields) => {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join(",") !== [...fields].sort().join(",")) fail();
};
const b64 = (v, n, max = n) => { fromBase64Url(v, n, max); return v; };
function binding(v) {
  exact(v, ["stage", "networkGenesisHash", "registryAppId", "walletAppId", "walletAddress"]);
  const result = { stage: v.stage, networkGenesisHash: b64(v.networkGenesisHash, 32), registryAppId: u64(v.registryAppId), walletAppId: u64(v.walletAppId), walletAddress: v.walletAddress };
  if (v.stage === "pre-enrollment") {
    if (v.registryAppId !== "0" || v.walletAppId !== "0" || v.walletAddress !== null) fail();
  } else if (v.stage === "wallet") {
    if (v.registryAppId === "0" || v.walletAppId === "0" || typeof v.walletAddress !== "string" || !/^[A-Z2-7]{58}$/.test(v.walletAddress)) fail();
  } else fail();
  return result;
}
const descriptor = (slot) => {
  const base = { kind: slot.kind, slotId: b64(slot.slotId, 16), kdfSalt: b64(slot.kdfSalt, 32), iv: b64(slot.iv, 12) };
  if (slot.kind === "secret") return base;
  if (slot.kind !== "prf" || typeof slot.rpId !== "string" || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(slot.rpId)) fail();
  return { ...base, rpId: slot.rpId, credentialId: b64(slot.credentialId, 1, 1024), prfInput: b64(slot.prfInput, 32) };
};
function validate(v) {
  exact(v, ["format", "version", "header", "payload", "slots"]);
  if (v.format !== FORMAT || v.version !== 1) fail("Unsupported recovery format/version");
  const h = v.header;
  exact(h, ["packageId", "createdAt", "identityScheme", "audienceHash", "commitment", "binding", "cipher", "kdf"]);
  if (typeof h.createdAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(h.createdAt) || !Number.isFinite(Date.parse(h.createdAt)) || new Date(h.createdAt).toISOString() !== h.createdAt) fail();
  if (h.identityScheme !== SCHEME || h.cipher !== "AES-256-GCM" || h.kdf !== "HKDF-SHA-256") fail();
  const header = { packageId: b64(h.packageId, 16), createdAt: h.createdAt, identityScheme: SCHEME, audienceHash: b64(h.audienceHash, 32), commitment: b64(h.commitment, 32), binding: binding(h.binding), cipher: h.cipher, kdf: h.kdf };
  exact(v.payload, ["iv", "ciphertext"]);
  const payload = { iv: b64(v.payload.iv, 12), ciphertext: b64(v.payload.ciphertext, 17, 2048) };
  if (!Array.isArray(v.slots) || v.slots.length < 1 || v.slots.length > 5 || v.slots[0].kind !== "secret") fail();
  const slots = v.slots.map((s, i) => {
    if (s?.kind !== (i === 0 ? "secret" : "prf")) fail();
    exact(s, s.kind === "secret" ? ["kind", "slotId", "kdfSalt", "iv", "wrappedKey"] : ["kind", "slotId", "kdfSalt", "iv", "rpId", "credentialId", "prfInput", "wrappedKey"]);
    return { ...descriptor(s), wrappedKey: b64(s.wrappedKey, 48) };
  });
  if (new Set(slots.map(s => s.slotId)).size !== slots.length || new Set(slots.slice(1).map(s => s.credentialId)).size !== slots.length - 1) fail();
  return { format: FORMAT, version: 1, header, payload, slots };
}
export function serializePackage(value) {
  const text = JSON.stringify(validate(value));
  if (enc.encode(text).length > MAX_PACKAGE_BYTES) fail("Recovery package is too large");
  return text;
}
export function parsePackage(text) {
  if (typeof text !== "string" || enc.encode(text).length > MAX_PACKAGE_BYTES) fail("Recovery package is too large");
  const input = text.endsWith("\n") ? text.slice(0, -1) : text;
  let parsed;
  try { parsed = JSON.parse(input); } catch { fail(); }
  const value = validate(parsed);
  // Fixed field order rejects duplicates, unknown fields, escaped aliases and
  // alternative encodings. Import the exact exported file, not reformatted JSON.
  if (JSON.stringify(value) !== input) fail("Noncanonical recovery serialization");
  return value;
}
const aad = (v) => enc.encode(JSON.stringify(v));
const aesKey = (raw, usages) => crypto.subtle.importKey("raw", bytes32(raw), "AES-GCM", false, usages);
async function wrappingKey(raw, header, slot, usage) {
  const material = await crypto.subtle.importKey("raw", bytes32(raw), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: fromBase64Url(slot.kdfSalt, 32), info: enc.encode(`algorand-zklogin-recovery-wrap-v1\0${header.packageId}\0${slot.slotId}\0${slot.kind}`) }, material, { name: "AES-GCM", length: 256 }, false, [usage]);
}
const gcm = (slot, extra) => ({ name: "AES-GCM", iv: fromBase64Url(slot.iv, 12), additionalData: aad(extra), tagLength: 128 });

/** identity must come from a verified fresh login; binding must be trusted by the caller. */
export async function createRecoveryPackage({ salt, identity: idValue, binding: bind, recoverySecret, passkeys = [] }) {
  const id = identity(idValue);
  const header = { packageId: toBase64Url(random(16)), createdAt: new Date().toISOString(), identityScheme: SCHEME, audienceHash: toBase64Url(await sha(enc.encode(id.audience))), commitment: toBase64Url(await recoveryCommitment(id, salt)), binding: binding(bind), cipher: "AES-256-GCM", kdf: "HKDF-SHA-256" };
  const secret = await decodeSecret(recoverySecret);
  const dek = random(32);
  try {
    if (!Array.isArray(passkeys) || passkeys.length > 4) fail("Too many passkeys");
    const inputs = [{ kind: "secret", raw: secret }, ...passkeys.map(p => ({ kind: "prf", raw: bytes32(p.output), rpId: p.rpId, credentialId: p.credentialId, prfInput: p.prfInput }))];
    const slots = [];
    for (const p of inputs) {
      const d = descriptor({ kind: p.kind, slotId: toBase64Url(random(16)), kdfSalt: toBase64Url(random(32)), iv: toBase64Url(random(12)), ...(p.kind === "prf" ? { rpId: p.rpId, credentialId: p.credentialId, prfInput: p.prfInput } : {}) });
      const key = await wrappingKey(p.raw, header, d, "encrypt");
      const wrappedKey = toBase64Url(new Uint8Array(await crypto.subtle.encrypt(gcm(d, { header, descriptor: d }), key, dek)));
      slots.push({ ...d, wrappedKey });
    }
    const payload = { iv: toBase64Url(random(12)) };
    const plain = aad({ salt: toBase64Url(bytes32(salt)), ...id });
    try { payload.ciphertext = toBase64Url(new Uint8Array(await crypto.subtle.encrypt(gcm(payload, { header, slots }), await aesKey(dek, ["encrypt"]), plain))); }
    finally { plain.fill(0); }
    return serializePackage({ format: FORMAT, version: 1, header, payload, slots });
  } finally { secret.fill(0); dek.fill(0); }
}

/** Never obtain expectedBinding from the unverified package alone. Check the
 * derived Algorand address and registry/owner/policy against chain after unlock.
 * @param {{packageText: string, recoverySecret?: string, passkey?: {rpId: string, credentialId: string, output: Uint8Array}, identity: {issuer: string, audience: string, subject: string}, expectedBinding: {stage: string, networkGenesisHash: string, registryAppId: string, walletAppId: string, walletAddress: string|null}}} options
 */
export async function restoreRecoveryPackage({ packageText, recoverySecret = undefined, passkey = undefined, identity: idValue, expectedBinding }) {
  const value = parsePackage(packageText);
  const expected = binding(expectedBinding);
  if (JSON.stringify(expected) !== JSON.stringify(value.header.binding)) fail("Recovery package belongs to a different wallet or network");
  const id = identity(idValue);
  if (toBase64Url(await sha(enc.encode(id.audience))) !== value.header.audienceHash) fail("Recovery package belongs to a different login audience");
  let raw;
  let dek;
  let plain;
  try {
    let slot;
    if (passkey) {
      slot = value.slots.find(s => s.kind === "prf" && s.credentialId === passkey.credentialId && s.rpId === passkey.rpId);
      if (!slot) fail("Passkey is not in this package; use the recovery secret");
      raw = new Uint8Array(bytes32(passkey.output));
    } else { slot = value.slots[0]; raw = await decodeSecret(recoverySecret); }
    const key = await wrappingKey(raw, value.header, slot, "decrypt");
    dek = new Uint8Array(await crypto.subtle.decrypt(gcm(slot, { header: value.header, descriptor: descriptor(slot) }), key, fromBase64Url(slot.wrappedKey, 48)));
    plain = new Uint8Array(await crypto.subtle.decrypt(gcm(value.payload, { header: value.header, slots: value.slots }), await aesKey(dek, ["decrypt"]), fromBase64Url(value.payload.ciphertext, 17, 2048)));
    const body = JSON.parse(dec.decode(plain));
    exact(body, ["salt", "issuer", "audience", "subject"]);
    const salt = fromBase64Url(body.salt, 32);
    const storedId = identity(body);
    if (dec.decode(plain) !== JSON.stringify({ salt: body.salt, ...storedId })) fail("Invalid encrypted identity serialization");
    if (JSON.stringify(storedId) !== JSON.stringify(id)) fail("Sign in to the original Google identity to restore");
    const commitment = await recoveryCommitment(id, salt);
    if (toBase64Url(commitment) !== value.header.commitment) fail("Restored identity commitment does not match");
    return { salt, commitment, binding: expected, packageId: value.header.packageId };
  } catch (error) {
    if (error?.name === "OperationError") fail("Recovery unlock failed: wrong secret/passkey or damaged package");
    throw error;
  } finally { raw?.fill(0); dek?.fill(0); plain?.fill(0); }
}

/** Explicit resealing for new passkeys or post-enrollment binding. Old copies
 * remain usable: offline ciphertext cannot revoke a previously exported key. */
export async function resealRecoveryPackage({ restore, identity: id, binding: bind, recoverySecret, passkeys = [] }) {
  const recovered = await restoreRecoveryPackage(restore);
  try {
    if (JSON.stringify(identity(id)) !== JSON.stringify(identity(restore.identity))) fail("Resealing cannot change the original identity");
    return await createRecoveryPackage({ salt: recovered.salt, identity: id, binding: bind, recoverySecret, passkeys });
  }
  finally { recovered.salt.fill(0); }
}
