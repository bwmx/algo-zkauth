// One genuine sign-in with a code-flow provider (login.flow "code"), checked
// against its circuit profile without any chain access. The session public key
// is random with no private key kept, so the token cannot authorize a wallet
// action. The record holds claim names, lengths and outcomes only, never token
// values or identifiers. A provider without a circuit profile or built circuit
// yet gets the claim and serialization profile only: that is the input for
// writing its profile.
// Usage: node --env-file=.env evidence/login/check-login.mjs <provider>
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import { authorizeUrl, exchangeCode, localCallback, pkcePair, redirectUri, usesPkce } from "../../packages/protocol/src/code-login.mjs";
import { fetchJwks, parseUniqueJson, verifyIdToken } from "../../packages/protocol/src/id-token.mjs";
import { oidcCircuitInput } from "../../packages/protocol/src/circuit-input.mjs";
import { CIRCUIT_PROFILES, rawJsonText } from "../../packages/protocol/src/circuit-profile.mjs";
import { providerById, providerEnv, providerEnvName } from "../../packages/protocol/src/oidc-providers.mjs";
import { sessionNonce } from "../../packages/protocol/src/session-nonce.mjs";

const root = new URL("../../", import.meta.url).pathname;
const provider = providerById(process.argv[2]);
const { label, circuit, subjectScope: scope } = provider;
if (provider.login.flow !== "code") throw new Error(`${label} does not sign in with the authorization code flow; this check needs a login window`);
const profile = CIRCUIT_PROFILES[provider.id];
const clientId = providerEnv(provider, "CLIENT_ID");
const clientSecret = providerEnv(provider, "CLIENT_SECRET");
if (!clientId) throw new Error(`Set ${providerEnvName(provider, "CLIENT_ID")} (and ${providerEnvName(provider, "CLIENT_SECRET")} unless the app uses PKCE only) in the local .env`);
const origin = "http://localhost:8765";
const callback = localCallback(origin, provider);
const redirect = redirectUri(provider, callback, providerEnv(provider, "REDIRECT_URI"));
const pkce = usesPkce(provider, redirect);
// Each page load starts its own ten-minute session, keyed by login state.
const attempts = new Map();
function attempt() {
  const context = {
    genesisHash: randomBytes(32), sessionPublicKey: randomBytes(32), randomness: randomBytes(32),
    salt: randomBytes(32), expiresAt: Math.floor(Date.now() / 1000) + 600,
  };
  const value = { context, nonce: sessionNonce(context), state: randomBytes(32).toString("base64url"), pkce: pkcePair() };
  value.authorizeUrl = authorizeUrl(provider, { clientId, redirectUri: redirect, nonce: value.nonce, state: value.state, codeChallenge: pkce ? value.pkce.challenge : undefined });
  attempts.set(value.state, value);
  return value;
}

const outcome = (callback) => {
  try { return { passed: true, ...callback() }; }
  catch (error) { return { passed: false, error: String(error.message).split("\n")[0].slice(0, 200) }; }
};
async function analyze(token, { context, nonce }) {
  const [h, p] = token.split(".");
  const headerText = Buffer.from(h, "base64url").toString("utf8");
  const payloadText = Buffer.from(p, "base64url").toString("utf8");
  const header = parseUniqueJson(headerText);
  const claims = parseUniqueJson(payloadText);
  const types = Object.fromEntries(Object.entries(claims).map(([k, v]) => [k, typeof v]));
  const escaped = profile?.escapedSlashes ?? payloadText.includes("\\/");
  const record = {
    recordedAt: new Date().toISOString(), [`genuine${label}Token`]: true, provider: provider.id, scope: "openid",
    header: { keys: Object.keys(header), alg: header.alg, typ: header.typ ?? null, kidLength: header.kid?.length ?? 0 },
    claims: types,
    circuitProfile: !!profile,
    claimsOutsideProfile: profile ? Object.keys(claims).filter((k) => !profile.payloadKeys.includes(k)) : null,
    serialization: {
      escapedSlashes: payloadText.includes("\\/"),
      unescapedSlashes: /(^|[^\\])\//.test(payloadText),
      unicodeEscapes: /\\u/.test(payloadText),
      canonicalEscapedSpelling: rawJsonText(JSON.stringify(claims), true) === payloadText,
      canonicalPlainSpelling: JSON.stringify(claims) === payloadText,
    },
    lengths: {
      headerEncoded: h.length, payloadEncoded: p.length, signedMessage: h.length + 1 + p.length, payloadDecoded: Buffer.byteLength(payloadText),
      subject: typeof claims.sub === "string" ? claims.sub.length : null,
      ...(scope ? { [scope.name]: typeof claims[scope.claim] === "string" ? claims[scope.claim].length : null } : {}),
      longestSignedClaimName: Math.max(...Object.keys(claims).map((k) => rawJsonText(k, escaped).length)),
      // Kind-0/3 circuit values are at most 255 signed bytes.
      longestSignedStringValue: Math.max(0, ...Object.values(claims).filter((v) => typeof v === "string").map((v) => rawJsonText(v, escaped).length)),
    },
    times: { tokenLifetimeSeconds: claims.exp - claims.iat, authTimeEqualsIat: claims.auth_time === claims.iat, issuedAfterSessionStart: claims.iat >= context.expiresAt - 600 },
    limits: { signedMessage: 1015, headerEncoded: 128, payloadEncoded: 896, payloadDecoded: 672, claimFields: profile?.payloadKeys.length ?? null, signedClaimName: 30, signedStringValue: 255 },
  };
  const jwks = await fetchJwks(provider);
  const nowSeconds = Math.floor(Date.now() / 1000);
  record.tokenVerification = outcome(() => { const v = verifyIdToken(token, { provider, audience: clientId, nonce, jwks, nowSeconds }); return { keyId: v.keyId, modulusSha256: v.modulusSha256 }; });
  let input;
  if (profile) record.circuitPreflight = outcome(() => { input = oidcCircuitInput({ provider, token, jwks, audience: clientId, nonce, ...context, nowSeconds }); return { payloadFields: input.payloadFieldCount }; });
  const wasm = `${root}${circuit.directory}/${circuit.name}_js/${circuit.name}.wasm`;
  if (input && existsSync(wasm)) {
    const { default: builder } = await import(`${root}${circuit.directory}/${circuit.name}_js/witness_calculator.js`);
    const calculator = await builder(readFileSync(wasm));
    const started = performance.now();
    try {
      const witness = await calculator.calculateWitness(input, true);
      const expected = [...input.identity, ...input.keyHash, ...input.audienceHash, ...input.sessionKey, ...input.genesisHash, input.sessionExpiresAt, input.notBefore].map(BigInt);
      record.circuitWitness = { passed: witness.slice(1, 13).every((v, i) => v === expected[i]), witnessMs: Math.round(performance.now() - started) };
    } catch (error) {
      record.circuitWitness = { passed: false, error: String(error.message).replace(/\s+/g, " ").slice(0, 300) };
    }
  }
  // Private copy for offline rechecks after a profile change (prove-login.mjs);
  // the random session key has no private half, so it authorizes nothing.
  mkdirSync(`${root}${provider.local}`, { recursive: true, mode: 0o700 }); chmodSync(`${root}${provider.local}`, 0o700);
  writeFileSync(`${root}${provider.local}/genuine-login.json`, JSON.stringify({ token, nonce, ...Object.fromEntries(Object.entries(context).map(([k, v]) => [k, Buffer.isBuffer(v) ? v.toString("base64url") : v])) }), { mode: 0o600 });
  writeFileSync(`${root}benchmarks/${provider.records.tokenProfile}`, JSON.stringify(record, null, 2) + "\n");
  return record;
}

const html = (body) => `<!doctype html><meta charset="utf-8"><title>${label} profile check</title><body style="font:16px system-ui;max-width:640px;margin:3rem auto">${body}`;
const timeout = setTimeout(() => { console.error(`No ${label} login within thirty minutes`); process.exit(2); }, 1_800_000);
const server = createServer(async (request, response) => {
  const url = new URL(request.url, origin);
  const send = (status, body) => { response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }); response.end(html(body)); };
  if (request.headers.host !== "localhost:8765") return send(403, "Invalid host");
  if (url.pathname === "/") return send(200, `<h1>${label} token profile check</h1><p>Signs in once and checks the ID token against the ${label} circuit profile. Nothing is submitted to Algorand. Sign in within ten minutes of loading this page.</p><p><a href="${attempt().authorizeUrl.replaceAll("&", "&amp;")}">Sign in with ${label}</a></p>`);
  if (url.pathname !== new URL(callback).pathname) return send(404, "Not found");
  const current = attempts.get(url.searchParams.get("state"));
  if (!current) return send(400, "Unknown login state; reload the check page.");
  attempts.delete(current.state);
  if (url.searchParams.has("error")) { send(400, `${label} sign-in was cancelled or denied.`); console.error(`${label} returned error: ${String(url.searchParams.get("error")).slice(0, 64)}`); process.exitCode = 1; clearTimeout(timeout); server.close(); return server.closeAllConnections(); }
  try {
    const token = await exchangeCode(provider, { clientId, clientSecret, code: url.searchParams.get("code"), codeVerifier: pkce ? current.pkce.verifier : undefined, redirectUri: redirect,
      onAttempt: (a) => console.log(`Token exchange ${a.withSecret ? "with" : "without"} client secret: ${a.ok ? "ok" : a.error}`) });
    const record = await analyze(token, current);
    console.log(JSON.stringify(record, null, 2));
    const ok = record.tokenVerification.passed && record.circuitPreflight?.passed && record.circuitWitness?.passed;
    send(200, `<h1>${ok ? `Token fits the ${label} circuit` : profile ? `Token is outside the ${label} circuit profile` : `Recorded the ${label} token profile; no circuit profile yet`}</h1><p>Return to the terminal for the sanitized report.</p>`);
    process.exitCode = ok ? 0 : 1;
  } catch (error) {
    send(500, "Check failed; see the terminal.");
    console.error(String(error.message).split("\n")[0].slice(0, 200)); process.exitCode = 1;
  }
  clearTimeout(timeout); server.close(); server.closeAllConnections();
});
server.listen(8765, "localhost", () => console.log(`Open ${origin}/ and choose Sign in with ${label}.`));
