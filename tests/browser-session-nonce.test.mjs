import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import { browserSessionNonce, decodeBase64Url, encodeBase64Url } from "../web/phase3-login/client.mjs";
import { sessionNonce } from "../src/phase3/session-nonce.mjs";

test("browser and Node derive the same nonce from identical bytes", async () => {
  const values = {
    genesisHash: new Uint8Array(32).fill(1),
    sessionPublicKey: new Uint8Array(32).fill(2),
    expiresAt: 1_800_000_000,
    randomness: new Uint8Array(32).fill(3),
  };
  const browser = await browserSessionNonce(values, webcrypto);
  assert.equal(browser, sessionNonce(values));
  assert.deepEqual(decodeBase64Url(encodeBase64Url(values.genesisHash)), values.genesisHash);
});
