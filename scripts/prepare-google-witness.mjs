import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fetchGoogleJwks } from "../src/phase3/google-id-token.mjs";
import { googleCircuitInput } from "../src/phase3/google-circuit-input.mjs";
import { localWalletSalt } from "../src/phase3/local-salt.mjs";
import witnessBuilder from "../fixtures/phase3/google_jwt_js/witness_calculator.js";

const required = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_EXPECTED_NONCE",
  "GOOGLE_ID_TOKEN",
  "ZKLOGIN_SESSION_GENESIS_HASH",
  "ZKLOGIN_SESSION_PUBLIC_KEY",
  "ZKLOGIN_SESSION_RANDOMNESS",
  "ZKLOGIN_SESSION_EXPIRES_AT",
];
if (required.some((key) => !process.env[key]))
  throw new Error(
    "A fresh capture with the complete session context is required; reload the local login page and sign in",
  );
if (
  Number(process.env.ZKLOGIN_SESSION_EXPIRES_AT) <=
  Math.floor(Date.now() / 1000)
)
  throw new Error("The captured session expired; a fresh login is required");
const decode = (key) => {
  const text = process.env[key];
  const value = Buffer.from(text, "base64url");
  if (value.length !== 32 || value.toString("base64url") !== text)
    throw new Error("Invalid local session context");
  return value;
};
const local = new URL("../.local/", import.meta.url);
const dir = new URL("phase3/", local);
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(local, 0o700);
chmodSync(dir, 0o700);
const salt = localWalletSalt();
const token = process.env.GOOGLE_ID_TOKEN;
const input = googleCircuitInput({
  token,
  jwks: await fetchGoogleJwks(),
  audience: process.env.GOOGLE_CLIENT_ID,
  nonce: process.env.GOOGLE_EXPECTED_NONCE,
  genesisHash: decode("ZKLOGIN_SESSION_GENESIS_HASH"),
  sessionPublicKey: decode("ZKLOGIN_SESSION_PUBLIC_KEY"),
  randomness: decode("ZKLOGIN_SESSION_RANDOMNESS"),
  expiresAt: Number(process.env.ZKLOGIN_SESSION_EXPIRES_AT),
  salt,
});
const wasm = readFileSync(
  new URL("../fixtures/phase3/google_jwt_js/google_jwt.wasm", import.meta.url),
);
const calculator = await witnessBuilder(wasm);
const started = performance.now();
const witness = await calculator.calculateWTNSBin(input, true);
writeFileSync(new URL("google-input.json", dir), JSON.stringify(input), {
  mode: 0o600,
});
writeFileSync(new URL("google.wtns", dir), Buffer.from(witness), {
  mode: 0o600,
});
const record = {
  recordedAt: new Date().toISOString(),
  genuineGoogleToken: true,
  signaturePreflightPassed: true,
  nonceBoundInWitness: true,
  publicSignals: 12,
  messageBytes: input.messageLength,
  witnessMs: Math.round(performance.now() - started),
  witnessBytes: witness.byteLength,
  rssBytes: process.memoryUsage().rss,
  circuitWasmSha256: createHash("sha256").update(wasm).digest("hex"),
  groth16ProofGenerated: false,
  acceptedOnChain: false,
};
writeFileSync(
  new URL("../benchmarks/phase3-witness.google.json", import.meta.url),
  JSON.stringify(record, null, 2) + "\n",
);
console.log(JSON.stringify(record, null, 2));
