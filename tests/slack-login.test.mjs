import test from "node:test";
import assert from "node:assert/strict";
import { exchangeSlackCode, slackAuthorizeUrl } from "../src/phase6/slack-login.mjs";

const options = { clientId: "1234567890.9876543210", clientSecret: "test-secret", redirectUri: "http://localhost:8765/demo/slack/callback" };

test("authorize URL requests only openid with the session nonce and state", () => {
  const url = new URL(slackAuthorizeUrl({ ...options, nonce: "session-nonce", state: "login-state" }));
  assert.equal(url.origin + url.pathname, "https://slack.com/openid/connect/authorize");
  assert.deepEqual(Object.fromEntries(url.searchParams), { response_type: "code", scope: "openid", client_id: options.clientId, redirect_uri: options.redirectUri, state: "login-state", nonce: "session-nonce" });
});

test("code exchange posts the secret to Slack and returns only the ID token", async () => {
  const requests = [];
  const fetch = async (url, init) => { requests.push({ url, init }); return { ok: true, text: async () => JSON.stringify({ ok: true, access_token: "xoxp-unused", id_token: "header.payload.signature" }) }; };
  assert.equal(await exchangeSlackCode({ ...options, code: "slack-code", fetch }), "header.payload.signature");
  assert.equal(requests[0].url, "https://slack.com/api/openid.connect.token");
  assert.equal(requests[0].init.method, "POST");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(requests[0].init.body)), { grant_type: "authorization_code", code: "slack-code", redirect_uri: options.redirectUri, client_id: options.clientId, client_secret: "test-secret" });
});

test("code exchange rejects Slack errors, HTTP failures and malformed codes", async () => {
  const reply = (body, ok = true, status = 200) => async () => ({ ok, status, text: async () => body });
  await assert.rejects(exchangeSlackCode({ ...options, code: "c", fetch: reply(JSON.stringify({ ok: false, error: "invalid_code" })) }), /rejected \(invalid_code\)/);
  await assert.rejects(exchangeSlackCode({ ...options, code: "c", fetch: reply(JSON.stringify({ ok: false, error: "<script>" })) }), /rejected$/);
  await assert.rejects(exchangeSlackCode({ ...options, code: "c", fetch: reply(JSON.stringify({ ok: true })) }), /rejected/);
  await assert.rejects(exchangeSlackCode({ ...options, code: "c", fetch: reply("", false, 502) }), /HTTP 502/);
  await assert.rejects(exchangeSlackCode({ ...options, code: "a b", fetch: reply("{}") }), /authorization code/);
});
