import assert from "node:assert/strict";
import test from "node:test";
import { identityCommitment } from "../src/phase3/identity-commitment.mjs";

const base = {
  issuer: "https://accounts.google.com",
  audience: "poc.apps.googleusercontent.com",
  subject: "1234567890",
  salt: Buffer.alloc(32, 7),
};

test("identity commitment has an injective two-limb public encoding", () => {
  const { digest, high128, low128 } = identityCommitment(base);
  assert.equal(digest.length, 32);
  assert.equal(
    digest.toString("hex"),
    high128.toString(16).padStart(32, "0") + low128.toString(16).padStart(32, "0"),
  );
  assert.deepEqual(identityCommitment({ ...base, issuer: "accounts.google.com" }).digest, digest);
});

test("subject, audience, and original salt each determine the wallet", () => {
  const original = identityCommitment(base).digest.toString("hex");
  for (const change of [
    { subject: "1234567891" },
    { audience: "other.apps.googleusercontent.com" },
    { salt: Buffer.alloc(32, 8) },
  ]) {
    assert.notEqual(identityCommitment({ ...base, ...change }).digest.toString("hex"), original);
  }
});

test("invalid issuer, ambiguous claim text, and salt length are rejected", () => {
  assert.throws(() => identityCommitment({ ...base, issuer: "https://evil.example" }), /issuer/);
  assert.throws(() => identityCommitment({ ...base, subject: "a b" }), /Subject/);
  assert.throws(() => identityCommitment({ ...base, salt: Buffer.alloc(31) }), /salt/);
});
