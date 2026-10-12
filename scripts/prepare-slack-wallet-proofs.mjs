// Development fixtures only: a synthetic Slack-shaped RSA JWT through the
// complete Slack circuit, bound to LocalNet. No Slack credential is touched.
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { AlgorandClient, microAlgos } from "../upstream/snarkjs-algorand/node_modules/@algorandfoundation/algokit-utils/index.mjs";
import * as snarkjs from "../upstream/snarkjs-algorand/node_modules/snarkjs/main.js";
import witnessBuilder from "../fixtures/slack/slack_jwt_js/witness_calculator.js";
import { oidcCircuitInput } from "../src/phase3/circuit-input.mjs";
import { PROVIDERS } from "../src/phase3/oidc-providers.mjs";
import { sessionNonce } from "../src/phase3/session-nonce.mjs";

const root = new URL("../", import.meta.url).pathname;
const dir = `${root}.local/slack`;
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
const algorand = AlgorandClient.defaultLocalNet();
const params = await algorand.client.algod.getTransactionParams().do();
if (!/^(dockernet-v1|devnet(?:-|$))/.test(params.genesisID)) throw new Error("Slack wallet proofs require LocalNet");
const genesisHash = Buffer.from(params.genesisHash);
// A fresh block makes the synthetic issue time current on an idle LocalNet.
// A long-running LocalNet marks its default accounts offline when their
// participation keys expire; dev mode still produces blocks.
const payer = await algorand.account.fromKmd("unencrypted-default-wallet", (a) => a.amount > 1_000_000_000);
await algorand.send.payment({ sender: payer, receiver: payer, amount: microAlgos(0), note: `slack-proof-clock-${Date.now()}` });
const status = await algorand.client.algod.status().do();
const issuedAt = Number((await algorand.client.algod.block(status.lastRound).do()).block.header.timestamp);

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = { keys: [{ ...rsa.publicKey.export({ format: "jwk" }), kid: "slack-localnet", alg: "RS256" }] };
const audience = "1234567890.9876543210";
const session = generateKeyPairSync("ed25519");
const context = {
  genesisHash,
  sessionPublicKey: Buffer.from(session.publicKey.export({ format: "jwk" }).x, "base64url"),
  randomness: randomBytes(32), salt: randomBytes(32), expiresAt: issuedAt + 600,
};
const nonce = sessionNonce(context);
// Slack-shaped: five-minute token, escaped slashes, openid claims only.
const claims = {
  iss: "https://slack.com", sub: "U0123ABCDEF", aud: audience, exp: issuedAt + 300, iat: issuedAt,
  auth_time: issuedAt, nonce, at_hash: "tUbyWGBHe0V32FJEupkgVQ",
  "https://slack.com/team_id": "T0123ABC456", "https://slack.com/user_id": "U0123ABCDEF",
};
const message = [{ typ: "JWT", alg: "RS256", kid: "slack-localnet" }, claims]
  .map((v) => Buffer.from(JSON.stringify(v).replaceAll("/", "\\/")).toString("base64url")).join(".");
const token = `${message}.${sign("RSA-SHA256", Buffer.from(message), rsa.privateKey).toString("base64url")}`;
const input = oidcCircuitInput({ provider: PROVIDERS.slack, token, jwks, audience, nonce, ...context, nowSeconds: issuedAt + 1 });

const started = performance.now();
const calculator = await witnessBuilder(readFileSync(`${root}fixtures/slack/slack_jwt_js/slack_jwt.wasm`));
writeFileSync(`${dir}/localnet.wtns`, Buffer.from(await calculator.calculateWTNSBin(input, true)), { mode: 0o600 });
const witnessMs = Math.round(performance.now() - started);
console.log("Slack identity: full-circuit witness ready; generating Groth16 proof.");
let peakRssBytes = process.memoryUsage().rss;
const monitor = setInterval(() => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); }, 500);
try {
  const proofStarted = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.prove(`${root}fixtures/slack/slack_jwt.zkey`, `${dir}/localnet.wtns`, undefined, { singleThread: true });
  const proveMs = Math.round(performance.now() - proofStarted);
  const vk = JSON.parse(readFileSync(`${root}fixtures/slack/verification_key.json`, "utf8"));
  const expected = [...input.identity, ...input.keyHash, ...input.audienceHash, ...input.sessionKey, ...input.genesisHash, input.sessionExpiresAt, input.notBefore].map(String);
  if (JSON.stringify(expected) !== JSON.stringify(publicSignals) || !(await snarkjs.groth16.verify(vk, publicSignals, proof))) throw new Error("Development proof verification failed");
  writeFileSync(`${dir}/localnet-session.json`, JSON.stringify({ proof, signals: publicSignals, privateKey: session.privateKey.export({ format: "jwk" }), genesisHash: genesisHash.toString("base64url") }), { mode: 0o600 });
  writeFileSync(`${root}benchmarks/slack-proofs.localnet.json`, JSON.stringify({
    recordedAt: new Date().toISOString(), genuineSlackTokens: false, circuit: "full Slack JWT / 12 signals",
    tokenLifetimeSeconds: 300, sessionSecondsFromIssue: 600, witnessMs, proveMs, peakRssBytes, verified: true,
    nodeVersion: process.version, platform: process.platform, architecture: process.arch,
  }, null, 2) + "\n");
  console.log(`Slack identity: development proof verified in ${(proveMs / 1000).toFixed(1)} s.`);
} finally {
  clearInterval(monitor);
  await globalThis.curve_bn128?.terminate();
}
