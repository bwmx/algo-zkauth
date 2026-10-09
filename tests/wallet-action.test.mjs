import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { actionDigest, encodeAction, signalDigest } from "../src/phase4/action.mjs";

const action = {
  genesisHash: Buffer.alloc(32, 0x11), registryId: 0x0102030405060708n,
  walletId: 0x1112131415161718n, owner: Buffer.alloc(32, 0x22),
  operation: 3n, recipient: Buffer.alloc(32, 0x33),
  assetId: 0x2122232425262728n, amount: 0xffff_ffff_ffff_ffffn,
  nonce: 0x3132333435363738n, sessionExpiresAt: 0x4142434445464748n,
};

test("canonical action matches the fixed-width protocol vector", () => {
  const expected = "616c676f72616e642d7a6b6c6f67696e2d616374696f6e2d763100"
    + "11".repeat(32) + "0102030405060708" + "1112131415161718"
    + "22".repeat(32) + "0000000000000003" + "33".repeat(32)
    + "2122232425262728" + "ffffffffffffffff" + "3132333435363738" + "4142434445464748";
  assert.equal(encodeAction(action).toString("hex"), expected);
  assert.equal(encodeAction(action).length, 179);
  assert.deepEqual(actionDigest(action), createHash("sha256").update(Buffer.from(expected, "hex")).digest());
});

test("encoder rejects lossy or out-of-range action values", () => {
  for (const amount of [-1n, 1n << 64n, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => encodeAction({ ...action, amount }));
  for (const field of ["genesisHash", "owner", "recipient"])
    assert.throws(() => encodeAction({ ...action, [field]: Buffer.alloc(31) }));
  assert.throws(() => signalDigest([1n << 128n, 0n], 0), /Noncanonical/);
  assert.throws(() => signalDigest([-1n, 0n], 0), /Noncanonical/);
});
