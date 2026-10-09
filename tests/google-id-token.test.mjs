import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { parseUniqueJson, verifyGoogleIdToken } from "../src/phase3/google-id-token.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
const jwks = { keys: [jwk] };
const nowSeconds = 1_800_000_000;
const audience = "poc.apps.googleusercontent.com";
const nonce = "expected-session-nonce";
const payload = {
  iss: "https://accounts.google.com",
  aud: audience,
  sub: "1234567890",
  nonce,
  iat: nowSeconds - 30,
  exp: nowSeconds + 1800,
};

function tokenFor(body = payload, header = { alg: "RS256", typ: "JWT", kid: "test-key" }, signer = privateKey) {
  const encodedHeader = Buffer.from(typeof header === "string" ? header : JSON.stringify(header)).toString("base64url");
  const encodedBody = Buffer.from(typeof body === "string" ? body : JSON.stringify(body)).toString("base64url");
  const message = `${encodedHeader}.${encodedBody}`;
  return `${message}.${sign("RSA-SHA256", Buffer.from(message), signer).toString("base64url")}`;
}

const verifyOptions = { audience, nonce, jwks, nowSeconds };

test("accepts a correctly signed, bounded Google-shaped token", () => {
  const result = verifyGoogleIdToken(tokenFor(), verifyOptions);
  assert.equal(result.subject, payload.sub);
  assert.equal(result.expiresAt, payload.exp);
  assert.match(result.modulusSha256, /^[a-f0-9]{64}$/);
});

test("rejects modified signature and untrusted key", () => {
  const token = tokenFor();
  const parts = token.split(".");
  parts[2] = `${parts[2].slice(0, -2)}AA`;
  assert.throws(() => verifyGoogleIdToken(parts.join("."), verifyOptions), /signature/);
  const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  assert.throws(() => verifyGoogleIdToken(tokenFor(payload, undefined, otherKey), verifyOptions), /signature/);
});

test("rejects wrong issuer, audience, nonce, expiry, and missing subject", () => {
  for (const [change, error] of [
    [{ iss: "https://evil.example" }, /issuer/],
    [{ aud: "other-client" }, /audience/],
    [{ azp: "other-client" }, /audience/],
    [{ nonce: "other-session" }, /nonce/],
    [{ exp: nowSeconds }, /time window/],
    [{ iat: nowSeconds + 61 }, /time window/],
    [{ sub: "" }, /subject/],
  ]) {
    assert.throws(() => verifyGoogleIdToken(tokenFor({ ...payload, ...change }), verifyOptions), error);
  }
});

test("rejects duplicate and escaped duplicate claim names", () => {
  assert.throws(() => parseUniqueJson('{"sub":"a","sub":"b"}'), /Duplicate/);
  assert.throws(() => parseUniqueJson('{"sub":"a","\\u0073ub":"b"}'), /Duplicate/);
  assert.throws(
    () => verifyGoogleIdToken(tokenFor(`${JSON.stringify(payload).slice(0, -1)},"aud":"other-client"}`), verifyOptions),
    /Duplicate/,
  );
});

test("rejects ambiguous key IDs, unsupported algorithms, and noncanonical encoding", () => {
  assert.throws(() => verifyGoogleIdToken(tokenFor(payload, { alg: "none", kid: "test-key" }), verifyOptions), /header/);
  assert.throws(() => verifyGoogleIdToken(tokenFor(), { ...verifyOptions, jwks: { keys: [jwk, jwk] } }), /ambiguous/);
  assert.throws(() => verifyGoogleIdToken(tokenFor(), { ...verifyOptions, jwks: { keys: [] } }), /missing/);
  const parts = tokenFor().split(".");
  parts[0] += "=";
  assert.throws(() => verifyGoogleIdToken(parts.join("."), verifyOptions), /encoding/);
});
