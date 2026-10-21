// Sign-in with an AlgoZKAuth wallet: the message a session key signs so a dApp's
// backend can learn which wallet the user controls (packages/verify checks it).
// It reads like a SIWE (EIP-4361) message and is rebuilt from its fields, so
// signer and verifier never parse free text. The session key signs
// SIGN_IN_DOMAIN || UTF-8(text); an action is a 32-byte digest under its own
// domain (action.mjs), so neither can stand in for the other.
const enc = new TextEncoder();
export const SIGN_IN_DOMAIN = "algozkauth-sign-in-v1\0";
export const SIGN_IN_VERSION = 1;
/** Longest validity a sign-in may claim; the session's own expiry (at most 10 minutes) also bounds it. */
export const MAX_SIGN_IN_SECONDS = 600;

const fail = field => { throw new Error(`Invalid sign-in ${field}`); };
const uint64 = value => typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
const seconds = value => Number.isSafeInteger(value) && value > 0;

/** A canonical copy of the fields, or an error naming the first bad one. */
export function validateSignInFields(f) {
  if (!f || typeof f !== "object") fail("fields");
  if (f.version !== SIGN_IN_VERSION) fail("version");
  let origin;
  try { origin = typeof f.origin === "string" && f.origin.length <= 256 ? new URL(f.origin) : undefined; } catch { /* below */ }
  if (!origin || (origin.protocol !== "https:" && origin.protocol !== "http:") || origin.origin !== f.origin) fail("origin");
  if (f.address !== null && !(typeof f.address === "string" && /^[A-Z2-7]{58}$/.test(f.address))) fail("address");
  if (f.statement !== null && !(typeof f.statement === "string" && f.statement.length >= 1 && f.statement.length <= 280 && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(f.statement))) fail("statement");
  if (typeof f.network !== "string" || !/^[a-z]{1,16}$/.test(f.network)) fail("network");
  if (typeof f.genesisHash !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(f.genesisHash)) fail("genesisHash");
  if (!uint64(f.app)) fail("app");
  if (typeof f.provider !== "string" || !/^[a-z0-9-]{1,32}$/.test(f.provider)) fail("provider");
  if (typeof f.nonce !== "string" || !/^[A-Za-z0-9]{8,128}$/.test(f.nonce)) fail("nonce");
  if (!seconds(f.issuedAt)) fail("issuedAt");
  if (!seconds(f.expiresAt) || f.expiresAt <= f.issuedAt || f.expiresAt - f.issuedAt > MAX_SIGN_IN_SECONDS) fail("expiresAt");
  return {
    version: SIGN_IN_VERSION, origin: f.origin, address: f.address, statement: f.statement, network: f.network,
    genesisHash: f.genesisHash, app: f.app, provider: f.provider, nonce: f.nonce, issuedAt: f.issuedAt, expiresAt: f.expiresAt,
  };
}

const iso = s => new Date(s * 1000).toISOString();

/** The text the user approves and the session key signs (after SIGN_IN_DOMAIN). */
export function signInMessage(fields) {
  const f = validateSignInFields(fields);
  return [
    `${f.origin} asks you to sign in with your AlgoZKAuth wallet:`,
    f.address ?? "(a new wallet, not created yet)",
    "",
    ...(f.statement ? [f.statement, ""] : []),
    `Version: ${f.version}`,
    `Network: ${f.network}`,
    `Genesis Hash: ${f.genesisHash}`,
    `App: ${f.app}`,
    `Provider: ${f.provider}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${iso(f.issuedAt)}`,
    `Expires At: ${iso(f.expiresAt)}`,
  ].join("\n");
}

/** SIGN_IN_DOMAIN || UTF-8(signInMessage(fields)): the bytes the session key signs. */
export function signInBytes(fields) {
  const domain = enc.encode(SIGN_IN_DOMAIN);
  const text = enc.encode(signInMessage(fields));
  const out = new Uint8Array(domain.length + text.length);
  out.set(domain); out.set(text, domain.length);
  return out;
}
