// Offline recheck of the genuine Slack login saved by check-slack-login.mjs:
// token checks as of issue, circuit input, witness and a verified Groth16
// proof. The session key is random with no private half, so the proof cannot
// authorize a wallet. Adds sanitized results to the token profile record.
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import * as snarkjs from "../upstream/snarkjs-algorand/node_modules/snarkjs/main.js";
import witnessBuilder from "../fixtures/slack/slack_jwt_js/witness_calculator.js";
import { fetchJwks, parseUniqueJson } from "../src/phase3/id-token.mjs";
import { oidcCircuitInput } from "../src/phase3/circuit-input.mjs";
import { PROVIDERS } from "../src/phase3/oidc-providers.mjs";

const root = new URL("../", import.meta.url).pathname;
const audience = process.env.SLACK_CLIENT_ID;
if (!audience) throw new Error("Set SLACK_CLIENT_ID in the local .env");
const saved = JSON.parse(readFileSync(`${root}.local/slack/genuine-login.json`, "utf8"));
const bytes = (v) => Buffer.from(v, "base64url");
const { iat } = parseUniqueJson(Buffer.from(saved.token.split(".")[1], "base64url").toString("utf8"));
const input = oidcCircuitInput({
  provider: PROVIDERS.slack, token: saved.token, jwks: await fetchJwks(PROVIDERS.slack), audience, nonce: saved.nonce,
  genesisHash: bytes(saved.genesisHash), sessionPublicKey: bytes(saved.sessionPublicKey), randomness: bytes(saved.randomness),
  salt: bytes(saved.salt), expiresAt: saved.expiresAt, nowSeconds: iat + 1,
});
const wtns = `${root}.local/slack/genuine.wtns`;
let peakRssBytes = process.memoryUsage().rss;
const monitor = setInterval(() => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); }, 500);
try {
  const started = performance.now();
  const calculator = await witnessBuilder(readFileSync(`${root}fixtures/slack/slack_jwt_js/slack_jwt.wasm`));
  writeFileSync(wtns, Buffer.from(await calculator.calculateWTNSBin(input, true)), { mode: 0o600 });
  const witnessMs = Math.round(performance.now() - started);
  const proofStarted = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.prove(`${root}fixtures/slack/slack_jwt.zkey`, wtns, undefined, { singleThread: true });
  const proveMs = Math.round(performance.now() - proofStarted);
  const vk = JSON.parse(readFileSync(`${root}fixtures/slack/verification_key.json`, "utf8"));
  const expected = [...input.identity, ...input.keyHash, ...input.audienceHash, ...input.sessionKey, ...input.genesisHash, input.sessionExpiresAt, input.notBefore].map(String);
  const verified = JSON.stringify(expected) === JSON.stringify(publicSignals) && await snarkjs.groth16.verify(vk, publicSignals, proof);
  const recordPath = `${root}benchmarks/slack-token-profile.json`;
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
