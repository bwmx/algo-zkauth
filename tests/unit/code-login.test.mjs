import test from "node:test";
import assert from "node:assert/strict";
import { authorizeUrl, exchangeCode, localCallback, pkceChallenge, pkcePair, redirectUri, usesPkce } from "../../packages/protocol/src/code-login.mjs";
import { PROVIDERS } from "../../packages/protocol/src/oidc-providers.mjs";

// The generic code flow, exercised with Slack's provider data.
const slack = PROVIDERS.slack;
const exchangeSlackCode = (options) => exchangeCode(slack, options);

const options = { clientId: "1234567890.9876543210", clientSecret: "test-secret", redirectUri: "http://localhost:8765/demo/slack/callback" };
const { verifier: codeVerifier, challenge } = pkcePair();
const form = (request) => Object.fromEntries(new URLSearchParams(request.init.body));

test("an https redirect uses Slack's documented OpenID Connect authorize request", () => {
  const relay = "https://example.github.io/algo-zkauth/slack-callback/";
  assert.equal(usesPkce(slack, relay), false);
  assert.equal(usesPkce(slack, options.redirectUri), true);
  const url = new URL(authorizeUrl(slack, { ...options, redirectUri: relay, nonce: "session-nonce", state: "login-state" }));
  assert.equal(url.origin + url.pathname, "https://slack.com/openid/connect/authorize");
  assert.deepEqual(Object.fromEntries(url.searchParams), { response_type: "code", scope: "openid", client_id: options.clientId, redirect_uri: relay, state: "login-state", nonce: "session-nonce" });
});

test("PKCE uses S256 and the authorize URL requests only openid with nonce, state and challenge", () => {
  // RFC 7636 appendix B.
  assert.equal(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  assert.equal(challenge, pkceChallenge(codeVerifier));
  assert.match(codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  const url = new URL(authorizeUrl(slack, { ...options, nonce: "session-nonce", state: "login-state", codeChallenge: challenge }));
  assert.equal(url.origin + url.pathname, "https://slack.com/oauth/v2/authorize");
  assert.deepEqual(Object.fromEntries(url.searchParams), { client_id: options.clientId, user_scope: "openid", openid_connect: "1", redirect_uri: options.redirectUri, response_type: "code", state: "login-state", nonce: "session-nonce", code_challenge: challenge, code_challenge_method: "S256" });
});

test("code exchange authenticates with the secret and verifier and returns only the ID token", async () => {
  const requests = [];
  const fetch = async (url, init) => { requests.push({ url, init }); return { ok: true, text: async () => JSON.stringify({ ok: true, access_token: "xoxp-unused", id_token: "header.payload.signature" }) }; };
  assert.equal(await exchangeSlackCode({ ...options, code: "slack-code", codeVerifier, fetch }), "header.payload.signature");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://slack.com/api/openid.connect.token");
  assert.equal(requests[0].init.method, "POST");
  assert.deepEqual(form(requests[0]), { grant_type: "authorization_code", code: "slack-code", redirect_uri: options.redirectUri, client_id: options.clientId, code_verifier: codeVerifier, client_secret: "test-secret" });
});

test("the secretless PKCE form is a single fallback on client-auth or internal errors", async () => {
  const replies = (...bodies) => { const requests = []; return { requests, fetch: async (url, init) => { requests.push({ url, init }); return { ok: true, text: async () => JSON.stringify(bodies[requests.length - 1]) }; } }; };
  for (const error of ["bad_client_secret", "internal_error"]) {
    const attempts = [];
    const publicClient = replies({ ok: false, error }, { ok: true, id_token: "a.b.c" });
    assert.equal(await exchangeSlackCode({ ...options, code: "c", codeVerifier, fetch: publicClient.fetch, onAttempt: (a) => attempts.push(a) }), "a.b.c");
    assert.equal(form(publicClient.requests[0]).client_secret, "test-secret");
    assert.equal(form(publicClient.requests[1]).client_secret, undefined);
    assert.equal(form(publicClient.requests[1]).code_verifier, codeVerifier);
    assert.deepEqual(attempts, [{ withSecret: true, ok: false, error }, { withSecret: false, ok: true, error: null }]);
  }
  const mismatch = replies({ ok: false, error: "invalid_grant" });
  await assert.rejects(exchangeSlackCode({ ...options, code: "c", codeVerifier, fetch: mismatch.fetch }), /rejected \(invalid_grant\)/);
  assert.equal(mismatch.requests.length, 1);
  const secretless = replies({ ok: false, error: "internal_error" });
  await assert.rejects(exchangeSlackCode({ ...options, clientSecret: undefined, code: "c", codeVerifier, fetch: secretless.fetch }), /rejected \(internal_error\)/);
  assert.equal(secretless.requests.length, 1);
  assert.equal(form(secretless.requests[0]).client_secret, undefined);
});

test("without PKCE the exchange sends the client secret once and requires it", async () => {
  const requests = [];
  const fetch = async (url, init) => { requests.push({ url, init }); return { ok: true, text: async () => JSON.stringify({ ok: false, error: "internal_error" }) }; };
  await assert.rejects(exchangeSlackCode({ ...options, code: "c", fetch }), /rejected \(internal_error\)/);
  assert.equal(requests.length, 1);
  assert.deepEqual(form(requests[0]), { grant_type: "authorization_code", code: "c", redirect_uri: options.redirectUri, client_id: options.clientId, client_secret: "test-secret" });
  await assert.rejects(exchangeSlackCode({ ...options, clientSecret: undefined, code: "c", fetch }), /needs SLACK_CLIENT_SECRET/);
  assert.equal(requests.length, 1);
});

test("code exchange rejects Slack errors, HTTP failures and malformed inputs", async () => {
  const reply = (body, ok = true, status = 200) => async () => ({ ok, status, text: async () => body });
  await assert.rejects(exchangeSlackCode({ ...options, code: "c", codeVerifier, fetch: reply(JSON.stringify({ ok: false, error: "invalid_code" })) }), /rejected \(invalid_code\)/);
  await assert.rejects(exchangeSlackCode({ ...options, code: "c", codeVerifier, fetch: reply(JSON.stringify({ ok: false, error: "<script>" })) }), /rejected$/);
  await assert.rejects(exchangeSlackCode({ ...options, code: "c", codeVerifier, fetch: reply(JSON.stringify({ ok: true })) }), /rejected/);
  await assert.rejects(exchangeSlackCode({ ...options, code: "c", codeVerifier, fetch: reply("", false, 502) }), /HTTP 502/);
  await assert.rejects(exchangeSlackCode({ ...options, code: "a b", codeVerifier, fetch: reply("{}") }), /authorization code/);
  await assert.rejects(exchangeSlackCode({ ...options, code: "c", codeVerifier: "short", fetch: reply("{}") }), /code verifier/);
});

test("the redirect URI defaults to the local callback and accepts only an https relay", () => {
  const local = localCallback("http://localhost:8765", slack);
  assert.equal(local, "http://localhost:8765/demo/slack/callback");
  assert.equal(redirectUri(slack, local), local);
  assert.equal(redirectUri(slack, local, ""), local);
  assert.equal(redirectUri(slack, local, "https://example.github.io/algo-zkauth/slack-callback/"), "https://example.github.io/algo-zkauth/slack-callback/");
  for (const bad of ["http://example.com/cb", "https://example.com/cb?x=1", "https://example.com/cb#x", "not a url"]) assert.throws(() => redirectUri(slack, local, bad), /SLACK_REDIRECT_URI/);
});

test("only code-flow providers build authorize requests, and PKCE can be mandatory", () => {
  assert.throws(() => authorizeUrl(PROVIDERS.google, { ...options, nonce: "n", state: "s" }), /authorization code flow/);
  assert.throws(() => usesPkce(PROVIDERS.google, options.redirectUri), /authorization code flow/);
  const required = { ...slack, login: { ...slack.login, pkce: "always" } };
  assert.equal(usesPkce(required, "https://example.github.io/algo-zkauth/slack-callback/"), true);
});
