import { toBase64Url, fromBase64Url } from "./recovery.mjs";
const enc = new TextEncoder();
const random = () => crypto.getRandomValues(new Uint8Array(32));
export class PrfUnavailableError extends Error {
  constructor() { super("This passkey/browser did not return PRF key material. Use the recovery-secret fallback."); this.name = "PrfUnavailableError"; }
}
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
function context(environment) {
  const { credentials, origin, rpId, secureContext } = environment;
  if (!secureContext || !credentials?.create || !credentials?.get) throw new PrfUnavailableError();
  const url = new URL(origin);
  if (url.hostname !== rpId || url.origin !== origin) throw new Error("Invalid local passkey origin");
  return { credentials, origin, rpId };
}
export function browserPasskeyEnvironment() {
  return { credentials: navigator.credentials, origin: location.origin, rpId: location.hostname, secureContext: isSecureContext };
}
function clientContext(credential, challenge, origin, type) {
  if (!credential || credential.type !== "public-key") throw new Error("No passkey response");
  const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(credential.response.clientDataJSON));
  if (data.type !== type || data.origin !== origin || data.crossOrigin === true || data.topOrigin !== undefined || data.challenge !== toBase64Url(challenge)) throw new Error("Passkey response context does not match");
}
export async function unlockPasskey(slot, environment = browserPasskeyEnvironment()) {
  const { credentials, origin, rpId } = context(environment);
  if (slot.kind !== "prf" || slot.rpId !== rpId) throw new Error("Passkey backup requires its original RP hostname; use the recovery secret here");
  const id = fromBase64Url(slot.credentialId, 1, 1024);
  const input = fromBase64Url(slot.prfInput, 32);
  const challenge = random();
  const credential = await credentials.get({ publicKey: {
    challenge, rpId, timeout: 60_000, userVerification: "required",
    allowCredentials: [{ type: "public-key", id }],
    extensions: { prf: { evalByCredential: { [slot.credentialId]: { first: input } } } },
  } });
  clientContext(credential, challenge, origin, "webauthn.get");
  if (!same(new Uint8Array(credential.rawId), id)) throw new Error("The selected passkey does not match the backup");
  const auth = new Uint8Array(credential.response.authenticatorData);
  const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(rpId)));
  if (auth.length < 37 || !same(auth.slice(0, 32), rpHash) || (auth[32] & 5) !== 5) throw new Error("Passkey user verification or RP binding is missing");
  const first = credential.getClientExtensionResults()?.prf?.results?.first;
  if (!(first instanceof ArrayBuffer) && !ArrayBuffer.isView(first)) throw new PrfUnavailableError();
  const output = first instanceof ArrayBuffer ? new Uint8Array(first.slice(0)) : new Uint8Array(first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength));
  if (output.length !== 32) { output.fill(0); throw new PrfUnavailableError(); }
  // Local decryption, not a server login. AEAD verifies the PRF key. We do not
  // transmit this secret or claim to verify an attestation/assertion signature.
  return { rpId, credentialId: slot.credentialId, prfInput: slot.prfInput, output };
}
export async function enrollPasskey(environment = browserPasskeyEnvironment()) {
  const { credentials, origin, rpId } = context(environment);
  const challenge = random();
  const input = random();
  const credential = await credentials.create({ publicKey: {
    rp: { id: rpId, name: "Algorand zkLogin recovery POC" },
    user: { id: random(), name: `recovery-${toBase64Url(random()).slice(0, 12)}`, displayName: "Wallet recovery" },
    challenge, pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    timeout: 60_000, authenticatorSelection: { residentKey: "required", userVerification: "required" },
    attestation: "none", extensions: { prf: { eval: { first: input } } },
  } });
  clientContext(credential, challenge, origin, "webauthn.create");
  const slot = { kind: "prf", rpId, credentialId: toBase64Url(new Uint8Array(credential.rawId)), prfInput: toBase64Url(input) };
  // Some authenticators enable PRF during creation but only supply output on
  // assertion. Prove the usable result rather than trusting a capability flag.
  return unlockPasskey(slot, environment);
}
