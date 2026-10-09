import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, randomBytes } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import witnessBuilder from "../fixtures/phase3/google_jwt_js/witness_calculator.js";
import { googleCircuitInput } from "../src/phase3/google-circuit-input.mjs";
import { sessionNonce } from "../src/phase3/session-nonce.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwk = publicKey.export({ format: "jwk" });
const jwks = {
  keys: [{ ...jwk, kid: "synthetic-circuit-test", alg: "RS256", use: "sig" }],
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
  expiresAt: issuedAt + 600,
};
const nonce = sessionNonce(context);
const audience = "synthetic-circuit-client.apps.googleusercontent.com";
const header = { alg: "RS256", kid: "synthetic-circuit-test", typ: "JWT" };
const claims = {
  iss: "https://accounts.google.com",
  azp: audience,
  aud: audience,
  sub: "123456789012345678901",
  email: "synthetic@example.invalid",
  email_verified: true,
  nonce,
  nbf: issuedAt,
  name: "Synthetic Test",
  picture: "https://example.invalid/avatar",
  given_name: "Synthetic",
  family_name: "Test",
  iat: issuedAt,
  exp: issuedAt + 3600,
  jti: "synthetic-jwt-id",
};
const tokenFor = (h, p) => {
  const message = [h, p]
    .map((v) =>
      Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString(
        "base64url",
      ),
    )
    .join(".");
  return `${message}.${sign("RSA-SHA256", Buffer.from(message), privateKey).toString("base64url")}`;
};
const token = tokenFor(header, claims);
const input = googleCircuitInput({
  token,
  jwks,
  audience,
  nonce,
  ...context,
  nowSeconds: issuedAt + 1,
});
const calculator = await witnessBuilder(
  readFileSync(
    new URL(
      "../fixtures/phase3/google_jwt_js/google_jwt.wasm",
      import.meta.url,
    ),
  ),
);

// Deliberately bypass off-chain preflight for adversarial circuit tests. The
// circuit receives newly signed malformed claims under the synthetic test key.
function replaceSignedToken(
  target,
  headerText,
  payloadText,
  keyHints,
  valueHints,
) {
  const replacement = tokenFor(headerText, payloadText).split(".");
  const message = Buffer.from(`${replacement[0]}.${replacement[1]}`, "ascii");
  target.message = [...message, ...Array(1024 - message.length).fill(0)];
  target.messageLength = message.length;
  target.headerLength = replacement[0].length;
  let signature = BigInt(
    `0x${Buffer.from(replacement[2], "base64url").toString("hex")}`,
  );
  target.signature = Array.from({ length: 17 }, () => {
    const limb = (signature & ((1n << 121n) - 1n)).toString();
    signature >>= 121n;
    return limb;
  });
  if (keyHints) {
    target.payloadFieldCount = keyHints.length;
    target.payloadKeyLengths = [
      ...keyHints,
      ...Array(18 - keyHints.length).fill(0),
    ];
    target.payloadValueLengths = [
      ...valueHints,
      ...Array(18 - valueHints.length).fill(0),
    ];
  }
  return target;
}

test("full Google circuit produces a witness with the exact 12 public signals", async () => {
  const start = performance.now();
  const witness = await calculator.calculateWitness(input, true);
  const expected = [
    ...input.identity,
    ...input.keyHash,
    ...input.audienceHash,
    ...input.sessionKey,
    ...input.genesisHash,
    input.sessionExpiresAt,
    input.notBefore,
  ].map(BigInt);
  assert.deepEqual(witness.slice(1, 13), expected);
  const dir = new URL("../.local/phase3/", import.meta.url);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(new URL("synthetic-input.json", dir), JSON.stringify(input), {
    mode: 0o600,
  });
  writeFileSync(
    new URL("synthetic.wtns", dir),
    Buffer.from(await calculator.calculateWTNSBin(input, true)),
    { mode: 0o600 },
  );
  writeFileSync(
    new URL("../benchmarks/phase3-witness.synthetic.json", import.meta.url),
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        synthetic: true,
        publicSignals: 12,
        witnessSignalCount: witness.length,
        firstWitnessMs: Math.round(performance.now() - start),
        rssBytes: process.memoryUsage().rss,
        groth16ProofGenerated: false,
      },
      null,
      2,
    ) + "\n",
  );
});

test("circuit rejects altered signature, binding, padding and oversized inputs", async () => {
  for (const mutate of [
    (i) => {
      i.signature[0] = (BigInt(i.signature[0]) + 1n).toString();
    },
    (i) => {
      i.sessionKey[0] = (BigInt(i.sessionKey[0]) + 1n).toString();
    },
    (i) => {
      i.genesisHash[1] = (BigInt(i.genesisHash[1]) + 1n).toString();
    },
    (i) => {
      i.identity[0] = (BigInt(i.identity[0]) + 1n).toString();
    },
    (i) => {
      i.salt[0] ^= 1;
    },
    (i) => {
      i.randomness[0] ^= 1;
    },
    (i) => {
      i.sessionExpiresAt++;
    },
    (i) => {
      i.notBefore++;
    },
    (i) => {
      i.message[i.messageLength] = 128;
    },
    (i) => {
      i.messageLength = 1016;
    },
    (i) => {
      i.headerLength = 129;
    },
    (i) => {
      i.payloadValueLengths[0] = 256;
    },
  ]) {
    const modified = structuredClone(input);
    mutate(modified);
    await assert.rejects(calculator.calculateWitness(modified, true));
  }
});

test("circuit rejects correctly signed wrong issuer, audience, nonce, and time policy", async () => {
  for (const [key, value] of [
    ["iss", "https://accounts.evilxx.com"],
    ["aud", audience.replace("synthetic", "malicious")],
    ["nonce", nonce.replace(/^./, nonce[0] === "A" ? "B" : "A")],
    ["iat", issuedAt + 601],
    ["exp", issuedAt + 100],
    ["nbf", issuedAt + 601],
  ]) {
    const modified = structuredClone(input);
    replaceSignedToken(modified, header, { ...claims, [key]: value });
    await assert.rejects(calculator.calculateWitness(modified, true));
  }
});

test("circuit rejects duplicate, escaped, nested and ambiguous numeric claim encodings", async () => {
  const text = JSON.stringify(claims);
  for (const payload of [
    text.replace('"iss":', '"i\\u0073s":'),
    text.replace(
      '"sub":"123456789012345678901"',
      '"sub":{"sub":"123456789012345678901"}',
    ),
    text.replace(`"iat":${issuedAt}`, `"iat":0${issuedAt}`),
    text.replace(`"iat":${issuedAt}`, `"iat":${issuedAt}e0`),
    text + " ",
  ]) {
    await assert.rejects(
      calculator.calculateWitness(
        replaceSignedToken(structuredClone(input), header, payload),
        true,
      ),
    );
  }
  const duplicate = `${text.slice(0, -1)},"iss":"https://accounts.google.com"}`;
  const keys = Object.keys(claims)
    .map((k) => k.length)
    .concat(3);
  const values = Object.values(claims)
    .map((v) => (typeof v === "string" ? v.length : String(v).length))
    .concat(27);
  await assert.rejects(
    calculator.calculateWitness(
      replaceSignedToken(
        structuredClone(input),
        header,
        duplicate,
        keys,
        values,
      ),
      true,
    ),
  );
});

test("circuit accepts supported issuer canonicalization and optional-claim variants", async () => {
  for (const changed of [
    { ...claims, iss: "accounts.google.com" },
    { ...claims, email_verified: false },
  ]) {
    const variant = googleCircuitInput({
      token: tokenFor(header, changed),
      jwks,
      audience,
      nonce,
      ...context,
      nowSeconds: issuedAt + 1,
    });
    const witness = await calculator.calculateWitness(variant, true);
    assert.deepEqual(witness.slice(1, 3), input.identity.map(BigInt));
  }
  const { azp, nbf, ...withoutOptional } = claims;
  const variant = googleCircuitInput({
    token: tokenFor(header, withoutOptional),
    jwks,
    audience,
    nonce,
    ...context,
    nowSeconds: issuedAt + 1,
  });
  await calculator.calculateWitness(variant, true);
});
