// Unit tests: sessions, origins and CORS, sponsor quotas, the rate limit and
// error mapping. No network, no chain. Development keys only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { identityCommitment, providerById, sessionNonce, syntheticToken } from "../../../packages/protocol/src/node.ts";
import { ChainError } from "../../../packages/chain/src/errors.ts";
import { ApiError, ERROR_CODES, MESSAGES, errorBody, toApiError } from "../src/errors.ts";
import { RateLimiter, SponsorQuotas, checkOrigin, corsHeaders, knownOrigins } from "../src/policy.ts";
import { SESSION_SECONDS, Sessions, sessionView } from "../src/sessions.ts";

const google = providerById("google");
const audience = "unit-test.apps.googleusercontent.com";
const genesisHash = randomBytes(32);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = { keys: [{ ...(rsa.publicKey.export({ format: "jwk" }) as object), kid: "dev-1", alg: "RS256", use: "sig" }] } as any;
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;

function fixture(now = 1_800_000_000) {
  const clock = { now };
  const sessions = new Sessions({ now: () => clock.now, maxPerApp: 3 });
  const start = (o: Record<string, unknown> = {}) => sessions.start({ app: "demo", provider: google, audience, genesisHash, sessionPublicKey: b64(randomBytes(32)), randomness: b64(randomBytes(32)), ...o } as any);
  const token = (nonce: string, o: { subject?: string; issuedAt?: number; audience?: string } = {}) =>
    syntheticToken(google, { privateKey: rsa.privateKey, kid: "dev-1", audience: o.audience ?? audience, subject: o.subject ?? "alice", nonce, issuedAt: o.issuedAt ?? clock.now });
  return { clock, sessions, start, token };
}

test("a session binds its key, randomness and expiry in the nonce", () => {
  const { sessions, start, clock } = fixture();
  const s = start();
  assert.match(s.id, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(s.expiresAt, clock.now + SESSION_SECONDS);
  assert.equal(s.nonce, sessionNonce({ genesisHash, sessionPublicKey: s.sessionPublicKey, expiresAt: s.expiresAt, randomness: s.randomness }));
  assert.equal(s.state, undefined);
  assert.deepEqual(sessionView(s, sessions.now()), { sessionId: s.id, app: "demo", provider: "google", expiresAt: s.expiresAt, networkTime: sessions.now(), loggedIn: false, hasSalt: false, proofReady: false });
  assert.throws(() => start({ sessionPublicKey: "short" }), code("bad_request"));
  assert.throws(() => start({ randomness: b64(randomBytes(31)) }), code("bad_request"));
  assert.equal(sessions.get(s.id), s);
  assert.throws(() => sessions.get("unknown"), code("session_expired"));
  assert.throws(() => sessions.get(s.id, { requireLogin: true }), code("not_signed_in"));
});

test("code-flow sessions carry state and, with PKCE, a verifier", () => {
  const { sessions, start } = fixture();
  const plain = start({ redirect: "http://localhost:8780/v1/oauth/google/callback" });
  assert.match(plain.state!, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(plain.codeVerifier, undefined);
  const pkce = start({ redirect: "http://localhost:8780/v1/oauth/google/callback", pkce: true });
  assert.ok(pkce.codeVerifier && pkce.codeChallenge && pkce.codeChallenge !== pkce.codeVerifier);
  assert.equal(sessions.byState(pkce.state), pkce);
  assert.throws(() => sessions.byState("nope"), code("session_expired"));
  assert.throws(() => sessions.byState(undefined), code("session_expired"));
});

test("login checks the token against the nonce, once", () => {
  const { sessions, start, token } = fixture();
  const s = start();
  const verified = sessions.login(s.id, token(s.nonce), jwks);
  assert.equal(verified.loggedIn, true);
  assert.deepEqual(verified.identity, { issuer: google.issuer, audience, subject: "alice" });
  assert.throws(() => sessions.login(s.id, token(s.nonce), jwks), code("login_consumed"));

  const wrongNonce = start();
  assert.throws(() => sessions.login(wrongNonce.id, token(s.nonce), jwks), code("token_invalid"));
  assert.equal(sessionView(wrongNonce, sessions.now()).loginError, "token_invalid");
  assert.equal(wrongNonce.loggedIn, false);
  // The login is consumed even when it fails.
  assert.throws(() => sessions.login(wrongNonce.id, token(wrongNonce.nonce), jwks), code("login_consumed"));

  const wrongAudience = start();
  assert.throws(() => sessions.login(wrongAudience.id, token(wrongAudience.nonce, { audience: "other" }), jwks), code("token_invalid"));
});

test("login refuses a token issued before the session's window", () => {
  const { start, sessions, token, clock } = fixture();
  const s = start();
  // Issued 1 s before the session started: the session would end after iat + 600.
  assert.throws(() => sessions.login(s.id, token(s.nonce, { issuedAt: clock.now - 1 }), jwks), code("token_invalid"));
});

test("sessions expire, are limited per app and erase their secrets", () => {
  const { sessions, start, token, clock } = fixture();
  const s = start();
  sessions.login(s.id, token(s.nonce), jwks);
  const salt = randomBytes(32);
  sessions.bindSalt(s.id, b64(salt));
  assert.deepEqual(s.owner, identityCommitment({ ...s.identity!, salt }).digest);
  sessions.bindSalt(s.id, b64(salt));
  assert.throws(() => sessions.bindSalt(s.id, b64(randomBytes(32))), code("salt_conflict"));
  assert.throws(() => sessions.bindSalt(s.id, "bad"), code("bad_request"));
  start(); start();
  assert.throws(() => start(), code("rate_limited"));
  assert.ok(start({ app: "other" }));
  const held = s.salt!;
  clock.now += SESSION_SECONDS;
  assert.throws(() => sessions.get(s.id), code("session_expired"));
  assert.equal(s.token, undefined);
  assert.ok(held.every((b) => b === 0));
  assert.equal(sessions.entries.size, 0);

  const other = start();
  sessions.delete(other.id);
  assert.throws(() => sessions.get(other.id), code("session_expired"));
});

test("salt binding needs a login", () => {
  const { sessions, start } = fixture();
  const s = start();
  assert.throws(() => sessions.bindSalt(s.id, b64(randomBytes(32))), code("not_signed_in"));
});

test("origins are checked per app; CORS answers only configured origins", () => {
  const app = { allowedOrigins: ["http://localhost:8765"] };
  checkOrigin(app, "http://localhost:8765");
  assert.throws(() => checkOrigin(app, "http://localhost:8766"), code("origin_not_allowed"));
  assert.throws(() => checkOrigin(app, undefined), code("origin_not_allowed"));
  const known = knownOrigins([app, { allowedOrigins: ["https://dapp.example"] }]);
  assert.deepEqual(corsHeaders(known, "http://evil.example"), { Vary: "Origin" });
  assert.deepEqual(corsHeaders(known, undefined), { Vary: "Origin" });
  assert.deepEqual(corsHeaders(known, "https://dapp.example"), { Vary: "Origin", "Access-Control-Allow-Origin": "https://dapp.example", "Access-Control-Expose-Headers": "Retry-After" });
  const preflight = corsHeaders(known, "http://localhost:8765", true);
  assert.equal(preflight["Access-Control-Allow-Origin"], "http://localhost:8765");
  assert.match(preflight["Access-Control-Allow-Methods"]!, /PUT/);
  assert.equal(preflight["Access-Control-Allow-Headers"], "content-type");
});

test("sponsor quotas: operations, actions per session, fees per UTC day", () => {
  const clock = { now: Date.UTC(2026, 9, 21, 23, 59, 0) };
  const quotas = new SponsorQuotas(() => clock.now);
  const app = { id: "demo", sponsor: { operations: ["0", "1"], maxActionsPerSession: 3, maxDailyFeeMicroAlgos: "50000" } };
  const session = { actions: 0, pendingActions: 0 };
  assert.throws(() => quotas.check(app, session, "3", 20_000n), code("quota_exceeded"));
  const first = quotas.reserve(app, session, "0", 20_000n);
  assert.deepEqual(session, { actions: 0, pendingActions: 1 });
  first.commit(20_000n);
  first.commit(20_000n);
  assert.deepEqual(session, { actions: 1, pendingActions: 0 });
  const second = quotas.reserve(app, session, "1", 20_000n);
  assert.equal(quotas.spentToday("demo"), 40_000n);
  second.release();
  assert.equal(quotas.spentToday("demo"), 20_000n);
  quotas.reserve(app, session, "1", 20_000n).commit(20_000n);
  // 40 000 spent: one more 20 000 group exceeds 50 000, with a retry at the next UTC day.
  const other = { actions: 0, pendingActions: 0 };
  assert.throws(() => quotas.check(app, other, "1", 20_000n), (e: unknown) => e instanceof ApiError && e.code === "quota_exceeded" && e.retryAfter === 60);
  // Another app has its own budget.
  quotas.check({ ...app, id: "other" }, other, "1", 20_000n);
  clock.now += 60_000;
  quotas.prune();
  assert.equal(quotas.spentToday("demo"), 0n);
  quotas.check(app, other, "1", 20_000n);
  // Actions per session (2 confirmed + 1 pending = 3).
  quotas.reserve(app, session, "1", 1n);
  assert.throws(() => quotas.check(app, session, "1", 1n), code("quota_exceeded"));
});

test("the session rate limit is per client address and window", () => {
  const clock = { now: 0 };
  const limiter = new RateLimiter(2, 60_000, () => clock.now);
  limiter.hit("a"); limiter.hit("a"); limiter.hit("b");
  clock.now = 15_000;
  assert.throws(() => limiter.hit("a"), (e: unknown) => e instanceof ApiError && e.code === "rate_limited" && e.retryAfter === 45);
  clock.now = 60_000;
  limiter.hit("a");
  limiter.prune();
});

test("chain errors and unknown failures map to ErrorCode with static messages", () => {
  const cases: [string, string][] = [
    ["key_inactive", "key_inactive"], ["key_pending_delay", "key_pending_delay"], ["registry_paused", "registry_paused"],
    ["session_expired", "session_expired"], ["invalid_proof", "proof_failed"], ["wrong_network", "proof_failed"],
    ["wrong_audience", "proof_failed"], ["wallet_exists", "wallet_exists"], ["not_enrolled", "not_enrolled"],
    ["replay", "replay"], ["insufficient_funds", "insufficient_funds"], ["rejected", "bad_request"],
  ];
  for (const [chainCode, apiCode] of cases) {
    const mapped = toApiError(new ChainError(chainCode as any, "Google key policy is inactive until 2026-10-22T00:00:00.000Z"));
    assert.equal(mapped.code, apiCode);
    assert.doesNotMatch(mapped.message, /Google|2026/);
  }
  const secret = "eyJhbGciOiJSUzI1NiJ9.secret-token";
  const unknown = toApiError(new Error(`fetch failed for ${secret}`));
  assert.equal(unknown.code, "service_unavailable");
  assert.equal(unknown.message, MESSAGES.service_unavailable);
  assert.equal(unknown.status, 503);
  assert.deepEqual(errorBody(new ApiError("key_pending_delay", undefined, 30)), { error: { code: "key_pending_delay", message: MESSAGES.key_pending_delay, retryAfter: 30 } });
  assert.deepEqual(errorBody(new ApiError("not_found")), { error: { code: "not_found", message: MESSAGES.not_found } });
});

test("the error codes are exactly the openapi ErrorCode enum", () => {
  const spec = readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8");
  const block = /ErrorCode:\s*\n\s*type: string\s*\n\s*enum: \[([^\]]+)\]/.exec(spec)![1]!;
  assert.deepEqual(block.split(",").map((c) => c.trim()), [...ERROR_CODES]);
});
