import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { browserActionBytes, browserActionDigest, validateActionPlan } from "../src/phase6/action.mjs";
import { encodeAction, actionDigest } from "../src/phase4/action.mjs";
const b64 = v => Buffer.from(v).toString("base64url");
test("browser signs the exact established contract action bytes and digest", async () => {
  const a = { genesisHash: randomBytes(32), registryId: 123n, walletId: 456n, owner: randomBytes(32), operation: 1n, recipient: randomBytes(32), assetId: 0n, amount: 10000n, nonce: 3n, sessionExpiresAt: 1770000000n };
  const p = { ...Object.fromEntries(Object.entries(a).map(([k,v]) => [k, typeof v === "bigint" ? String(v) : b64(v)])), recipientPublicKey: b64(a.recipient) };
  assert.deepEqual(Buffer.from(browserActionBytes(p)), encodeAction(a));
  assert.deepEqual(Buffer.from(await browserActionDigest(p)), actionDigest(a));
});
test("server cannot replace any requested action field or advertise different recipient bytes", () => {
  const p = { genesisHash: b64(randomBytes(32)), registryId: "12", walletId: "34", owner: b64(randomBytes(32)), operation: "1", recipient: "validated-address", recipientPublicKey: b64(randomBytes(32)), assetId: "0", amount: "10000", nonce: "1", sessionExpiresAt: "1770000000" };
  const config = { genesisHash: p.genesisHash, registryId: p.registryId };
  const decode = () => ({ publicKey: Buffer.from(p.recipientPublicKey, "base64url") });
  validateActionPlan(p, p, config, decode);
  for (const k of ["genesisHash", "registryId", "walletId", "owner", "operation", "recipient", "assetId", "amount", "nonce", "sessionExpiresAt"]) assert.throws(() => validateActionPlan({ ...p, [k]: "changed" }, p, config, decode));
  assert.throws(() => validateActionPlan({ ...p, recipientPublicKey: b64(randomBytes(32)) }, p, config, decode));
  assert.throws(() => browserActionBytes({ ...p, nonce: "01" }));
});
