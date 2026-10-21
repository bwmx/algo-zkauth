import assert from "node:assert/strict";
import test from "node:test";
import { sessionNonce } from "../src/phase3/session-nonce.mjs";

const base = {
  genesisHash: Buffer.alloc(32, 1),
  sessionPublicKey: Buffer.alloc(32, 2),
  expiresAt: 1_800_000_000,
  randomness: Buffer.alloc(32, 3),
};

test("nonce is stable, URL-safe, and bound to all session fields", () => {
  const expected = sessionNonce(base);
  assert.match(expected, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(sessionNonce(base), expected);
  for (const change of [
    { genesisHash: Buffer.alloc(32, 4) },
    { sessionPublicKey: Buffer.alloc(32, 4) },
    { expiresAt: base.expiresAt + 1 },
    { randomness: Buffer.alloc(32, 4) },
  ]) {
    assert.notEqual(sessionNonce({ ...base, ...change }), expected);
  }
});

test("nonce rejects malformed field widths and expiry", () => {
  assert.throws(() => sessionNonce({ ...base, genesisHash: Buffer.alloc(31) }), /32 bytes/);
  assert.throws(() => sessionNonce({ ...base, expiresAt: -1 }), /expiry/);
});
