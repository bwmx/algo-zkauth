import { test } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { identityCommitment } from "../src/phase3/identity-commitment.mjs";
import { generateWalletSalt, generateRecoverySecret, createRecoveryPackage, restoreRecoveryPackage, parsePackage, serializePackage, recoveryCommitment, resealRecoveryPackage, toBase64Url as b64 } from "../src/phase5/recovery.mjs";
const id = { issuer: "https://accounts.google.com", audience: "test.apps.googleusercontent.com", subject: "123456789012345678901" };
const binding = { stage: "wallet", networkGenesisHash: b64(new Uint8Array(32).fill(2)), registryAppId: "123", walletAppId: "456", walletAddress: "A".repeat(58) };
const prf = { rpId: "localhost", credentialId: b64(randomBytes(32)), prfInput: b64(randomBytes(32)), output: randomBytes(32) };
async function fixture() {
  const salt = generateWalletSalt();
  const recoverySecret = await generateRecoverySecret();
  const packageText = await createRecoveryPackage({ salt, identity: id, binding, recoverySecret, passkeys: [prf] });
  return { salt, recoverySecret, packageText, identity: id, expectedBinding: binding };
}
function tamper(text, change) { const p = JSON.parse(text); change(p); return serializePackage(p); }
const flip = (s) => { const v = Buffer.from(s, "base64url"); v[0] ^= 1; return v.toString("base64url"); };
test("browser commitment matches the existing circuit identity format and salt survives both unlock paths", async () => {
  const f = await fixture();
  assert.equal(b64(await recoveryCommitment(id, f.salt)), identityCommitment({ ...id, salt: f.salt }).digest.toString("base64url"));
  for (const extra of [{}, { passkey: prf, recoverySecret: undefined }]) {
    const restored = await restoreRecoveryPackage({ ...f, ...extra });
    assert.deepEqual(restored.salt, f.salt);
    assert.equal(b64(restored.commitment), JSON.parse(f.packageText).header.commitment);
  }
  assert.equal(f.packageText.includes(id.subject), false);
  assert.equal(f.packageText.includes(b64(f.salt)), false);
  assert.equal(f.packageText.includes(f.recoverySecret), false);
});
test("independent Node crypto implementation can decrypt the envelope using HKDF and AES-GCM", async () => {
  const f = await fixture(); const p = parsePackage(f.packageText); const { wrappedKey, ...d } = p.slots[0];
  const raw = Buffer.from(f.recoverySecret.split(":")[1], "base64url");
  const info = Buffer.from(`algorand-zklogin-recovery-wrap-v1\0${p.header.packageId}\0${d.slotId}\0${d.kind}`);
  const kek = Buffer.from(hkdfSync("sha256", raw, Buffer.from(d.kdfSalt, "base64url"), info, 32));
  function decrypt(key, part, cipher, aad) {
    const data = Buffer.from(cipher, "base64url");
    const c = createDecipheriv("aes-256-gcm", key, Buffer.from(part.iv, "base64url"));
    c.setAAD(Buffer.from(JSON.stringify(aad))); c.setAuthTag(data.subarray(-16));
    return Buffer.concat([c.update(data.subarray(0, -16)), c.final()]);
  }
  const dek = decrypt(kek, d, wrappedKey, { header: p.header, descriptor: d });
  const body = JSON.parse(decrypt(dek, p.payload, p.payload.ciphertext, { header: p.header, slots: p.slots }));
  assert.equal(body.salt, b64(f.salt)); assert.equal(body.subject, id.subject);
  // An envelope made by someone holding the secret is still checked against
  // the derived commitment rather than accepting authenticated wrong plaintext.
  body.salt = b64(randomBytes(32));
  const c = createCipheriv("aes-256-gcm", dek, Buffer.from(p.payload.iv, "base64url"));
  c.setAAD(Buffer.from(JSON.stringify({ header: p.header, slots: p.slots })));
  p.payload.ciphertext = Buffer.concat([c.update(JSON.stringify(body)), c.final(), c.getAuthTag()]).toString("base64url");
  await assert.rejects(restoreRecoveryPackage({ ...f, packageText: serializePackage(p) }), /commitment/);
});
test("wrong secrets, malformed codes, other passkeys, and different Google identities fail", async () => {
  const f = await fixture();
  await assert.rejects(restoreRecoveryPackage({ ...f, recoverySecret: await generateRecoverySecret() }), /unlock failed/);
  await assert.rejects(restoreRecoveryPackage({ ...f, recoverySecret: "a memorable password" }), /generated ZKR1/);
  await assert.rejects(restoreRecoveryPackage({ ...f, recoverySecret: f.recoverySecret.slice(0, -1) + "!" }), /Invalid recovery secret/);
  await assert.rejects(restoreRecoveryPackage({ ...f, passkey: { ...prf, output: randomBytes(32) } }), /unlock failed/);
  await assert.rejects(restoreRecoveryPackage({ ...f, passkey: { ...prf, credentialId: b64(randomBytes(32)) } }), /not in this package/);
  await assert.rejects(restoreRecoveryPackage({ ...f, identity: { ...id, subject: "another-account" } }), /original Google/);
  await assert.rejects(restoreRecoveryPackage({ ...f, identity: { ...id, audience: "other.apps.googleusercontent.com" } }), /audience/);
});
test("every metadata field, payload, wrap, and passkey slot is authenticated", async () => {
  const f = await fixture();
  const mutations = [
    p => p.header.packageId = flip(p.header.packageId), p => p.header.createdAt = "2026-01-01T00:00:00.000Z",
    p => p.header.commitment = flip(p.header.commitment), p => p.header.audienceHash = flip(p.header.audienceHash),
    p => p.payload.iv = flip(p.payload.iv), p => p.payload.ciphertext = flip(p.payload.ciphertext),
    p => p.slots[0].slotId = flip(p.slots[0].slotId), p => p.slots[0].kdfSalt = flip(p.slots[0].kdfSalt),
    p => p.slots[0].iv = flip(p.slots[0].iv), p => p.slots[0].wrappedKey = flip(p.slots[0].wrappedKey),
    p => p.slots[1].wrappedKey = flip(p.slots[1].wrappedKey), p => p.slots[1].rpId = "example.com",
    p => p.slots[1].credentialId = flip(p.slots[1].credentialId), p => p.slots[1].prfInput = flip(p.slots[1].prfInput),
    p => p.slots.pop(),
  ];
  for (const mutate of mutations) await assert.rejects(restoreRecoveryPackage({ ...f, packageText: tamper(f.packageText, mutate) }));
  for (const [name, value] of [["networkGenesisHash", b64(randomBytes(32))], ["registryAppId", "124"], ["walletAppId", "457"], ["walletAddress", "B".repeat(58)]]) {
    await assert.rejects(restoreRecoveryPackage({ ...f, expectedBinding: { ...binding, [name]: value } }), /different wallet or network/);
    await assert.rejects(restoreRecoveryPackage({ ...f, packageText: tamper(f.packageText, p => p.header.binding[name] = value) }), /different wallet or network/);
  }
});
test("ambiguous, oversized, unknown, duplicate and noncanonical packages are rejected", async () => {
  const f = await fixture(); const p = JSON.parse(f.packageText);
  for (const text of ["{", f.packageText.replace('"version":1', '"version":1,"version":1'), JSON.stringify(p, null, 2), f.packageText + " ", "x".repeat(16385), f.packageText.replace('"version":1', '"version":2')]) assert.throws(() => parsePackage(text));
  assert.deepEqual(parsePackage(f.packageText + "\n"), p);
  for (const change of [v => v.unknown = true, v => v.header.binding.walletAppId = "0456", v => v.header.binding.registryAppId = "18446744073709551616", v => v.header.createdAt = "2026-02-30T00:00:00.000Z", v => v.slots.push({ ...v.slots[1] }), v => v.slots = [], v => v.payload.iv += "=", v => v.header.cipher = "AES-CBC"]) {
    const copy = structuredClone(p); change(copy); assert.throws(() => parsePackage(JSON.stringify(copy)));
  }
});
test("resealing changes encryption material while retaining the original identity; pre-enrollment is explicit", async () => {
  const f = await fixture(); const newSecret = await generateRecoverySecret();
  const text = await resealRecoveryPackage({ restore: f, identity: id, binding, recoverySecret: newSecret });
  assert.notEqual(text, f.packageText);
  const restored = await restoreRecoveryPackage({ ...f, packageText: text, recoverySecret: newSecret });
  assert.deepEqual(restored.salt, f.salt);
  await assert.rejects(resealRecoveryPackage({ restore: f, identity: { ...id, subject: "different-account" }, binding, recoverySecret: newSecret }), /cannot change the original identity/);
  // Rotation does not revoke old offline backups.
  assert.deepEqual((await restoreRecoveryPackage(f)).salt, f.salt);
  const pending = { ...binding, stage: "pre-enrollment", registryAppId: "0", walletAppId: "0", walletAddress: null };
  const before = await createRecoveryPackage({ ...f, identity: id, binding: pending });
  await assert.rejects(restoreRecoveryPackage({ ...f, packageText: before }), /different wallet or network/);
  assert.deepEqual((await restoreRecoveryPackage({ ...f, packageText: before, expectedBinding: pending })).salt, f.salt);
});
