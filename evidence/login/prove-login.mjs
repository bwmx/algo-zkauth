// Offline recheck of the genuine login saved by check-login.mjs: token checks
// as of issue, circuit input, witness and a verified Groth16 proof. The session
// key is random with no private half, so the proof cannot authorize a wallet.
// Adds sanitized results to the provider's token profile record.
// Usage: node --env-file=.env scripts/prove-login.mjs <provider>
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import * as snarkjs from "../upstream/snarkjs-algorand/node_modules/snarkjs/main.js";
import { fetchJwks, parseUniqueJson } from "../src/phase3/id-token.mjs";
import { oidcCircuitInput } from "../src/phase3/circuit-input.mjs";
import { providerById, providerEnv, providerEnvName } from "../src/phase3/oidc-providers.mjs";

const root = new URL("../", import.meta.url).pathname;
const provider = providerById(process.argv[2]);
const { directory, name } = provider.circuit;
const audience = providerEnv(provider, "CLIENT_ID");
if (!audience) throw new Error(`Set ${providerEnvName(provider, "CLIENT_ID")} in the local .env`);
const { default: witnessBuilder } = await import(`${root}${directory}/${name}_js/witness_calculator.js`);
const saved = JSON.parse(readFileSync(`${root}${provider.local}/genuine-login.json`, "utf8"));
const bytes = (v) => Buffer.from(v, "base64url");
const { iat } = parseUniqueJson(Buffer.from(saved.token.split(".")[1], "base64url").toString("utf8"));
const input = oidcCircuitInput({
  provider, token: saved.token, jwks: await fetchJwks(provider), audience, nonce: saved.nonce,
  genesisHash: bytes(saved.genesisHash), sessionPublicKey: bytes(saved.sessionPublicKey), randomness: bytes(saved.randomness),
  salt: bytes(saved.salt), expiresAt: saved.expiresAt, nowSeconds: iat + 1,
});
const wtns = `${root}${provider.local}/genuine.wtns`;
let peakRssBytes = process.memoryUsage().rss;
const monitor = setInterval(() => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); }, 500);
try {
  const started = performance.now();
  const calculator = await witnessBuilder(readFileSync(`${root}${directory}/${name}_js/${name}.wasm`));
  writeFileSync(wtns, Buffer.from(await calculator.calculateWTNSBin(input, true)), { mode: 0o600 });
  const witnessMs = Math.round(performance.now() - started);
  const proofStarted = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.prove(`${root}${directory}/${name}.zkey`, wtns, undefined, { singleThread: true });
  const proveMs = Math.round(performance.now() - proofStarted);
  const vk = JSON.parse(readFileSync(`${root}${directory}/verification_key.json`, "utf8"));
  const expected = [...input.identity, ...input.keyHash, ...input.audienceHash, ...input.sessionKey, ...input.genesisHash, input.sessionExpiresAt, input.notBefore].map(String);
  const verified = JSON.stringify(expected) === JSON.stringify(publicSignals) && await snarkjs.groth16.verify(vk, publicSignals, proof);
  const recordPath = `${root}benchmarks/${provider.records.tokenProfile}`;
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  record.offlineProof = { recordedAt: new Date().toISOString(), verified, publicSignals: publicSignals.length, witnessMs, proveMs, peakRssBytes,
    nodeVersion: process.version, platform: process.platform, architecture: process.arch, sessionKeyHasPrivateHalf: false };
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n");
  console.log(JSON.stringify(record.offlineProof, null, 2));
  if (!verified) process.exitCode = 1;
} finally {
  clearInterval(monitor); rmSync(wtns, { force: true });
  await globalThis.curve_bn128?.terminate();
}
