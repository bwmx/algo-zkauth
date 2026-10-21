// Development fixtures only: a synthetic token shaped like the provider's
// (packages/protocol/src/synthetic-token.mjs) through its complete circuit, bound to
// LocalNet. No provider credential is touched.
// Usage: node tests/localnet/prepare-provider-wallet-proof.mjs <provider>
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { AlgorandClient, microAlgos } from "../../upstream/snarkjs-algorand/node_modules/@algorandfoundation/algokit-utils/index.mjs";
import * as snarkjs from "../../upstream/snarkjs-algorand/node_modules/snarkjs/main.js";
import { oidcCircuitInput } from "../../packages/protocol/src/circuit-input.mjs";
import { DEFAULT_PROVIDER, providerById } from "../../packages/protocol/src/oidc-providers.mjs";
import { sessionNonce } from "../../packages/protocol/src/session-nonce.mjs";
import { syntheticToken } from "../../packages/protocol/src/synthetic-token.mjs";

const root = new URL("../../", import.meta.url).pathname;
const provider = providerById(process.argv[2]);
// The default provider's LocalNet wallets are the Phase 4 suite (run-wallet-localnet.sh).
if (provider.id === DEFAULT_PROVIDER) throw new Error(`Usage: prepare-provider-wallet-proof.mjs <provider other than ${DEFAULT_PROVIDER}>`);
const { label } = provider;
const { directory, name } = provider.circuit;
const { default: witnessBuilder } = await import(`${root}${directory}/${name}_js/witness_calculator.js`);
const dir = `${root}${provider.local}`;
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
const algorand = AlgorandClient.defaultLocalNet();
const params = await algorand.client.algod.getTransactionParams().do();
if (!/^(dockernet-v1|devnet(?:-|$))/.test(params.genesisID)) throw new Error(`${label} wallet proofs require LocalNet`);
const genesisHash = Buffer.from(params.genesisHash);
// A fresh block makes the synthetic issue time current on an idle LocalNet.
// A long-running LocalNet marks its default accounts offline when their
// participation keys expire; dev mode still produces blocks.
const payer = await algorand.account.fromKmd("unencrypted-default-wallet", (a) => a.amount > 1_000_000_000);
await algorand.send.payment({ sender: payer, receiver: payer, amount: microAlgos(0), note: `${provider.id}-proof-clock-${Date.now()}` });
const status = await algorand.client.algod.status().do();
const issuedAt = Number((await algorand.client.algod.block(status.lastRound).do()).block.header.timestamp);

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const kid = `${provider.id}-localnet`;
const jwks = { keys: [{ ...rsa.publicKey.export({ format: "jwk" }), kid, alg: "RS256" }] };
const audience = "synthetic-localnet-client";
const session = generateKeyPairSync("ed25519");
const context = {
  genesisHash,
  sessionPublicKey: Buffer.from(session.publicKey.export({ format: "jwk" }).x, "base64url"),
  randomness: randomBytes(32), salt: randomBytes(32), expiresAt: issuedAt + 600,
};
const nonce = sessionNonce(context);
const token = syntheticToken(provider, { privateKey: rsa.privateKey, kid, audience, subject: "U0SYNTHETIC1", nonce, issuedAt });
const input = oidcCircuitInput({ provider, token, jwks, audience, nonce, ...context, nowSeconds: issuedAt + 1 });

const started = performance.now();
const calculator = await witnessBuilder(readFileSync(`${root}${directory}/${name}_js/${name}.wasm`));
writeFileSync(`${dir}/localnet.wtns`, Buffer.from(await calculator.calculateWTNSBin(input, true)), { mode: 0o600 });
const witnessMs = Math.round(performance.now() - started);
console.log(`${label} identity: full-circuit witness ready; generating Groth16 proof.`);
let peakRssBytes = process.memoryUsage().rss;
const monitor = setInterval(() => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); }, 500);
try {
  const proofStarted = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.prove(`${root}${directory}/${name}.zkey`, `${dir}/localnet.wtns`, undefined, { singleThread: true });
  const proveMs = Math.round(performance.now() - proofStarted);
  const vk = JSON.parse(readFileSync(`${root}${directory}/verification_key.json`, "utf8"));
  const expected = [...input.identity, ...input.keyHash, ...input.audienceHash, ...input.sessionKey, ...input.genesisHash, input.sessionExpiresAt, input.notBefore].map(String);
  if (JSON.stringify(expected) !== JSON.stringify(publicSignals) || !(await snarkjs.groth16.verify(vk, publicSignals, proof))) throw new Error("Development proof verification failed");
  writeFileSync(`${dir}/localnet-session.json`, JSON.stringify({ proof, signals: publicSignals, privateKey: session.privateKey.export({ format: "jwk" }), genesisHash: genesisHash.toString("base64url") }), { mode: 0o600 });
  const { iat, exp } = JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
  writeFileSync(`${root}benchmarks/${provider.records.localnetProofs}`, JSON.stringify({
    recordedAt: new Date().toISOString(), [`genuine${label}Tokens`]: false, circuit: `full ${label} JWT / 12 signals`,
    tokenLifetimeSeconds: exp - iat, sessionSecondsFromIssue: 600, witnessMs, proveMs, peakRssBytes, verified: true,
    nodeVersion: process.version, platform: process.platform, architecture: process.arch,
  }, null, 2) + "\n");
  console.log(`${label} identity: development proof verified in ${(proveMs / 1000).toFixed(1)} s.`);
} finally {
  clearInterval(monitor);
  await globalThis.curve_bn128?.terminate();
}
