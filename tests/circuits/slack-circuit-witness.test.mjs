import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, randomBytes } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import witnessBuilder from "../fixtures/slack/slack_jwt_js/witness_calculator.js";
import { oidcCircuitInput } from "../src/phase3/circuit-input.mjs";
import { identityCommitment } from "../src/phase3/identity-commitment.mjs";
import { PROVIDERS } from "../src/phase3/oidc-providers.mjs";
import { sessionNonce } from "../src/phase3/session-nonce.mjs";

// Synthetic Slack-shaped tokens: Slack serializes JSON with escaped "/".
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwks = {
  keys: [{ ...publicKey.export({ format: "jwk" }), kid: "synthetic-slack", alg: "RS256" }],
};
const issuedAt = Number(
  process.env.SYNTHETIC_IAT ?? Math.floor(Date.now() / 1000),
);
const context = {
  genesisHash: process.env.SYNTHETIC_GENESIS_HASH
    ? Buffer.from(process.env.SYNTHETIC_GENESIS_HASH, "base64url")
    : randomBytes(32),
  sessionPublicKey: randomBytes(32),
  randomness: randomBytes(32),
  salt: randomBytes(32),
  // Ten minutes from issue, after the five-minute Slack token expiry.
  expiresAt: issuedAt + 600,
};
const nonce = sessionNonce(context);
const audience = "1234567890.9876543210";
const team = "T0123ABC456";
const user = "U0123ABCDEF";
const header = { typ: "JWT", alg: "RS256", kid: "synthetic-slack" };
const claims = {
  iss: "https://slack.com",
  sub: user,
  aud: audience,
  exp: issuedAt + 300,
  iat: issuedAt,
  auth_time: issuedAt,
  nonce,
  at_hash: "tUbyWGBHe0V32FJEupkgVQ",
  "https://slack.com/team_id": team,
  "https://slack.com/user_id": user,
  email: "synthetic@example.invalid",
  email_verified: true,
  date_email_verified: issuedAt - 1000,
  locale: "en-US",
};
const slackJson = (value) =>
  typeof value === "string" ? value : JSON.stringify(value).replaceAll("/", "\\/");
const tokenFor = (h, p) => {
  const message = [h, p]
    .map((v) => Buffer.from(slackJson(v)).toString("base64url"))
    .join(".");
  return `${message}.${sign("RSA-SHA256", Buffer.from(message), privateKey).toString("base64url")}`;
};
const inputFor = (token, overrides = {}) =>
  oidcCircuitInput({
    provider: PROVIDERS.slack,
    token,
    jwks,
    audience,
    nonce,
    ...context,
    nowSeconds: issuedAt + 1,
    ...overrides,
  });
const input = inputFor(tokenFor(header, claims));
const calculator = await witnessBuilder(
  readFileSync(
    new URL("../fixtures/slack/slack_jwt_js/slack_jwt.wasm", import.meta.url),
  ),
);

// Field hints read straight from signed JSON text, so adversarial tokens that
// preflight rejects still reach the circuit.
function hints(text, capacity) {
  const pairs = [...text.matchAll(/"((?:[^"\\]|\\.)*)":("((?:[^"\\]|\\.)*)"|[^,}]*)/g)];
  const pad = (values) => [...values, ...Array(capacity - values.length).fill(0)];
  return {
    count: pairs.length,
    keys: pad(pairs.map((m) => m[1].length)),
    values: pad(pairs.map((m) => (m[3] ?? m[2]).length)),
  };
}

// Deliberately bypass off-chain preflight for adversarial circuit tests. The
// circuit receives newly signed malformed claims under the synthetic test key.
function replaceSignedToken(target, headerValue, payloadValue) {
  const [h, p, s] = tokenFor(headerValue, payloadValue).split(".");
  const message = Buffer.from(`${h}.${p}`, "ascii");
  target.message = [...message, ...Array(1024 - message.length).fill(0)];
  target.messageLength = message.length;
  target.headerLength = h.length;
  let signature = BigInt(`0x${Buffer.from(s, "base64url").toString("hex")}`);
  target.signature = Array.from({ length: 17 }, () => {
    const limb = (signature & ((1n << 121n) - 1n)).toString();
    signature >>= 121n;
    return limb;
  });
  const headerHints = hints(slackJson(headerValue), 3);
  const payloadHints = hints(slackJson(payloadValue), 14);
  target.headerFieldCount = headerHints.count;
  target.headerKeyLengths = headerHints.keys;
  target.headerValueLengths = headerHints.values;
  target.payloadFieldCount = payloadHints.count;
  target.payloadKeyLengths = payloadHints.keys;
  target.payloadValueLengths = payloadHints.values;
  return target;
}
// Same field count as the full profile, with one claim outside it.
const { locale: _locale, ...withoutLocale } = claims;
const withPicture = { ...withoutLocale, picture: "https://example.invalid/a" };
const lengthPrefixed = (text) => {
  const data = Buffer.from(text, "ascii");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(data.length);
  return Buffer.concat([length, data]);
};
// Point the private preimage and public identity at another subject string.
function withSubject(target, subject) {
  const preimage = Buffer.concat([
    Buffer.from("algorand-zklogin-identity-v1\0", "ascii"),
    lengthPrefixed("https://slack.com"),
    lengthPrefixed(audience),
    lengthPrefixed(subject),
    context.salt,
  ]);
  const digest = createHash("sha256").update(preimage).digest();
  target.identityPreimage = [...preimage, ...Array(input.identityPreimage.length - preimage.length).fill(0)];
  target.identity = [digest.subarray(0, 16), digest.subarray(16)].map((v) => BigInt(`0x${v.toString("hex")}`).toString());
  return target;
}
const expectedSignals = (value) =>
  [
    ...value.identity,
    ...value.keyHash,
    ...value.audienceHash,
    ...value.sessionKey,
    ...value.genesisHash,
    value.sessionExpiresAt,
    value.notBefore,
  ].map(BigInt);

test("full Slack circuit binds the escaped Slack token to the team/sub identity", async () => {
  const commitment = identityCommitment({
    issuer: "https://slack.com",
    audience,
    subject: `${team}/${user}`,
    salt: context.salt,
  });
  assert.deepEqual(input.identity, [commitment.high128, commitment.low128].map(String));
  assert.equal(input.notBefore, issuedAt - 60);
  const witness = await calculator.calculateWitness(input, true);
  assert.deepEqual(witness.slice(1, 13), expectedSignals(input));
  const dir = new URL("../.local/slack/", import.meta.url);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(new URL("synthetic-input.json", dir), JSON.stringify(input), {
    mode: 0o600,
  });
  writeFileSync(
    new URL("synthetic.wtns", dir),
    Buffer.from(await calculator.calculateWTNSBin(input, true)),
    { mode: 0o600 },
  );
});

test("circuit accepts the minimal openid claim set without a typ header", async () => {
  const minimal = Object.fromEntries(
    Object.entries(claims).filter(([key]) =>
      !["email", "email_verified", "date_email_verified", "locale"].includes(key),
    ),
  );
  const value = inputFor(tokenFor({ alg: "RS256", kid: "synthetic-slack" }, minimal));
  assert.equal(value.payloadFieldCount, 10);
  const witness = await calculator.calculateWitness(value, true);
  assert.deepEqual(witness.slice(1, 13), expectedSignals(value));
});

test("preflight rejects tokens outside the Slack profile and window", () => {
  const unescaped = (() => {
    const message = [header, claims]
      .map((v) => Buffer.from(JSON.stringify(v)).toString("base64url"))
      .join(".");
    return `${message}.${sign("RSA-SHA256", Buffer.from(message), privateKey).toString("base64url")}`;
  })();
  assert.throws(() => inputFor(unescaped), /compact canonical/);
  assert.throws(
    () => inputFor(tokenFor(header, { ...claims, iss: "https://accounts.google.com" })),
    /Invalid Slack issuer/,
  );
  const { ["https://slack.com/team_id"]: _, ...withoutTeam } = claims;
  assert.throws(() => inputFor(tokenFor(header, withoutTeam)), /team/);
  assert.throws(
    () => inputFor(tokenFor(header, { ...claims, "https://slack.com/team_id": "T1/U2" })),
    /team/,
  );
  assert.throws(
    () => inputFor(tokenFor(header, withPicture)),
    /outside the supported circuit profile/,
  );
  const late = { ...context, expiresAt: issuedAt + 601 };
  const lateNonce = sessionNonce(late);
  assert.throws(
    () => inputFor(tokenFor(header, { ...claims, nonce: lateNonce }), { ...late, nonce: lateNonce }),
    /outside the signed token window/,
  );
});

test("circuit rejects correctly signed wrong issuer spelling, team and session window", async () => {
  const subject = `${team}/${user}`;
  // Control: re-signing unchanged claims through the same helpers is accepted.
  const control = withSubject(replaceSignedToken(structuredClone(input), header, claims), subject);
  assert.deepEqual((await calculator.calculateWitness(control, true)).slice(1, 13), expectedSignals(input));
  const cases = [
    // The Slack circuit accepts only Slack's escaped issuer spelling.
    [header, { ...claims, iss: "https://accounts.google.com" }, subject],
    [header, slackJson(claims).replace("https:\\/\\/slack.com", "https://slack.com"), subject],
    [header, slackJson(claims).replace("https:\\/\\/slack.com", "https:\\u002f\\u002fslack.com"), subject],
    // Team IDs must be present and free of "/", with the identity consistent.
    [header, Object.fromEntries(Object.entries(claims).filter(([key]) => key !== "https://slack.com/team_id")), subject],
    [header, slackJson(claims).replace(`"${team}"`, '"T1/U2"'), `T1/U2/${user}`],
    // Unsupported claims and escapes in kind-0 strings.
    [header, withPicture, subject],
    [header, { ...claims, sub: "U/1" }, `${team}/U/1`],
    // typ, when present, must be JWT.
    [{ ...header, typ: "JWS" }, claims, subject],
  ];
  for (const [h, p, id] of cases) {
    const tampered = withSubject(replaceSignedToken(structuredClone(input), h, p), id);
    await assert.rejects(calculator.calculateWitness(tampered, true), undefined, slackJson(p).slice(0, 80));
  }
  // Issued one second earlier, the same nonce-bound expiry exceeds iat + 600.
  const early = replaceSignedToken(structuredClone(input), header, { ...claims, iat: issuedAt - 1, auth_time: issuedAt - 1 });
  early.notBefore = issuedAt - 61;
  await assert.rejects(calculator.calculateWitness(early, true));
});

test("circuit rejects identities that drop or reorder the team", async () => {
  // The unchanged subject is accepted, so rejections below come from the order.
  const same = withSubject(structuredClone(input), `${team}/${user}`);
  assert.deepEqual(same.identity, input.identity);
  for (const subject of [user, `${user}/${team}`, `${team}:${user}`]) {
    const tampered = withSubject(structuredClone(input), subject);
    await assert.rejects(calculator.calculateWitness(tampered, true), undefined, subject);
  }
});
