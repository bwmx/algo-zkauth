import { test } from "node:test";
import assert from "node:assert/strict";
import { enrollPasskey, unlockPasskey, PrfUnavailableError } from "../src/phase5/passkey-prf.mjs";
import { toBase64Url as b64 } from "../src/phase5/recovery.mjs";
const id = new Uint8Array(32).fill(7);
const slot = { kind: "prf", rpId: "localhost", credentialId: b64(id), prfInput: b64(new Uint8Array(32).fill(8)) };
async function environment(options = {}) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("localhost")));
  const response = (p, type) => ({
    type: "public-key", rawId: id.buffer,
    response: { clientDataJSON: new TextEncoder().encode(JSON.stringify({ type, challenge: b64(p.challenge), origin: "http://localhost:8765", crossOrigin: false })), authenticatorData: new Uint8Array([...hash, 5, 0, 0, 0, 0]) },
    getClientExtensionResults: () => ({ prf: { results: { first: new Uint8Array(32).fill(9).buffer } } }),
  });
  return { secureContext: true, origin: "http://localhost:8765", rpId: "localhost", credentials: {
    create: async ({ publicKey: p }) => {
      assert.equal(p.authenticatorSelection.userVerification, "required");
      assert.equal(p.authenticatorSelection.residentKey, "required");
      const r = response(p, "webauthn.create");
      r.getClientExtensionResults = () => ({ prf: { enabled: true } });
      return r;
    },
    get: async ({ publicKey: p }) => {
      assert.equal(p.userVerification, "required"); assert.equal(p.rpId, "localhost");
      assert.deepEqual(p.allowCredentials[0].id, id);
      assert.equal(Object.keys(p.extensions.prf.evalByCredential)[0], b64(id));
      const r = response(p, "webauthn.get"); options.modify?.(r); return r;
    },
  } };
}
test("adapter requires an actual PRF assertion even when registration reports enabled", async () => {
  const passkey = await enrollPasskey(await environment());
  assert.equal(passkey.credentialId, slot.credentialId);
  assert.equal(passkey.output.length, 32);
});
test("absent PRF, insecure contexts and absent credential APIs offer the explicit fallback", async () => {
  await assert.rejects(unlockPasskey(slot, await environment({ modify: r => r.getClientExtensionResults = () => ({}) })), PrfUnavailableError);
  await assert.rejects(unlockPasskey(slot, { ...(await environment()), secureContext: false }), PrfUnavailableError);
  await assert.rejects(unlockPasskey(slot, { ...(await environment()), credentials: {} }), PrfUnavailableError);
});
test("different credential, origin, challenge, RP hash or missing user verification is rejected", async () => {
  const changes = [
    r => r.rawId = new Uint8Array(32).fill(2).buffer,
    r => r.response.authenticatorData[0] ^= 1,
    r => r.response.authenticatorData[32] = 1,
    ...["origin", "challenge", "type"].map(key => r => {
      const value = JSON.parse(new TextDecoder().decode(r.response.clientDataJSON)); value[key] = "wrong";
      r.response.clientDataJSON = new TextEncoder().encode(JSON.stringify(value));
    }),
  ];
  for (const modify of changes) await assert.rejects(unlockPasskey(slot, await environment({ modify })));
  await assert.rejects(unlockPasskey({ ...slot, rpId: "example.com" }, await environment()), /original RP/);
});
// These API stubs are protocol tests, not evidence of browser/authenticator support.
