import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { verifyIdToken } from "../src/phase3/id-token.mjs";
import { verifyGoogleIdToken } from "../src/phase3/google-id-token.mjs";
import { PROVIDERS, providerById, providerForIssuer } from "../src/phase3/oidc-providers.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
// Slack's JWKS omits "use", unlike Google's.
const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "slack-key", alg: "RS256" }] };
const nowSeconds = 1_800_000_000;
const audience = "1234567890.9876543210";
const nonce = "expected-session-nonce";
const payload = {
  iss: "https://slack.com",
  sub: "U0123ABCDEF",
  aud: audience,
  exp: nowSeconds + 270,
  iat: nowSeconds - 30,
  auth_time: nowSeconds - 30,
  nonce,
  "https://slack.com/team_id": "T0123ABC456",
  "https://slack.com/user_id": "U0123ABCDEF",
};

function tokenFor(body = payload) {
  const message = [{ typ: "JWT", alg: "RS256", kid: "slack-key" }, body]
    .map((v) => Buffer.from(JSON.stringify(v).replaceAll("/", "\\/")).toString("base64url"))
    .join(".");
  return `${message}.${sign("RSA-SHA256", Buffer.from(message), privateKey).toString("base64url")}`;
}
const options = { provider: PROVIDERS.slack, audience, nonce, jwks, nowSeconds };

test("accepts a Slack token with escaped slashes and returns the team/sub subject", () => {
  const result = verifyIdToken(tokenFor(), options);
  assert.equal(result.subject, "T0123ABC456/U0123ABCDEF");
  assert.equal(result.issuer, "https://slack.com");
  assert.equal(result.expiresAt, payload.exp);
});

test("rejects other issuers, missing or ambiguous teams and long subjects", () => {
  for (const [change, error] of [
    [{ iss: "https://accounts.google.com" }, /Invalid Slack issuer/],
    [{ "https://slack.com/team_id": undefined }, /Slack team/],
    [{ "https://slack.com/team_id": "T1/U2" }, /Slack team/],
    [{ "https://slack.com/team_id": "T".repeat(33) }, /Slack team/],
    [{ sub: "U".repeat(250) }, /Slack team or subject/],
    [{ aud: "other-client" }, /Invalid Slack audience/],
    [{ nonce: "other" }, /Invalid Slack nonce/],
  ]) {
    assert.throws(() => verifyIdToken(tokenFor({ ...payload, ...change }), options), error);
  }
});

test("providers do not accept each other's tokens", () => {
  assert.throws(() => verifyGoogleIdToken(tokenFor(), { audience, nonce, jwks, nowSeconds }), /Invalid Google issuer/);
  assert.throws(() => verifyIdToken(tokenFor(), { ...options, provider: undefined }), /provider is required/);
  assert.equal(providerForIssuer("accounts.google.com"), PROVIDERS.google);
  assert.equal(providerForIssuer("https://slack.com"), PROVIDERS.slack);
  assert.throws(() => providerForIssuer("slack.com"), /Unsupported issuer/);
  assert.throws(() => providerById("__proto__"), /Unsupported login provider/);
});
