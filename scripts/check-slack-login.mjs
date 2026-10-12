// One genuine Sign in with Slack, checked against the Slack circuit profile
// without any chain access. The session public key is random with no private
// key kept, so the token cannot authorize a wallet action. The record holds
// claim names, lengths and outcomes only, never token values or identifiers.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import { exchangeSlackCode, pkcePair, slackAuthorizeUrl, slackRedirectUri, usesPkce } from "../src/phase6/slack-login.mjs";
import { fetchJwks, parseUniqueJson, verifyIdToken } from "../src/phase3/id-token.mjs";
import { oidcCircuitInput } from "../src/phase3/circuit-input.mjs";
import { SLACK_PAYLOAD_KEYS, rawJsonText } from "../src/phase3/circuit-profile.mjs";
import { PROVIDERS, SLACK_TEAM_CLAIM } from "../src/phase3/oidc-providers.mjs";
import { sessionNonce } from "../src/phase3/session-nonce.mjs";

const root = new URL("../", import.meta.url).pathname;
const { SLACK_CLIENT_ID: clientId, SLACK_CLIENT_SECRET: clientSecret } = process.env;
if (!clientId) throw new Error("Set SLACK_CLIENT_ID (and SLACK_CLIENT_SECRET unless the app uses PKCE only) in the local .env");
const origin = "http://localhost:8765";
const redirectUri = slackRedirectUri(`${origin}/demo/slack/callback`, process.env.SLACK_REDIRECT_URI);
const pkce = usesPkce(redirectUri);
// Each page load starts its own ten-minute session, keyed by login state.
const attempts = new Map();
function attempt() {
  const context = {
    genesisHash: randomBytes(32), sessionPublicKey: randomBytes(32), randomness: randomBytes(32),
    salt: randomBytes(32), expiresAt: Math.floor(Date.now() / 1000) + 600,
  };
  const value = { context, nonce: sessionNonce(context), state: randomBytes(32).toString("base64url"), pkce: pkcePair() };
  value.authorizeUrl = slackAuthorizeUrl({ clientId, redirectUri, nonce: value.nonce, state: value.state, codeChallenge: pkce ? value.pkce.challenge : undefined });
  attempts.set(value.state, value);
  return value;
}
const slack = PROVIDERS.slack;

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
  const record = {
    recordedAt: new Date().toISOString(), genuineSlackToken: true, scope: "openid",
    header: { keys: Object.keys(header), alg: header.alg, typ: header.typ ?? null, kidLength: header.kid?.length ?? 0 },
    claims: types,
    claimsOutsideProfile: Object.keys(claims).filter((k) => !SLACK_PAYLOAD_KEYS.includes(k)),
    serialization: {
      escapedSlashes: payloadText.includes("\\/"),
      unescapedSlashes: /(^|[^\\])\//.test(payloadText),
      unicodeEscapes: /\\u/.test(payloadText),
      canonicalSlackSpelling: rawJsonText(JSON.stringify(claims), true) === payloadText,
      canonicalPlainSpelling: JSON.stringify(claims) === payloadText,
    },
    lengths: {
      headerEncoded: h.length, payloadEncoded: p.length, signedMessage: h.length + 1 + p.length, payloadDecoded: Buffer.byteLength(payloadText),
      subject: typeof claims.sub === "string" ? claims.sub.length : null, team: typeof claims[SLACK_TEAM_CLAIM] === "string" ? claims[SLACK_TEAM_CLAIM].length : null,
      longestSignedClaimName: Math.max(...Object.keys(claims).map((k) => rawJsonText(k, true).length)),
    },
    times: { tokenLifetimeSeconds: claims.exp - claims.iat, authTimeEqualsIat: claims.auth_time === claims.iat, issuedAfterSessionStart: claims.iat >= context.expiresAt - 600 },
    limits: { signedMessage: 1015, headerEncoded: 128, payloadEncoded: 896, payloadDecoded: 672, claimFields: SLACK_PAYLOAD_KEYS.length, signedClaimName: 30 },
  };
  const jwks = await fetchJwks(slack);
  const nowSeconds = Math.floor(Date.now() / 1000);
  record.tokenVerification = outcome(() => { const v = verifyIdToken(token, { provider: slack, audience: clientId, nonce, jwks, nowSeconds }); return { keyId: v.keyId, modulusSha256: v.modulusSha256 }; });
  let input;
  record.circuitPreflight = outcome(() => { input = oidcCircuitInput({ provider: slack, token, jwks, audience: clientId, nonce, ...context, nowSeconds }); return { payloadFields: input.payloadFieldCount }; });
  if (input) {
    const { default: builder } = await import(`${root}fixtures/slack/slack_jwt_js/witness_calculator.js`);
    const calculator = await builder(readFileSync(`${root}fixtures/slack/slack_jwt_js/slack_jwt.wasm`));
    const started = performance.now();
    try {
      const witness = await calculator.calculateWitness(input, true);
      const expected = [...input.identity, ...input.keyHash, ...input.audienceHash, ...input.sessionKey, ...input.genesisHash, input.sessionExpiresAt, input.notBefore].map(BigInt);
      record.circuitWitness = { passed: witness.slice(1, 13).every((v, i) => v === expected[i]), witnessMs: Math.round(performance.now() - started) };
    } catch (error) {
      record.circuitWitness = { passed: false, error: String(error.message).replace(/\s+/g, " ").slice(0, 300) };
    }
  }
  // Private copy for offline rechecks after a profile change; the random
  // session key has no private half, so it authorizes nothing.
  mkdirSync(`${root}.local/slack`, { recursive: true, mode: 0o700 }); chmodSync(`${root}.local/slack`, 0o700);
  writeFileSync(`${root}.local/slack/genuine-login.json`, JSON.stringify({ token, nonce, ...Object.fromEntries(Object.entries(context).map(([k, v]) => [k, Buffer.isBuffer(v) ? v.toString("base64url") : v])) }), { mode: 0o600 });
  writeFileSync(`${root}benchmarks/slack-token-profile.json`, JSON.stringify(record, null, 2) + "\n");
  return record;
}

const html = (body) => `<!doctype html><meta charset="utf-8"><title>Slack profile check</title><body style="font:16px system-ui;max-width:640px;margin:3rem auto">${body}`;
const timeout = setTimeout(() => { console.error("No Slack login within thirty minutes"); process.exit(2); }, 1_800_000);
const server = createServer(async (request, response) => {
  const url = new URL(request.url, origin);
  const send = (status, body) => { response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }); response.end(html(body)); };
  if (request.headers.host !== "localhost:8765") return send(403, "Invalid host");
  if (url.pathname === "/") return send(200, `<h1>Slack token profile check</h1><p>Signs in once and checks the ID token against the Slack circuit. Nothing is submitted to Algorand. Sign in within ten minutes of loading this page.</p><p><a href="${attempt().authorizeUrl.replaceAll("&", "&amp;")}">Sign in with Slack</a></p>`);
  if (url.pathname !== "/demo/slack/callback") return send(404, "Not found");
  const current = attempts.get(url.searchParams.get("state"));
  if (!current) return send(400, "Unknown login state; reload the check page.");
  attempts.delete(current.state);
  if (url.searchParams.has("error")) { send(400, "Slack sign-in was cancelled or denied."); console.error(`Slack returned error: ${String(url.searchParams.get("error")).slice(0, 64)}`); process.exitCode = 1; clearTimeout(timeout); server.close(); return server.closeAllConnections(); }
  try {
    const token = await exchangeSlackCode({ clientId, clientSecret, code: url.searchParams.get("code"), codeVerifier: pkce ? current.pkce.verifier : undefined, redirectUri,
      onAttempt: (a) => console.log(`Token exchange ${a.withSecret ? "with" : "without"} client secret: ${a.ok ? "ok" : a.error}`) });
    const record = await analyze(token, current);
    console.log(JSON.stringify(record, null, 2));
    const ok = record.tokenVerification.passed && record.circuitPreflight.passed && record.circuitWitness?.passed;
    send(200, `<h1>${ok ? "Token fits the Slack circuit" : "Token is outside the Slack circuit profile"}</h1><p>Return to the terminal for the sanitized report.</p>`);
    process.exitCode = ok ? 0 : 1;
  } catch (error) {
    send(500, "Check failed; see the terminal.");
    console.error(String(error.message).split("\n")[0].slice(0, 200)); process.exitCode = 1;
  }
  clearTimeout(timeout); server.close(); server.closeAllConnections();
});
server.listen(8765, "localhost", () => console.log(`Open ${origin}/ and choose Sign in with Slack.`));
