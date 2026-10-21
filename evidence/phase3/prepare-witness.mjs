// Full-circuit witness from a captured genuine login: <PREFIX>_CLIENT_ID,
// <PREFIX>_EXPECTED_NONCE, <PREFIX>_ID_TOKEN and the ZKLOGIN_SESSION_* context,
// as the local Google capture page (scripts/phase3-login-server.mjs) writes them.
// Usage: node --env-file=.env scripts/prepare-witness.mjs [provider]
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fetchJwks } from "../src/phase3/id-token.mjs";
import { oidcCircuitInput } from "../src/phase3/circuit-input.mjs";
import { localWalletSalt } from "../src/phase3/local-salt.mjs";
import { DEFAULT_PROVIDER, providerById, providerEnv, providerEnvName } from "../src/phase3/oidc-providers.mjs";

const provider = providerById(process.argv[2] ?? DEFAULT_PROVIDER);
const { directory, name } = provider.circuit;
const { default: witnessBuilder } = await import(new URL(`../${directory}/${name}_js/witness_calculator.js`, import.meta.url));
const required = [
  ...["CLIENT_ID", "EXPECTED_NONCE", "ID_TOKEN"].map((key) => providerEnvName(provider, key)),
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
const dir = new URL(`../${provider.local}/`, import.meta.url);
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(local, 0o700);
chmodSync(dir, 0o700);
const salt = localWalletSalt();
const token = providerEnv(provider, "ID_TOKEN");
const input = oidcCircuitInput({
  provider,
  token,
  jwks: await fetchJwks(provider),
  audience: providerEnv(provider, "CLIENT_ID"),
  nonce: providerEnv(provider, "EXPECTED_NONCE"),
  genesisHash: decode("ZKLOGIN_SESSION_GENESIS_HASH"),
  sessionPublicKey: decode("ZKLOGIN_SESSION_PUBLIC_KEY"),
  randomness: decode("ZKLOGIN_SESSION_RANDOMNESS"),
  expiresAt: Number(process.env.ZKLOGIN_SESSION_EXPIRES_AT),
  salt,
});
const wasm = readFileSync(
  new URL(`../${directory}/${name}_js/${name}.wasm`, import.meta.url),
);
const calculator = await witnessBuilder(wasm);
const started = performance.now();
const witness = await calculator.calculateWTNSBin(input, true);
writeFileSync(new URL(`${provider.id}-input.json`, dir), JSON.stringify(input), {
  mode: 0o600,
});
writeFileSync(new URL(`${provider.id}.wtns`, dir), Buffer.from(witness), {
  mode: 0o600,
});
const record = {
  recordedAt: new Date().toISOString(),
  [`genuine${provider.label}Token`]: true,
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
  new URL(`../benchmarks/${provider.records.witness}`, import.meta.url),
  JSON.stringify(record, null, 2) + "\n",
);
console.log(JSON.stringify(record, null, 2));
